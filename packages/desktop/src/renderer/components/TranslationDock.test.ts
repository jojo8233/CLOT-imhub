import { describe, expect, it, vi } from 'vitest'
import { sendCurrentNativeDraft, shouldTranslateOnKeyDown } from './TranslationDock.js'

describe('TranslationDock keyboard handling', () => {
  it('只在非 IME 组合输入的 Enter 触发翻译', () => {
    expect(shouldTranslateOnKeyDown({
      key: 'Enter', shiftKey: false, isComposing: false,
    })).toBe(true)
    expect(shouldTranslateOnKeyDown({
      key: 'Enter', shiftKey: false, isComposing: true,
    })).toBe(false)
    expect(shouldTranslateOnKeyDown({
      key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229,
    })).toBe(false)
    expect(shouldTranslateOnKeyDown({
      key: 'Enter', shiftKey: true, isComposing: false,
    })).toBe(false)
  })

  it('发送前先读取员工修改后的原生草稿，再调用原生发送', async () => {
    const context = {
      accountId: 'account-1', platformConversationId: 'chat-1', contextRevision: 7,
    }
    const order: string[] = []
    const getDraft = vi.fn(async () => {
      order.push('getDraft')
      return 'employee edited text'
    })
    const send = vi.fn(async () => {
      order.push('send')
      return 'chat-1:message-1'
    })

    await expect(sendCurrentNativeDraft(context, { getDraft, send }))
      .resolves.toBe('chat-1:message-1')
    expect(order).toEqual(['getDraft', 'send'])
    expect(getDraft).toHaveBeenCalledWith(context)
    expect(send).toHaveBeenCalledWith(context)
  })

  it('原生输入框为空时不调用发送', async () => {
    const context = {
      accountId: 'account-1', platformConversationId: 'chat-1', contextRevision: 7,
    }
    const send = vi.fn(async () => 'should-not-send')
    await expect(sendCurrentNativeDraft(context, {
      getDraft: vi.fn(async () => '   '),
      send,
    })).rejects.toThrow('原生输入框为空')
    expect(send).not.toHaveBeenCalled()
  })

  it('读取草稿期间切换会话时拒绝旧结果，不调用发送', async () => {
    const context = {
      accountId: 'account-1', platformConversationId: 'chat-old', contextRevision: 7,
    }
    const send = vi.fn(async () => 'should-not-send')
    await expect(sendCurrentNativeDraft(
      context,
      { getDraft: vi.fn(async () => 'employee edited text'), send },
      () => false,
    )).resolves.toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
