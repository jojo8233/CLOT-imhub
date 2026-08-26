import { describe, expect, it } from 'vitest'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type NativeComposerCommand } from '@im-hub/shared'
import {
  handleNativeCommandResult,
  nativeComposerBridge,
  parseNativeGuestEvent,
  registerNativeCommandTarget,
} from './native-bridge.js'

const context = {
  accountId: 'acc-1',
  platformConversationId: 'chat-1',
  contextRevision: 7,
}

describe('parseNativeGuestEvent', () => {
  it('拒绝未知协议版本', () => {
    expect(parseNativeGuestEvent({ protocolVersion: 99, type: 'bridge.ready' })).toBeNull()
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
      editedAt: null, raw: {},
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
        sentAt: '2026-08-26T00:00:00Z', editedAt: null, raw: { unsupported: 1n },
      },
    })).toBeNull()
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

    const pending = nativeComposerBridge.send(context)
    const command = sent!
    handleNativeCommandResult(context.accountId, {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'command.result', requestId: command.requestId, command: command.type,
      contextRevision: 8, ok: true, platformMessageId: 'm-1',
    })
    await expect(pending).rejects.toThrow('过期或不匹配')
    unregister()
  })
})
