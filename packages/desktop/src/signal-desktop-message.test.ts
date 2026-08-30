import { describe, expect, it } from 'vitest'
import {
  normalizeSignalDesktopInbound,
  readSignalDesktopAci,
  type SignalDesktopModelLike,
} from './signal-desktop-message.js'

function model(attributes: Record<string, unknown>, title?: string): SignalDesktopModelLike {
  return {
    attributes,
    get: key => attributes[key],
    ...(title ? { getTitle: () => title } : {}),
  }
}

describe('normalizeSignalDesktopInbound', () => {
  it('优先从 Signal 8.25 self conversation 读取 ACI，并只接受 UUID', () => {
    const aci = '11111111-2222-3333-AAAA-555555555555'
    expect(readSignalDesktopAci({
      ConversationController: {
        getOurConversationOrThrow: () => ({ getAci: () => aci }),
      },
      storage: { user: { getAci: () => 'legacy-value-must-not-win' } },
    })).toBe(aci.toLowerCase())
    expect(readSignalDesktopAci({
      ConversationController: {
        getOurConversationOrThrow: () => ({ getAci: () => 'not-an-aci' }),
      },
    })).toBeNull()
  })

  it('生成与 signal-cli 一致的入站单聊消息键', () => {
    const event = normalizeSignalDesktopInbound(
      model({ type: 'private' }, 'Alice'),
      model({
        id: 'local-message-id',
        type: 'incoming',
        sourceServiceId: '11111111-2222-3333-AAAA-555555555555',
        sent_at: 1_700_000_000_000,
        received_at_ms: 1_700_000_000_123,
        body: 'hello',
      }),
      model({}, 'Alice'),
    )
    expect(event).toMatchObject({
      eventId: 'signal-inbound:11111111-2222-3333-aaaa-555555555555:1700000000000',
      message: {
        platformConversationId: 'u:11111111-2222-3333-aaaa-555555555555',
        platformMessageId: '11111111-2222-3333-aaaa-555555555555:1700000000000',
        direction: 'in',
        senderDisplayName: 'Alice',
        conversationDisplayName: 'Alice',
        body: 'hello',
      },
    })
  })

  it('群会话使用 groupId，发言人和群名保持分离', () => {
    const event = normalizeSignalDesktopInbound(
      model({ type: 'group', groupId: 'Z3JvdXA=' }, '客服群'),
      model({
        type: 'incoming', sourceServiceId: 'sender-aci',
        sent_at: 1_700_000_000_000, body: '群消息',
      }),
      model({}, 'Alice'),
    )
    expect(event?.message).toMatchObject({
      platformConversationId: 'g:Z3JvdXA=',
      senderExternalId: 'sender-aci',
      senderDisplayName: 'Alice',
      conversationDisplayName: '客服群',
    })
  })

  it('忽略出站和空正文，但入站文字缺稳定身份时明确失败', () => {
    const conversation = model({ type: 'private' })
    expect(normalizeSignalDesktopInbound(
      conversation,
      model({ type: 'outgoing', body: 'sent', sent_at: 1 }),
      null,
    )).toBeNull()
    expect(normalizeSignalDesktopInbound(
      conversation,
      model({ type: 'incoming', body: '', sent_at: 1, sourceServiceId: 'sender' }),
      null,
    )).toBeNull()
    expect(() => normalizeSignalDesktopInbound(
      conversation,
      model({ type: 'incoming', body: 'missing sender', sent_at: 1 }),
      null,
    )).toThrow('stable sender')
  })

  it('raw 只保留非敏感定位事实，不复制整条 Signal 模型', () => {
    const event = normalizeSignalDesktopInbound(
      model({ type: 'private' }),
      model({
        id: 'local-id', type: 'incoming', sourceServiceId: 'sender',
        sent_at: 10, received_at_ms: 11, body: 'secret text', extra: 'not copied',
      }),
      null,
    )
    expect(event?.message.raw).toEqual({
      source: 'signal-desktop', signalMessageId: 'local-id', receivedAtMs: 11,
    })
  })
})
