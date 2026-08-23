import { describe, expect, it, vi } from 'vitest'
import { TranslationCache, cacheKey } from './cache.js'

describe('cacheKey', () => {
  it('相同输入产生相同 key', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).toBe(cacheKey('deepl', 'zh', 'en', '你好'))
  })

  it('引擎不同则 key 不同', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).not.toBe(cacheKey('claude', 'zh', 'en', '你好'))
  })

  it('目标语言不同则 key 不同', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).not.toBe(cacheKey('deepl', 'zh', 'ja', '你好'))
  })

  it('源语言不同则 key 不同', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).not.toBe(cacheKey('deepl', 'auto', 'en', '你好'))
  })

  it('文本不同则 key 不同', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).not.toBe(cacheKey('deepl', 'zh', 'en', '再见'))
  })

  it('key 带固定前缀便于运维清理', () => {
    expect(cacheKey('deepl', 'zh', 'en', '你好')).toMatch(/^tr:[0-9a-f]{64}$/)
  })

  it('分隔符不可被文本内容伪造出碰撞', () => {
    // 若拼接方式是简单的空格连接，下面两组的拼接串会相同，产生错误的缓存命中
    expect(cacheKey('deepl', 'zh', 'en', 'a b')).not.toBe(cacheKey('deepl', 'zh', 'en a', 'b'))
  })
})

describe('TranslationCache', () => {
  it('未命中返回 null', async () => {
    const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn() }
    expect(await new TranslationCache(redis as never).get('tr:abc')).toBeNull()
  })

  it('命中时反序列化返回', async () => {
    const stored = JSON.stringify({ text: 'Hello', detectedLang: 'zh' })
    const redis = { get: vi.fn().mockResolvedValue(stored), set: vi.fn() }
    expect(await new TranslationCache(redis as never).get('tr:abc'))
      .toEqual({ text: 'Hello', detectedLang: 'zh' })
  })

  it('写入时带 30 天 TTL', async () => {
    const redis = { get: vi.fn(), set: vi.fn().mockResolvedValue('OK') }
    await new TranslationCache(redis as never).set('tr:abc', { text: 'Hello', detectedLang: 'zh' })
    expect(redis.set).toHaveBeenCalledWith(
      'tr:abc',
      JSON.stringify({ text: 'Hello', detectedLang: 'zh' }),
      'EX',
      60 * 60 * 24 * 30,
    )
  })

  it('存储内容损坏时当作未命中而不是抛错', async () => {
    const redis = { get: vi.fn().mockResolvedValue('{not json'), set: vi.fn() }
    expect(await new TranslationCache(redis as never).get('tr:abc')).toBeNull()
  })

  it('存储内容是合法 JSON 但形状不对时也当作未命中', async () => {
    const redis = { get: vi.fn().mockResolvedValue('{"text":123}'), set: vi.fn() }
    expect(await new TranslationCache(redis as never).get('tr:abc')).toBeNull()
  })

  it('Redis 读失败时当作未命中，不让缓存故障阻断翻译', async () => {
    const redis = { get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), set: vi.fn() }
    expect(await new TranslationCache(redis as never).get('tr:abc')).toBeNull()
  })

  it('Redis 写失败时不抛错，翻译结果照常返回', async () => {
    const redis = { get: vi.fn(), set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    await expect(new TranslationCache(redis as never).set('tr:abc', { text: 'x', detectedLang: 'zh' }))
      .resolves.toBeUndefined()
  })
})
