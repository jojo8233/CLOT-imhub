import {
  bilingualTranslationTarget,
  normalizeTranslationLanguage,
  type NativeTranslationBatchInput,
  type NativeTranslationBatchResult,
} from '@im-hub/shared'

const DEFAULT_MAX_CACHE_ENTRIES = 500
const MAX_BATCH_SIZE = 20

export interface NativeTranslationGatewayPort {
  detectLanguage(text: string): Promise<string | undefined>
  translateBatch(
    input: NativeTranslationBatchInput,
  ): Promise<NativeTranslationBatchResult[] | undefined>
}

export interface NativeTranslationCoordinatorOptions {
  maxCacheEntries?: number
  resolveTargetLanguage?(sourceLang: string | undefined): string
}

export type NativeTranslationTextResult =
  | { status: 'translated'; translated: string }
  | { status: 'failed' }

interface PendingText {
  text: string
  operation: Promise<string>
  resolve(translated: string): void
  reject(error: Error): void
}

interface TranslationWorkItem {
  index: number
  text: string
  sourceLang: string | undefined
  targetLang: string
}

interface InternalTranslationResult {
  translated: string
  detectedLang: string | undefined
}

/**
 * 原生客户端共用的无界面翻译编排器。
 *
 * 平台继续负责消息 ID、原生状态和译文渲染；这里仅统一语言策略、窄代理调用、
 * 同文请求去重、缓存和失败清理，避免把 Telegram/Signal/WhatsApp 的 UI 假装成同一套。
 */
export class NativeTranslationCoordinator {
  private readonly cache = new Map<string, Promise<string>>()
  private readonly inFlight = new Map<string, Promise<string>>()
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

  async translate(text: string): Promise<string> {
    if (!text.trim()) throw new Error('translation text is blank')
    const result = (await this.translateMany([text]))[0]
    if (!result || result.status === 'failed') throw new Error('translation unavailable')
    return result.translated
  }

  async translateMany(texts: readonly string[]): Promise<NativeTranslationTextResult[]> {
    const pending: PendingText[] = []
    const operations = texts.map(text => {
      if (!text.trim()) return Promise.resolve<NativeTranslationTextResult>({ status: 'failed' })
      const cached = this.cache.get(text)
      if (cached) {
        return cached.then(
          translated => ({ status: 'translated', translated }) as const,
          () => ({ status: 'failed' }) as const,
        )
      }
      const inFlight = this.inFlight.get(text)
      if (inFlight) {
        return inFlight.then(
          translated => ({ status: 'translated', translated }) as const,
          () => ({ status: 'failed' }) as const,
        )
      }

      let resolveOperation: (translated: string) => void = () => undefined
      let rejectOperation: (error: Error) => void = () => undefined
      const base = new Promise<string>((resolve, reject) => {
        resolveOperation = resolve
        rejectOperation = reject
      })
      let operation: Promise<string>
      operation = base.catch((error: unknown) => {
        if (this.inFlight.get(text) === operation) this.inFlight.delete(text)
        throw error
      })
      this.rememberInFlight(text, operation)
      pending.push({ text, operation, resolve: resolveOperation, reject: rejectOperation })
      return operation.then(
        translated => ({ status: 'translated', translated }) as const,
        () => ({ status: 'failed' }) as const,
      )
    })

    if (pending.length > 0) await this.resolvePendingBatch(pending)
    return Promise.all(operations)
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
  }

  private remember(text: string, operation: Promise<string>): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest === 'string') this.cache.delete(oldest)
    }
    this.cache.set(text, operation)
  }

  private rememberInFlight(text: string, operation: Promise<string>): void {
    this.inFlight.set(text, operation)
  }

  private targetLanguage(sourceLang: string | undefined): string {
    const targetLang = this.resolveTargetLanguage(sourceLang).trim()
    if (!targetLang) throw new Error('translation target language is blank')
    return targetLang
  }

  private async resolvePendingBatch(pending: PendingText[]): Promise<void> {
    const detectedLanguages = await Promise.all(pending.map(async ({ text }) => {
      try {
        return this.normalizeLanguage(await this.gateway.detectLanguage(text))
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

    await this.requestGroups(workItems, pending, true)
  }

  private async requestGroups(
    items: TranslationWorkItem[],
    pending: PendingText[],
    allowCorrection: boolean,
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

          const internalResult: InternalTranslationResult = {
            translated: result.translated,
            detectedLang: this.normalizeLanguage(result.detectedLang),
          }
          if (allowCorrection && !item.sourceLang && internalResult.detectedLang) {
            try {
              const correctedTarget = this.targetLanguage(internalResult.detectedLang)
              if (this.languageKey(correctedTarget) !== this.languageKey(item.targetLang)) {
                corrections.push({
                  ...item,
                  sourceLang: internalResult.detectedLang,
                  targetLang: correctedTarget,
                })
                continue
              }
            } catch {
              this.rejectPending(item, pending)
              continue
            }
          }
          this.resolvePending(item, pending, internalResult.translated)
        }
      }
    }

    if (corrections.length > 0) await this.requestGroups(corrections, pending, false)
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

  private isSuccessfulResult(result: NativeTranslationBatchResult | undefined): result is NativeTranslationBatchResult {
    if (!result) return false
    return !result.failed && typeof result.translated === 'string' && Boolean(result.translated.trim())
  }

  private resolvePending(item: TranslationWorkItem, pending: PendingText[], translated: string): void {
    const pendingText = pending[item.index]
    if (!pendingText) return
    if (this.inFlight.get(pendingText.text) === pendingText.operation) {
      this.inFlight.delete(pendingText.text)
      this.remember(pendingText.text, Promise.resolve(translated))
    }
    pendingText.resolve(translated)
  }

  private rejectPending(item: TranslationWorkItem, pending: PendingText[]): void {
    const pendingText = pending[item.index]
    if (!pendingText) return
    if (this.inFlight.get(pendingText.text) === pendingText.operation) {
      this.inFlight.delete(pendingText.text)
    }
    pendingText.reject(new Error('translation unavailable'))
  }
}
