import { describe, expect, it, vi } from 'vitest'
import { runTranslateJob } from './translate-job.js'

function deps(overrides: Record<string, unknown> = {}) {
  return {
    loadMessage: vi.fn().mockResolvedValue({
      id: 'msg-1', body: 'Hello, is this in stock?', direction: 'in', conversationId: 'conv-1',
    }),
    loadEngineConfig: vi.fn().mockResolvedValue({ global: 'deepl' }),
    hasTranslation: vi.fn().mockResolvedValue(false),
    gateway: {
      translate: vi.fn().mockResolvedValue({
        text: '你好，这个还有货吗？', detectedLang: 'en',
        provider: 'deepl', cached: false, downgradedFrom: [],
      }),
    },
    saveTranslation: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const job = { messageId: 'msg-1', conversationId: 'conv-1' }

describe('runTranslateJob', () => {
  it('收到的消息译成中文', async () => {
    const d = deps()
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).toHaveBeenCalledWith(expect.objectContaining({ to: 'zh' }))
  })

  it('保存译文并广播给客户端', async () => {
    const d = deps()
    await runTranslateJob(job, d as never)
    expect(d.saveTranslation).toHaveBeenCalledWith({
      messageId: 'msg-1', targetLang: 'zh',
      provider: 'deepl', translatedText: '你好，这个还有货吗？',
    })
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'translation', messageId: 'msg-1' }),
    )
  })

  it('消息不存在时安静跳过，不抛错触发重试', async () => {
    const d = deps({ loadMessage: vi.fn().mockResolvedValue(null) })
    await expect(runTranslateJob({ messageId: 'gone', conversationId: 'c' }, d as never))
      .resolves.toBeUndefined()
    expect(d.gateway.translate).not.toHaveBeenCalled()
  })

  it('空白消息体跳过翻译', async () => {
    const d = deps({
      loadMessage: vi.fn().mockResolvedValue({
        id: 'msg-1', body: '   ', direction: 'in', conversationId: 'conv-1',
      }),
    })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
  })

  it('已有译文时跳过，不重复调用翻译引擎', async () => {
    const d = deps({ hasTranslation: vi.fn().mockResolvedValue(true) })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
    expect(d.saveTranslation).not.toHaveBeenCalled()
  })

  it('使用该会话配置的引擎', async () => {
    const d = deps({ loadEngineConfig: vi.fn().mockResolvedValue({ conversation: 'claude', global: 'deepl' }) })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).toHaveBeenCalledWith(
      expect.objectContaining({ config: { conversation: 'claude', global: 'deepl' } }),
    )
  })

  it('全部引擎失败时抛错，交给 BullMQ 重试', async () => {
    const d = deps({
      gateway: { translate: vi.fn().mockRejectedValue(new Error('all translation providers failed')) },
    })
    await expect(runTranslateJob(job, d as never)).rejects.toThrow('all translation providers failed')
  })

  it('广播失败不影响译文已保存的事实，异常向上抛给 BullMQ', async () => {
    const d = deps({ publish: vi.fn().mockRejectedValue(new Error('ws down')) })
    await expect(runTranslateJob(job, d as never)).rejects.toThrow('ws down')
    expect(d.saveTranslation).toHaveBeenCalledOnce()
  })
})
