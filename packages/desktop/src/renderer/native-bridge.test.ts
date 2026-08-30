import { describe, expect, it, vi } from 'vitest'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type NativeComposerCommand } from '@im-hub/shared'
import {
  handleNativeCommandResult,
  nativeComposerBridge,
  nativeMessageTranslationBridge,
  nativeMessageTranslationsFromRows,
  nativeOutboxBridge,
  parseNativeGuestEvent,
  registerNativeCommandTarget,
} from './native-bridge.js'
import { parseNativeHostCommand } from '../native-bridge-runtime.js'

const context = {
  accountId: 'acc-1',
  platformConversationId: 'chat-1',
  contextRevision: 7,
}

describe('parseNativeGuestEvent', () => {
  it('拒绝未知协议版本', () => {
    expect(parseNativeGuestEvent({ protocolVersion: 99, type: 'bridge.ready' })).toBeNull()
  })

  it('只接受有界且不含正文的 outbox 状态', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.status',
      pendingCount: 3,
      deadLetterCount: 1,
      isSending: true,
      lastErrorCode: 'server_rejected',
    })).toMatchObject({ type: 'outbox.status', pendingCount: 3, deadLetterCount: 1 })

    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.status',
      pendingCount: -1,
      deadLetterCount: 0,
      isSending: false,
      lastErrorCode: null,
    })).toBeNull()

    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.status',
      pendingCount: 1_001,
      deadLetterCount: 0,
      isSending: false,
      lastErrorCode: null,
    })).toBeNull()
  })

  it('接受结构完整的当前会话事件', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'context.changed',
      contextRevision: 2,
      context: {
        platformConversationId: 'c-1',
        contactExternalId: 'u-1',
        contactDisplayName: 'Jane',
      },
    })).toMatchObject({ type: 'context.changed', contextRevision: 2 })
  })

  it('接受平台客户端报告的稳定账号身份', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '778899',
    })).toMatchObject({ type: 'account.identity', platformAccountExternalId: '778899' })
  })

  it('接受平台客户端显式退出事件', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.signed-out',
    })).toMatchObject({ type: 'account.signed-out' })
  })

  it('只接受带有效正文指纹的 Signal attempt 恢复状态', () => {
    const state = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.state',
      contextRevision: 3,
      platformConversationId: 'u:peer',
      draft: '',
      canSend: false,
      sendAttempt: {
        attemptId: 'attempt-1',
        contextRevision: 2,
        draftFingerprint: 'a'.repeat(64),
        platformMessageId: 'sender:123',
      },
    }
    expect(parseNativeGuestEvent(state)).toEqual(state)
    expect(parseNativeGuestEvent({
      ...state,
      sendAttempt: { ...state.sendAttempt, draftFingerprint: 'invalid' },
    })).toBeNull()
  })

  it('拒绝缺平台消息 id 的回传事件', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1', message: {},
    })).toBeNull()
  })

  it('拒绝畸形或超量的媒体引用', () => {
    const message = {
      platformConversationId: 'c-1', platformMessageId: 'm-1', direction: 'in',
      senderExternalId: 'u-1', senderDisplayName: null, conversationDisplayName: null,
      body: '', replyToPlatformMessageId: null, sentAt: '2026-08-26T00:00:00Z',
      editedAt: null, editVersion: null, raw: {},
    }
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1',
      message: { ...message, mediaRefs: [{ kind: 'image', remoteId: '' }] },
    })).toBeNull()
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1',
      message: { ...message, mediaRefs: Array.from({ length: 65 }, () => ({ kind: 'image', remoteId: 'r-1' })) },
    })).toBeNull()
  })

  it('拒绝不能安全序列化成 HTTP JSON 的 raw 元数据', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1',
      message: {
        platformConversationId: 'c-1', platformMessageId: 'm-1', direction: 'in',
        senderExternalId: 'u-1', senderDisplayName: null, conversationDisplayName: null,
        body: '', mediaRefs: [], replyToPlatformMessageId: null,
        sentAt: '2026-08-26T00:00:00Z', editedAt: null, editVersion: null,
        raw: { unsupported: 1n },
      },
    })).toBeNull()
  })

  it('拒绝缺失或非法的单调编辑版本', () => {
    const message = {
      platformConversationId: '-100123', platformMessageId: '-100123:1', direction: 'in',
      senderExternalId: 'u-1', senderDisplayName: null, conversationDisplayName: null,
      body: '', mediaRefs: [], replyToPlatformMessageId: null,
      sentAt: '2026-08-26T00:00:00Z', editedAt: null, raw: {},
    }
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1', message,
    })).toBeNull()
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert', eventId: 'e-1', message: { ...message, editVersion: -1 },
    })).toBeNull()
  })

  it('只接受有界且结构完整的回应状态事件', () => {
    const reaction = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.reaction', eventId: 'reaction-1',
      targetPlatformMessageId: 'sender:1', reactorExternalId: 'reactor',
      emoji: '👍', reactedAt: '2026-08-30T00:00:00.000Z',
    }
    expect(parseNativeGuestEvent(reaction)).toEqual(reaction)
    expect(parseNativeGuestEvent({ ...reaction, emoji: '' })).toBeNull()
    expect(parseNativeGuestEvent({ ...reaction, emoji: 'x'.repeat(65) })).toBeNull()
  })

  it('拒绝用未知字段绕过 raw 限制的超大桥接帧', () => {
    expect(parseNativeGuestEvent({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.ready',
      extra: 'x'.repeat(900_001),
    })).toBeNull()
  })
})

describe('nativeComposerBridge', () => {
  it('主进程只转发结构完整的 typed command', () => {
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.request-state',
    })).toMatchObject({ type: 'bridge.request-state' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.retry-dead-letters',
    })).toMatchObject({ type: 'outbox.retry-dead-letters' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.discard-dead-letters',
    })).toMatchObject({ type: 'outbox.discard-dead-letters' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.send',
      requestId: 'request-1',
      contextRevision: 2,
      platformConversationId: '-100123',
      attemptId: 'attempt-1',
      attemptContextRevision: 2,
      draftFingerprint: 'a'.repeat(64),
    })).toMatchObject({ type: 'composer.send', attemptId: 'attempt-1' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.ack-send',
      attemptId: 'attempt-1',
      platformMessageId: 'sender:123',
    })).toMatchObject({ type: 'composer.ack-send', attemptId: 'attempt-1' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.set-translations',
      translations: [{
        platformMessageId: 'sender:123', translatedText: '你好', revision: 'initial',
      }],
    })).toMatchObject({ type: 'message.set-translations' })
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.set-translations',
      translations: [],
    })).toBeNull()
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.send',
      requestId: 'request-2',
      contextRevision: 2,
      platformConversationId: '-100123',
      attemptId: 'attempt-1',
      attemptContextRevision: -1,
      draftFingerprint: 'invalid',
    })).toBeNull()
    expect(parseNativeHostCommand({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'open-devtools',
    })).toBeNull()
  })

  it('运维命令只发给指定账号的已登记 guest', async () => {
    const sent: unknown[] = []
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent.push(command) },
    })

    await nativeOutboxBridge.retryDeadLetters(context.accountId)
    await nativeOutboxBridge.discardDeadLetters(context.accountId)

    expect(sent).toEqual([
      { protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'outbox.retry-dead-letters' },
      { protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'outbox.discard-dead-letters' },
    ])
    await expect(nativeOutboxBridge.retryDeadLetters('other-account')).rejects.toMatchObject({
      code: 'bridge_disconnected',
    })
    unregister()
  })

  it('把当前入站译文作为一个有界批命令发送给指定账号', async () => {
    const sent: unknown[] = []
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent.push(command) },
    })
    const translations = nativeMessageTranslationsFromRows([
      {
        platform_message_id: 'sender:123', direction: 'in', translated_text: '你好',
        edited_at: null,
      },
      {
        platform_message_id: 'self:124', direction: 'out', translated_text: '不应发送',
        edited_at: null,
      },
    ])

    await nativeMessageTranslationBridge.sync(context.accountId, translations)

    expect(sent).toEqual([{
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.set-translations',
      translations: [{
        platformMessageId: 'sender:123', translatedText: '你好', revision: 'initial',
      }],
    }])
    unregister()
  })

  it('命令携带 account 绑定之外的会话 revision，并按 requestId 收敛结果', async () => {
    let sent: NativeComposerCommand | null = null
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent = command as NativeComposerCommand },
    })

    const pending = nativeComposerBridge.getDraft(context)
    expect(sent).toMatchObject({
      type: 'composer.get-draft', contextRevision: 7, platformConversationId: 'chat-1',
    })
    const command = sent!
    expect(handleNativeCommandResult(context.accountId, {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result', requestId: command.requestId, command: command.type,
      contextRevision: 7, ok: true, draft: 'employee edited text',
    })).toBe(true)
    await expect(pending).resolves.toBe('employee edited text')
    unregister()
  })

  it('拒绝旧会话 revision 返回的命令结果', async () => {
    let sent: NativeComposerCommand | null = null
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent = command as NativeComposerCommand },
    })

    const pending = nativeComposerBridge.send(context, 'attempt-1')
    const command = sent!
    expect(command).toMatchObject({ type: 'composer.send', attemptId: 'attempt-1' })
    handleNativeCommandResult(context.accountId, {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result', requestId: command.requestId, command: command.type,
      contextRevision: 8, ok: true, attemptId: 'attempt-1', platformMessageId: 'm-1',
    })
    await expect(pending).rejects.toThrow('过期或不匹配')
    unregister()
  })

  it('8 秒没有最终结果时只报告 result_unknown，不把 attempt 当作未发送', async () => {
    vi.useFakeTimers()
    try {
      const unregister = registerNativeCommandTarget(context.accountId, {
        send: () => {},
      })
      const pending = nativeComposerBridge.send(
        context,
        'attempt-timeout',
        'a'.repeat(64),
        7,
      )
      const result = expect(pending).rejects.toMatchObject({ code: 'result_unknown' })
      await vi.advanceTimersByTimeAsync(8_000)
      await result
      unregister()
    } finally {
      vi.useRealTimers()
    }
  })

  it('保留 guest 的脱敏错误码供外壳区分明确失败与结果未知', async () => {
    let sent: NativeComposerCommand | null = null
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent = command as NativeComposerCommand },
    })

    const pending = nativeComposerBridge.send(context, 'attempt-1')
    const command = sent!
    handleNativeCommandResult(context.accountId, {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result', requestId: command.requestId, command: command.type,
      contextRevision: 7, ok: false, attemptId: 'attempt-1',
      error: { code: 'send_failed', message: 'Telegram 原生发送失败' },
    })
    await expect(pending).rejects.toMatchObject({ code: 'send_failed' })
    unregister()
  })

  it('Signal 最终结果提交后向同一账号 guest 发送 attempt ACK', async () => {
    const sent: unknown[] = []
    const unregister = registerNativeCommandTarget(context.accountId, {
      send: (_channel, command) => { sent.push(command) },
    })

    await nativeComposerBridge.acknowledgeSend(context.accountId, 'attempt-1', 'sender:123')

    expect(sent).toEqual([{
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.ack-send',
      attemptId: 'attempt-1',
      platformMessageId: 'sender:123',
    }])
    unregister()
  })
})
