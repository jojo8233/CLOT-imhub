import {
  bilingualTranslationTarget,
  normalizeTranslationLanguage,
  type NativeTranslationBatchInput,
  type NativeTranslationBatchResult,
} from '@im-hub/shared'

const DEFAULT_MAX_CACHE_ENTRIES = 500

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

/**
 * 原生客户端共用的无界面翻译编排器。
 *
 * 平台继续负责消息 ID、原生状态和译文渲染；这里仅统一语言策略、窄代理调用、
 * 同文请求去重、缓存和失败清理，避免把 Telegram/Signal/WhatsApp 的 UI 假装成同一套。
 */
export class NativeTranslationCoordinator {
  private readonly cache = new Map<string, Promise<string>>()
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
    this.maxCacheEntries = maxCacheEntries
    this.resolveTargetLanguage = options.resolveTargetLanguage ?? bilingualTranslationTarget
  }

  translate(text: string): Promise<string> {
    if (!text.trim()) return Promise.reject(new Error('translation text is blank'))
    const cached = this.cache.get(text)
    if (cached) return cached

    let operation: Promise<string>
    operation = this.translateUncached(text).catch((error: unknown) => {
      if (this.cache.get(text) === operation) this.cache.delete(text)
      throw error
    })

    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (typeof oldest === 'string') this.cache.delete(oldest)
    }
    this.cache.set(text, operation)
    return operation
  }

  clear(): void {
    this.cache.clear()
  }

  private async translateUncached(text: string): Promise<string> {
    const detected = normalizeTranslationLanguage(await this.gateway.detectLanguage(text)) ?? undefined
    let targetLang = this.targetLanguage(detected)
    let result = await this.request(text, targetLang, detected)

    if (!detected) {
      const batchDetected = normalizeTranslationLanguage(result.detectedLang) ?? undefined
      const correctedTarget = this.targetLanguage(batchDetected)
      if (batchDetected && correctedTarget !== targetLang) {
        targetLang = correctedTarget
        result = await this.request(text, targetLang, batchDetected)
      }
    }

    return result.translated
  }

  private targetLanguage(sourceLang: string | undefined): string {
    const targetLang = this.resolveTargetLanguage(sourceLang).trim()
    if (!targetLang) throw new Error('translation target language is blank')
    return targetLang
  }

  private async request(
    text: string,
    targetLang: string,
    sourceLang: string | undefined,
  ): Promise<NativeTranslationBatchResult> {
    const input: NativeTranslationBatchInput = {
      texts: [text],
      targetLang,
      ...(sourceLang ? { sourceLang } : {}),
    }
    const result = (await this.gateway.translateBatch(input))?.[0]
    if (!result || result.failed || !result.translated.trim()) {
      throw new Error('translation unavailable')
    }
    return result
  }
}
