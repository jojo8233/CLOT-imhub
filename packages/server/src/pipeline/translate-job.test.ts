import { describe, expect, it, vi } from 'vitest'
import { runTranslateJob } from './translate-job.js'

function deps(overrides: Record<string, unknown> = {}) {
  return {
    loadMessage: vi.fn().mockResolvedValue({
      id: 'msg-1', body: 'Hello, is this in stock?', direction: 'in', conversationId: 'conv-1',
      accountId: 'account-1', platform: 'signal', platformMessageId: 'sender:1',
      bodyLang: null, revision: 'initial',
    }),
    loadEngineConfig: vi.fn().mockResolvedValue({ global: 'deepl' }),
    hasTranslation: vi.fn().mockResolvedValue(false),
    gateway: {
      translate: vi.fn().mockResolvedValue({
        text: '你好，这个还有货吗？', detectedLang: 'en',
        provider: 'deepl', cached: false, downgradedFrom: [],
      }),
    },
    saveTranslation: vi.fn().mockResolvedValue(true),
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
      revision: 'initial', detectedLang: 'en',
    })
    expect(d.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'translation', messageId: 'msg-1', platformMessageId: 'sender:1',
        conversationId: 'conv-1', accountId: 'account-1', platform: 'signal', targetLang: 'zh',
      }),
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
        id: 'msg-1', body: '   ', direction: 'in', conversationId: 'conv-1', revision: 'initial',
        accountId: 'account-1', platform: 'signal', platformMessageId: 'sender:1', bodyLang: null,
      }),
    })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
  })

  it('Signal 出向任务使用相同中英双语目标', async () => {
    const d = deps({
      loadMessage: vi.fn().mockResolvedValue({
        id: 'msg-1', body: 'outbound', direction: 'out', conversationId: 'conv-1', revision: 'initial',
        accountId: 'account-1', platform: 'signal', platformMessageId: 'sender:1', bodyLang: null,
      }),
    })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).toHaveBeenCalledWith(expect.objectContaining({ to: 'zh' }))
    expect(d.saveTranslation).toHaveBeenCalledOnce()
  })

  it('其他平台遗留的出向任务仍在 worker 边界被丢弃', async () => {
    const d = deps({
      loadMessage: vi.fn().mockResolvedValue({
        id: 'msg-1', body: 'outbound', direction: 'out', conversationId: 'conv-1', revision: 'initial',
        accountId: 'account-1', platform: 'telegram', platformMessageId: 'sender:1', bodyLang: null,
      }),
    })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
    expect(d.saveTranslation).not.toHaveBeenCalled()
  })

  it('已有译文时跳过，不重复调用翻译引擎', async () => {
    const d = deps({ hasTranslation: vi.fn().mockResolvedValue(true) })
    await runTranslateJob(job, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
    expect(d.saveTranslation).not.toHaveBeenCalled()
  })

  it('把检测到的源语言交给原子写入', async () => {
    const d = deps()
    await runTranslateJob(job, d as never)
    expect(d.saveTranslation).toHaveBeenCalledWith(expect.objectContaining({ detectedLang: 'en' }))
  })

  it('中文入站消息改译成英文并以 en 作为幂等槽位', async () => {
    const d = deps({
      loadMessage: vi.fn().mockResolvedValue({
        id: 'msg-1', body: '你好，有库存吗？', direction: 'in', conversationId: 'conv-1',
        accountId: 'account-1', platform: 'signal', platformMessageId: 'sender:1',
        bodyLang: null, revision: 'initial',
      }),
      gateway: {
        translate: vi.fn()
          .mockResolvedValueOnce({
            text: '你好，有库存吗？', detectedLang: 'ZH',
            provider: 'deepl', cached: false, downgradedFrom: [],
          })
          .mockResolvedValueOnce({
            text: 'Hello, is this in stock?', detectedLang: 'ZH',
            provider: 'deepl', cached: false, downgradedFrom: [],
          }),
      },
    })

    await runTranslateJob(job, d as never)

    expect(d.hasTranslation).toHaveBeenNthCalledWith(1, 'msg-1', 'zh')
    expect(d.hasTranslation).toHaveBeenNthCalledWith(2, 'msg-1', 'en')
    expect(d.gateway.translate).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: 'zh' }))
    expect(d.gateway.translate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      from: 'ZH', to: 'en',
    }))
    expect(d.saveTranslation).toHaveBeenCalledWith(expect.objectContaining({
      targetLang: 'en', detectedLang: 'ZH', translatedText: 'Hello, is this in stock?',
    }))
    expect(d.publish).toHaveBeenCalledWith(expect.objectContaining({ targetLang: 'en' }))
  })

  it("检测语言是 'und' 时不写 body_lang——那是占位值不是语言", async () => {
    const d = deps({
      gateway: {
        translate: vi.fn().mockResolvedValue({
          text: '你好，这个还有货吗？', detectedLang: 'und',
          provider: 'deepl', cached: false, downgradedFrom: [],
        }),
      },
    })
    await runTranslateJob(job, d as never)
    expect(d.saveTranslation).toHaveBeenCalledWith(expect.objectContaining({ detectedLang: null }))
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

  it('任务 revision 已过期时不调用翻译引擎', async () => {
    const d = deps()
    await runTranslateJob({ ...job, revision: '2026-08-26T01:00:00.000Z' }, d as never)
    expect(d.gateway.translate).not.toHaveBeenCalled()
  })

  it('翻译期间发生编辑时拒绝保存且不广播旧译文', async () => {
    const d = deps({ saveTranslation: vi.fn().mockResolvedValue(false) })
    await runTranslateJob(job, d as never)
    expect(d.publish).not.toHaveBeenCalled()
  })
})
