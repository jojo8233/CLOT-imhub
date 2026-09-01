import type {
  NativeTranslationBatchInput,
  NativeTranslationBatchResult,
} from '@im-hub/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeTranslationCoordinator,
  type NativeTranslationGatewayPort,
  type NativeTranslationTextResult,
} from './native-translation-coordinator.js'

function result(
  translated: string,
  detectedLang: string,
  failed = false,
): NativeTranslationBatchResult {
  return { translated, detectedLang, provider: 'test', failed }
}

function gateway(overrides: Partial<NativeTranslationGatewayPort> = {}): NativeTranslationGatewayPort {
  return {
    detectLanguage: vi.fn(async () => 'en'),
    translateBatch: vi.fn(async () => [result('译文', 'en')]),
    ...overrides,
  }
}

describe('NativeTranslationCoordinator', () => {
  it('按目标语言分组批量翻译并恢复输入顺序', async () => {
    const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => input.texts.map(text => (
      result(`${input.targetLang}:${text}`, input.sourceLang ?? 'und')
    )))
    const port = gateway({
      detectLanguage: vi.fn(async text => text.startsWith('中') ? 'zh-CN' : 'en'),
      translateBatch,
    })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translateMany(['中一', 'west', '中二'])).resolves.toEqual([
      { status: 'translated', translated: 'en:中一' },
      { status: 'translated', translated: 'zh:west' },
      { status: 'translated', translated: 'en:中二' },
    ] satisfies NativeTranslationTextResult[])
    expect(translateBatch).toHaveBeenCalledTimes(2)
    expect(translateBatch).toHaveBeenCalledWith({
      texts: ['中一', '中二'],
      targetLang: 'en',
      sourceLang: 'zh-cn',
    })
    expect(translateBatch).toHaveBeenCalledWith({
      texts: ['west'],
      targetLang: 'zh',
      sourceLang: 'en',
    })
  })

  it('同一语言组超过二十条时拆批且保持顺序', async () => {
    const texts = Array.from({ length: 21 }, (_, index) => `text-${index}`)
    const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => (
      input.texts.map(text => result(`译:${text}`, 'en'))
    ))
    const port = gateway({ translateBatch })
    const coordinator = new NativeTranslationCoordinator(port)

    const translated = await coordinator.translateMany(texts)
    expect(translateBatch).toHaveBeenCalledTimes(2)
    expect(translateBatch.mock.calls.map(([input]) => input.texts.length)).toEqual([20, 1])
    expect(translated).toEqual(texts.map(text => ({
      status: 'translated',
      translated: `译:${text}`,
    })))
  })

  it('批量结果缺项或失败只影响对应文本且失败不会缓存', async () => {
    const translateBatch = vi.fn()
      .mockResolvedValueOnce([
        result('成功一', 'en'),
        result('', 'en', true),
      ])
      .mockResolvedValueOnce([result('恢复', 'en')])
    const port = gateway({ translateBatch })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translateMany(['one', 'two', 'three'])).resolves.toEqual([
      { status: 'translated', translated: '成功一' },
      { status: 'failed' },
      { status: 'failed' },
    ])
    await expect(coordinator.translateMany(['one', 'two'])).resolves.toEqual([
      { status: 'translated', translated: '成功一' },
      { status: 'translated', translated: '恢复' },
    ])
    expect(port.detectLanguage).toHaveBeenCalledTimes(4)
  })

  it('同批重复正文只检测并翻译一次', async () => {
    const port = gateway()
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translateMany(['same', 'same'])).resolves.toEqual([
      { status: 'translated', translated: '译文' },
      { status: 'translated', translated: '译文' },
    ])
    expect(port.detectLanguage).toHaveBeenCalledTimes(1)
    expect(port.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('成功缓存达到上限时淘汰最早正文', async () => {
    const port = gateway()
    const coordinator = new NativeTranslationCoordinator(port, { maxCacheEntries: 2 })

    await coordinator.translateMany(['first', 'second', 'third'])
    await coordinator.translate('first')
    expect(port.translateBatch).toHaveBeenCalledTimes(2)
  })

  it('规范中文检测结果并译成英文', async () => {
    const port = gateway({ detectLanguage: vi.fn(async () => 'ZH_CN') })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translate('你好')).resolves.toBe('译文')
    expect(port.translateBatch).toHaveBeenCalledWith({
      texts: ['你好'],
      targetLang: 'en',
      sourceLang: 'zh-cn',
    })
  })

  it('非中文默认译成中文', async () => {
    const port = gateway({ detectLanguage: vi.fn(async () => 'ja') })
    const coordinator = new NativeTranslationCoordinator(port)

    await coordinator.translate('hello')
    expect(port.translateBatch).toHaveBeenCalledWith({
      texts: ['hello'],
      targetLang: 'zh',
      sourceLang: 'ja',
    })
  })

  it('预检测未知但混合批量结果识别为中文时只纠偏未知项', async () => {
    const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => input.texts.map(text => (
      text === '你好' && input.targetLang === 'zh'
        ? result('错误方向', 'zh-CN')
        : result(`译:${text}`, input.sourceLang ?? 'en')
    )))
    const port = gateway({
      detectLanguage: vi.fn(async text => text === '你好' ? undefined : 'en'),
      translateBatch,
    })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translateMany(['你好', 'hello'])).resolves.toEqual([
      { status: 'translated', translated: '译:你好' },
      { status: 'translated', translated: '译:hello' },
    ])
    expect(translateBatch).toHaveBeenNthCalledWith(1, {
      texts: ['你好'],
      targetLang: 'zh',
    })
    expect(translateBatch).toHaveBeenNthCalledWith(2, {
      texts: ['hello'],
      targetLang: 'zh',
      sourceLang: 'en',
    })
    expect(translateBatch).toHaveBeenNthCalledWith(3, {
      texts: ['你好'],
      targetLang: 'en',
      sourceLang: 'zh-cn',
    })
  })

  it('同文并发请求共用一次检测和翻译', async () => {
    const port = gateway()
    const coordinator = new NativeTranslationCoordinator(port)

    await Promise.all([coordinator.translate('hello'), coordinator.translate('hello')])
    expect(port.detectLanguage).toHaveBeenCalledTimes(1)
    expect(port.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('失败请求不进缓存，下次可重试', async () => {
    const translateBatch = vi.fn()
      .mockResolvedValueOnce([result('', 'en', true)])
      .mockResolvedValueOnce([result('恢复', 'en')])
    const port = gateway({ translateBatch })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translate('hello')).rejects.toThrow('translation unavailable')
    await expect(coordinator.translate('hello')).resolves.toBe('恢复')
    expect(translateBatch).toHaveBeenCalledTimes(2)
  })

  it('允许 Telegram 等平台保留自己的目标语言策略', async () => {
    const port = gateway({ detectLanguage: vi.fn(async () => 'zh') })
    const coordinator = new NativeTranslationCoordinator(port, {
      resolveTargetLanguage: () => 'zh',
    })

    await coordinator.translate('你好')
    expect(port.translateBatch).toHaveBeenCalledWith({
      texts: ['你好'],
      targetLang: 'zh',
      sourceLang: 'zh',
    })
  })

  it('清空缓存后会重新请求', async () => {
    const port = gateway()
    const coordinator = new NativeTranslationCoordinator(port)

    await coordinator.translate('hello')
    coordinator.clear()
    await coordinator.translate('hello')
    expect(port.translateBatch).toHaveBeenCalledTimes(2)
  })
})
