import type {
  NativeTranslationBatchInput,
  NativeTranslationBatchResult,
} from '@im-hub/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeTranslationCoordinator,
  type NativeTranslationGatewayPort,
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

  it('预检测未知但批量结果识别为中文时只纠偏一次', async () => {
    const translateBatch = vi.fn(async (input: NativeTranslationBatchInput) => [
      input.targetLang === 'zh'
        ? result('错误方向', 'zh-CN')
        : result('correct direction', 'zh-CN'),
    ])
    const port = gateway({
      detectLanguage: vi.fn(async () => undefined),
      translateBatch,
    })
    const coordinator = new NativeTranslationCoordinator(port)

    await expect(coordinator.translate('你好')).resolves.toBe('correct direction')
    expect(translateBatch).toHaveBeenNthCalledWith(1, {
      texts: ['你好'],
      targetLang: 'zh',
    })
    expect(translateBatch).toHaveBeenNthCalledWith(2, {
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
