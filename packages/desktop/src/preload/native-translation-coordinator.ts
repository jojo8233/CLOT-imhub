import {
  bilingualTranslationTarget,
  normalizeTranslationLanguage,
  type NativeTranslationBatchInput,
  type NativeTranslationBatchResult,
  type TranslationProviderName,
  type TranslationResultMeta,
} from '@im-hub/shared'

const DEFAULT_MAX_CACHE_ENTRIES = 500
const MAX_BATCH_SIZE = 20
type SuccessfulBatchResult = Extract<
  NativeTranslationBatchResult,
  { requestedProvider: TranslationProviderName }
>

export interface NativeTranslationGatewayPort {
  detectLanguage(text: string, provider?: TranslationProviderName): Promise<string | undefined>
  translateBatch(
    input: NativeTranslationBatchInput,
  ): Promise<NativeTranslationBatchResult[] | undefined>
}

export interface NativeTranslationCoordinatorOptions {
  maxCacheEntries?: number
  resolveTargetLanguage?(sourceLang: string | undefined): string
}

export interface NativeTranslationTextSuccess extends TranslationResultMeta {
  status: 'translated'
  translated: string
}

export type NativeTranslationTextResult =
  | NativeTranslationTextSuccess
  | { status: 'failed' }

interface PendingText {
  key: string
  text: string
  provider: TranslationProviderName | undefined
  operation: Promise<NativeTranslationTextSuccess>
  resolve(result: NativeTranslationTextSuccess): void
  reject(error: Error): void
}

interface TranslationWorkItem {
  index: number
  text: string
  sourceLang: string | undefined
  targetLang: string
}

/**
 * 原生客户端共用的无界面翻译编排器。
 *
 * 平台继续负责消息 ID、原生状态和译文渲染；这里仅统一语言策略、窄代理调用、
 * 同文请求去重、缓存和失败清理，避免把 Telegram/Signal/WhatsApp 的 UI 假装成同一套。
 */
export class NativeTranslationCoordinator {
  private readonly cache = new Map<string, Promise<NativeTranslationTextSuccess>>()
  private readonly inFlight = new Map<string, Promise<NativeTranslationTextSuccess>>()
  private readonly maxCacheEntries: number
  private readonly resolveTargetLanguage: (sourceLang: string | undefined) => string

  constructor(
    private readonly gateway: NativeTranslationGatewayPort,
    options: NativeTranslationCoordinatorOptions = {},
  ) {
    const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
    if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries <= 0) {
      throw new Error('maxCacheEntries must be a positive safe integer')
    }
    if (maxCacheEntries > DEFAULT_MAX_CACHE_ENTRIES) {
      throw new Error('maxCacheEntries must not exceed 500')
    }
    this.maxCacheEntries = maxCacheEntries
    this.resolveTargetLanguage = options.resolveTargetLanguage ?? bilingualTranslationTarget
  }

  async translate(text: string, provider?: TranslationProviderName): Promise<string> {
    if (!text.trim()) throw new Error('translation text is blank')
    const result = (await this.translateMany([text], provider))[0]
    if (!result || result.status === 'failed') throw new Error('translation unavailable')
    return result.translated
  }

  async translateMany(
    texts: readonly string[],
    provider?: TranslationProviderName,
  ): Promise<NativeTranslationTextResult[]> {
    const pending: PendingText[] = []
    const operations = texts.map(text => {
      if (!text.trim()) return Promise.resolve<NativeTranslationTextResult>({ status: 'failed' })
      const key = this.translationKey(text, provider)
      const cached = provider === undefined ? undefined : this.cache.get(key)
      if (cached) {
        return cached.then(
          result => result,
          () => ({ status: 'failed' }) as const,
        )
      }
      const inFlight = this.inFlight.get(key)
      if (inFlight) {
        return inFlight.then(
          result => result,
          () => ({ status: 'failed' }) as const,
        )
      }

      let resolveOperation: (result: NativeTranslationTextSuccess) => void = () => undefined
      let rejectOperation: (error: Error) => void = () => undefined
      const base = new Promise<NativeTranslationTextSuccess>((resolve, reject) => {
        resolveOperation = resolve
        rejectOperation = reject
      })
      let operation: Promise<NativeTranslationTextSuccess>
      operation = base.catch((error: unknown) => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key)
        throw error
      })
      this.rememberInFlight(key, operation)
      pending.push({ key, text, provider, operation, resolve: resolveOperation, reject: rejectOperation })
      return operation.then(
        result => result,
        () => ({ status: 'failed' }) as const,
      )
    })

    if (pending.length > 0) await this.resolvePendingBatch(pending, provider)
    return Promise.all(operations)
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
  }

  private remember(key: string, operation: Promise<NativeTranslationTextSuccess>): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest === 'string') this.cache.delete(oldest)
    }
    this.cache.set(key, operation)
  }

  private rememberInFlight(key: string, operation: Promise<NativeTranslationTextSuccess>): void {
    this.inFlight.set(key, operation)
  }

  private translationKey(text: string, provider: TranslationProviderName | undefined): string {
    return JSON.stringify([provider ?? null, text])
  }

  private targetLanguage(sourceLang: string | undefined): string {
    const targetLang = this.resolveTargetLanguage(sourceLang).trim()
    if (!targetLang) throw new Error('translation target language is blank')
    return targetLang
  }

  private async resolvePendingBatch(
    pending: PendingText[],
    provider: TranslationProviderName | undefined,
  ): Promise<void> {
    const detectedLanguages = await Promise.all(pending.map(async ({ text }) => {
      try {
        return this.normalizeLanguage(await this.gateway.detectLanguage(text, provider))
      } catch {
        return undefined
      }
    }))

    const workItems: TranslationWorkItem[] = []
    for (const [index, pendingText] of pending.entries()) {
      try {
        workItems.push({
          index,
          text: pendingText.text,
          sourceLang: detectedLanguages[index],
          targetLang: this.targetLanguage(detectedLanguages[index]),
        })
      } catch {
        pendingText.reject(new Error('translation unavailable'))
      }
    }

    await this.requestGroups(workItems, pending, true, provider)
  }

  private async requestGroups(
    items: TranslationWorkItem[],
    pending: PendingText[],
    allowCorrection: boolean,
    provider: TranslationProviderName | undefined,
  ): Promise<void> {
    const groups = new Map<string, TranslationWorkItem[]>()
    for (const item of items) {
      const sourceKey = item.sourceLang ?? 'und'
      const targetKey = normalizeTranslationLanguage(item.targetLang) ?? item.targetLang.trim().toLowerCase()
      const key = `${sourceKey}\u0000${targetKey}`
      const group = groups.get(key)
      if (group) group.push(item)
      else groups.set(key, [item])
    }

    const corrections: TranslationWorkItem[] = []
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += MAX_BATCH_SIZE) {
        const chunk = group.slice(offset, offset + MAX_BATCH_SIZE)
        let results: NativeTranslationBatchResult[] | undefined
        try {
          const input: NativeTranslationBatchInput = {
            texts: chunk.map(item => item.text),
            targetLang: chunk[0]?.targetLang ?? '',
            ...(chunk[0]?.sourceLang ? { sourceLang: chunk[0].sourceLang } : {}),
            ...(provider === undefined ? {} : { provider }),
          }
          results = await this.gateway.translateBatch(input)
        } catch {
          for (const item of chunk) this.rejectPending(item, pending)
          continue
        }

        for (const [index, item] of chunk.entries()) {
          const result = results?.[index]
          if (!this.isSuccessfulResult(result)) {
            this.rejectPending(item, pending)
            continue
          }

          const detectedLang = this.normalizeLanguage(result.detectedLang)
          if (allowCorrection && !item.sourceLang && detectedLang) {
            try {
              const correctedTarget = this.targetLanguage(detectedLang)
              if (this.languageKey(correctedTarget) !== this.languageKey(item.targetLang)) {
                corrections.push({
                  ...item,
                  sourceLang: detectedLang,
                  targetLang: correctedTarget,
                })
                continue
              }
            } catch {
              this.rejectPending(item, pending)
              continue
            }
          }
          this.resolvePending(item, pending, {
            status: 'translated',
            translated: result.translated,
            requestedProvider: result.requestedProvider,
            provider: result.provider,
            downgraded: result.downgraded,
          })
        }
      }
    }

    if (corrections.length > 0) await this.requestGroups(corrections, pending, false, provider)
  }

  private languageKey(language: string): string {
    return normalizeTranslationLanguage(language) ?? language.trim().toLowerCase()
  }

  private normalizeLanguage(sourceLang: string | null | undefined): string | undefined {
    try {
      return normalizeTranslationLanguage(sourceLang) ?? undefined
    } catch {
      return undefined
    }
  }

  private isSuccessfulResult(
    result: NativeTranslationBatchResult | undefined,
  ): result is SuccessfulBatchResult {
    if (!result) return false
    return !result.failed
      && result.provider !== 'none'
      && 'requestedProvider' in result
      && typeof result.translated === 'string'
      && Boolean(result.translated.trim())
  }

  private resolvePending(
    item: TranslationWorkItem,
    pending: PendingText[],
    result: NativeTranslationTextSuccess,
  ): void {
    const pendingText = pending[item.index]
    if (!pendingText) return
    if (this.inFlight.get(pendingText.key) === pendingText.operation) {
      this.inFlight.delete(pendingText.key)
      if (pendingText.provider !== undefined) {
        this.remember(pendingText.key, Promise.resolve(result))
      }
    }
    pendingText.resolve(result)
  }

  private rejectPending(item: TranslationWorkItem, pending: PendingText[]): void {
    const pendingText = pending[item.index]
    if (!pendingText) return
    if (this.inFlight.get(pendingText.key) === pendingText.operation) {
      this.inFlight.delete(pendingText.key)
    }
    pendingText.reject(new Error('translation unavailable'))
  }
}
