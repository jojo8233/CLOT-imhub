import { createHash } from 'node:crypto'
import type Redis from 'ioredis'
import type { ProviderName, TranslationOutput } from './types.js'

const TTL_SECONDS = 60 * 60 * 24 * 30

/**
 * 用 \x00 分隔各字段，而不是空格——空格可以被文本内容本身伪造出来，
 * 导致 ('en', 'a b') 和 ('en a', 'b') 撞进同一个 key，返回错误的译文。
 */
export function cacheKey(provider: ProviderName, from: string, to: string, text: string): string {
  const digest = createHash('sha256').update([provider, from, to, text].join('\x00')).digest('hex')
  return `tr:${digest}`
}

function isTranslationOutput(value: unknown): value is TranslationOutput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.text === 'string' && typeof v.detectedLang === 'string'
}

/**
 * 缓存是纯优化，不是数据源。任何一侧出问题都必须降级成"没有缓存"，
 * 绝不能把翻译主链路一起拖垮——宁可多花一次 API 钱，也不能让客服发不出消息。
 */
export class TranslationCache {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<TranslationOutput | null> {
    let raw: string | null
    try {
      raw = await this.redis.get(key)
    } catch {
      return null
    }
    if (!raw) return null

    try {
      const parsed: unknown = JSON.parse(raw)
      return isTranslationOutput(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async set(key: string, value: TranslationOutput): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS)
    } catch {
      // 写缓存失败无所谓，下次重新翻译即可
    }
  }
}
