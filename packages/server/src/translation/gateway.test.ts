import { describe, expect, it, vi } from 'vitest'
import { TranslationGateway, resolveProvider } from './gateway.js'
import { ProviderFailedError, type ProviderName, type TranslationProvider } from './types.js'

describe('resolveProvider', () => {
  it('会话级优先级最高', () => {
    expect(resolveProvider({ conversation: 'claude', account: 'openai', team: 'deepl', global: 'deepl' }))
      .toBe('claude')
  })

  it('会话级缺失时用账号级', () => {
    expect(resolveProvider({ account: 'openai', team: 'deepl', global: 'deepl' })).toBe('openai')
  })

  it('账号级缺失时用团队级', () => {
    expect(resolveProvider({ team: 'claude', global: 'deepl' })).toBe('claude')
  })

  it('都缺失时用全局默认', () => {
    expect(resolveProvider({ global: 'deepl' })).toBe('deepl')
  })
})

function stubProvider(name: ProviderName, impl?: () => Promise<never>): TranslationProvider {
  return {
    name,
    translate: impl ?? vi.fn().mockResolvedValue({ text: `${name}-out`, detectedLang: 'zh' }),
  }
}

const noCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
}

const boom = () => Promise.reject(new ProviderFailedError('deepl', new Error('boom')))

describe('TranslationGateway', () => {
  it('使用解析出的引擎翻译', async () => {
    const gw = new TranslationGateway(
      [stubProvider('deepl'), stubProvider('claude')],
      noCache as never,
      ['deepl', 'openai', 'claude'],
    )
    const r = await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'claude' } })
    expect(r.text).toBe('claude-out')
    expect(r.provider).toBe('claude')
    expect(r.cached).toBe(false)
    expect(r.downgradedFrom).toEqual([])
  })

  it('主引擎失败时降级到下一个', async () => {
    const gw = new TranslationGateway(
      [stubProvider('deepl', boom), stubProvider('openai')],
      noCache as never,
      ['deepl', 'openai', 'claude'],
    )
    const r = await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } })
    expect(r.provider).toBe('openai')
    expect(r.downgradedFrom).toEqual(['deepl'])
  })

  it('连续失败时继续沿 fallback 顺序尝试', async () => {
    const gw = new TranslationGateway(
      [stubProvider('deepl', boom), stubProvider('openai', boom), stubProvider('claude')],
      noCache as never,
      ['deepl', 'openai', 'claude'],
    )
    const r = await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } })
    expect(r.provider).toBe('claude')
    expect(r.downgradedFrom).toEqual(['deepl', 'openai'])
  })

  it('所有引擎都失败时抛 AllProvidersFailedError', async () => {
    const gw = new TranslationGateway(
      [stubProvider('deepl', boom), stubProvider('openai', boom)],
      noCache as never,
      ['deepl', 'openai'],
    )
    await expect(gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } }))
      .rejects.toThrow('all translation providers failed')
  })

  it('未注册的引擎不会被尝试', async () => {
    // fallbackOrder 里有 claude，但只注册了 deepl 和 openai
    const gw = new TranslationGateway(
      [stubProvider('deepl', boom), stubProvider('openai', boom)],
      noCache as never,
      ['deepl', 'openai', 'claude'],
    )
    await expect(gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } }))
      .rejects.toThrow('all translation providers failed')
  })

  it('命中缓存时不调用任何 provider', async () => {
    const provider = stubProvider('deepl')
    const cache = {
      get: vi.fn().mockResolvedValue({ text: 'cached', detectedLang: 'zh' }),
      set: vi.fn(),
    }
    const gw = new TranslationGateway([provider], cache as never, ['deepl'])
    const r = await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } })
    expect(r.text).toBe('cached')
    expect(r.cached).toBe(true)
    expect(provider.translate).not.toHaveBeenCalled()
  })

  it('翻译成功后写入缓存', async () => {
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const gw = new TranslationGateway([stubProvider('deepl')], cache as never, ['deepl'])
    await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } })
    expect(cache.set).toHaveBeenCalledOnce()
  })

  it('降级后的结果不写缓存，避免把兜底结果固化成首选引擎的答案', async () => {
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn() }
    const gw = new TranslationGateway(
      [stubProvider('deepl', boom), stubProvider('openai')],
      cache as never,
      ['deepl', 'openai'],
    )
    await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { global: 'deepl' } })
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('缓存查的是首选引擎的 key，不是降级后引擎的', async () => {
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const gw = new TranslationGateway([stubProvider('deepl')], cache as never, ['deepl'])
    await gw.translate({ text: '你好', from: 'auto', to: 'en', config: { conversation: 'deepl', global: 'claude' } })
    // 会话级选了 deepl，所以查的 key 必须基于 deepl 而不是 global 的 claude
    const { cacheKey } = await import('./cache.js')
    expect(cache.get).toHaveBeenCalledWith(cacheKey('deepl', 'auto', 'en', '你好'))
  })
})
