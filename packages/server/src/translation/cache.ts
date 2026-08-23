import { createHash } from 'node:crypto'
import type Redis from 'ioredis'
import type { ProviderName, TranslationOutput } from './types.js'

const TTL_SECONDS = 60 * 60 * 24 * 30
// TODO: key 里只有 provider 名，不含模型版本。换模型（如 claude-sonnet-5 升级）后，
// 旧模型的译文仍会服务到 TTL 到期。缓解办法是换模型时清一遍：
//   redis-cli --scan --pattern 'tr:*' | xargs redis-cli del
// 彻底解决需要把模型标识加进 TranslationProvider 接口，留到 P1。

/**
 * 每个字段带上字节长度前缀再拼接。
 *
 * 只用分隔符是不够的——分隔符本身可能出现在字段内容里：
 * ('en\x00X', 'Y') 和 ('en', 'X\x00Y') 的拼接串完全相同。
 * 长度前缀让字段边界不可伪造，与上游是否校验 from/to 的字符集无关。
 */
export function cacheKey(provider: ProviderName, from: string, to: string, text: string): string {
  const encoded = [provider, from, to, text.normalize('NFC')]
    .map((f) => `${Buffer.byteLength(f, 'utf8')}:${f}`)
    .join('')
  const digest = createHash('sha256').update(encoded).digest('hex')
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
    } catch (err) {
      console.warn('[translation-cache] 读取失败，降级为未命中:', err instanceof Error ? err.message : err)
      return null
    }
    if (!raw) return null

    try {
      const parsed: unknown = JSON.parse(raw)
      return isTranslationOutput(parsed)
        ? { text: parsed.text, detectedLang: parsed.detectedLang }
        : null
    } catch (err) {
      console.warn('[translation-cache] 缓存内容损坏，降级为未命中:', err instanceof Error ? err.message : err)
      return null
    }
  }

  async set(key: string, value: TranslationOutput): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS)
    } catch (err) {
      console.warn('[translation-cache] 写入失败，下次重新翻译:', err instanceof Error ? err.message : err)
    }
  }
}
