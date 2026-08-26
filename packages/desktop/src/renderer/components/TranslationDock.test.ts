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

    await expect(sendCurrentNativeDraft(
      context,
      { getDraft, send },
      () => true,
      () => 'attempt-stable',
    ))
      .resolves.toBe('chat-1:message-1')
    expect(order).toEqual(['getDraft', 'send'])
    expect(getDraft).toHaveBeenCalledWith(context)
    expect(send).toHaveBeenCalledWith(context, 'attempt-stable')
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

  it('结果未知后的相同原生草稿沿用稳定 attemptId', async () => {
    const context = {
      accountId: 'account-1', platformConversationId: 'chat-1', contextRevision: 7,
    }
    let savedDraft: string | null = null
    let savedAttemptId: string | null = null
    const attempts: string[] = []
    const bridge = {
      getDraft: vi.fn(async () => 'employee edited text'),
      send: vi.fn(async (_context: typeof context, attemptId?: string) => {
        attempts.push(attemptId ?? '')
        throw new Error('result unknown')
      }),
    }
    const resolveAttemptId = (draft: string) => {
      if (savedDraft === draft && savedAttemptId) return savedAttemptId
      savedDraft = draft
      savedAttemptId = 'attempt-stable'
      return savedAttemptId
    }

    await expect(sendCurrentNativeDraft(
      context, bridge, () => true, resolveAttemptId,
    )).rejects.toThrow('result unknown')
    await expect(sendCurrentNativeDraft(
      context, bridge, () => true, resolveAttemptId,
    )).rejects.toThrow('result unknown')
    expect(attempts).toEqual(['attempt-stable', 'attempt-stable'])
  })

  it('结果未知重试直接查询原 attempt，不依赖已被原生流程清空的草稿', async () => {
    const context = {
      accountId: 'account-1', platformConversationId: 'chat-1', contextRevision: 7,
    }
    const getDraft = vi.fn(async () => '')
    const send = vi.fn(async () => 'chat-1:42')

    await expect(sendCurrentNativeDraft(
      context,
      { getDraft, send },
      () => true,
      () => 'should-not-be-used',
      'attempt-unknown',
    )).resolves.toBe('chat-1:42')
    expect(getDraft).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(context, 'attempt-unknown')
  })
})
