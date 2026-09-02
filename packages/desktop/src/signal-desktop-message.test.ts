import { describe, expect, it } from 'vitest'
import { parseNativeGuestEvent } from './native-bridge-runtime.js'
import {
  normalizeSignalDesktopDelete,
  normalizeSignalDesktopEdit,
  normalizeSignalDesktopInbound,
  normalizeSignalDesktopOutgoing,
  normalizeSignalDesktopReaction,
  readSignalDesktopAci,
  SignalDesktopInboundError,
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
    )).toThrow('缺少稳定身份或发送时间')
  })

  it('图片无正文也生成最小媒体引用，不泄露路径、密钥或二进制数据', () => {
    const event = normalizeSignalDesktopInbound(
      model({ type: 'private' }, 'Alice'),
      model({
        id: 'local-image-id',
        type: 'incoming',
        sourceServiceId: '11111111-2222-3333-aaaa-555555555555',
        sent_at: 1_700_000_000_010,
        body: '',
        attachments: [{
          contentType: 'image/jpeg',
          fileName: 'photo.jpg',
          size: 99,
          path: 'private/local/path',
          localKey: 'must-not-cross-bridge',
          key: 'must-not-cross-bridge',
          data: new Uint8Array([1, 2, 3]),
        }],
      }),
      model({}, 'Alice'),
    )

    expect(event?.message).toMatchObject({
      body: '',
      mediaRefs: [{
        kind: 'image',
        remoteId: 'signal-desktop:local-image-id:attachment:0',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 99,
      }],
      raw: { source: 'signal-desktop', signalMessageId: 'local-image-id' },
    })
    expect(parseNativeGuestEvent(event)).toEqual(event)
    expect(JSON.stringify(event)).not.toContain('private/local/path')
    expect(JSON.stringify(event)).not.toContain('must-not-cross-bridge')
  })

  it('贴纸使用消息内的稳定槽位引用，不导出 packKey 或本机文件字段', () => {
    const event = normalizeSignalDesktopInbound(
      model({ type: 'private' }),
      model({
        id: 'local-sticker-id',
        type: 'incoming',
        sourceServiceId: 'sender',
        sent_at: 1_700_000_000_020,
        sticker: {
          packId: 'pack-id',
          stickerId: 7,
          packKey: 'must-not-cross-bridge',
          data: {
            contentType: 'image/webp', size: 123,
            path: 'private/sticker/path', localKey: 'private-key',
          },
        },
      }),
      null,
    )

    expect(event?.message.mediaRefs).toEqual([{
      kind: 'sticker',
      remoteId: 'signal-desktop:local-sticker-id:sticker',
      mimeType: 'image/webp',
      sizeBytes: 123,
    }])
    expect(JSON.stringify(event)).not.toContain('pack-id')
    expect(JSON.stringify(event)).not.toContain('private/sticker/path')
    expect(JSON.stringify(event)).not.toContain('private-key')
  })

  it('暂未支持的媒体与缺少稳定本地消息 id 的图片明确拒绝，不落半条 caption', () => {
    const base = {
      type: 'incoming', sourceServiceId: 'sender', sent_at: 1_700_000_000_030,
    }
    expect(() => normalizeSignalDesktopInbound(
      model({ type: 'private' }),
      model({
        ...base, id: 'local-video-id', body: 'video caption',
        attachments: [{ contentType: 'video/mp4', size: 42 }],
      }),
      null,
    )).toThrowError(expect.objectContaining<Partial<SignalDesktopInboundError>>({
      code: 'unsupported_signal_media',
    }))
    expect(() => normalizeSignalDesktopInbound(
      model({ type: 'private' }),
      model({
        ...base, body: '', attachments: [{ contentType: 'image/png', size: 42 }],
      }),
      null,
    )).toThrowError(expect.objectContaining<Partial<SignalDesktopInboundError>>({
      code: 'invalid_signal_media',
    }))
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

  it('纯文字出站使用本账号 ACI 与实际 sent_at，并且不导出本地消息或会话 id', () => {
    const event = normalizeSignalDesktopOutgoing(
      model({ serviceId: '99999999-2222-3333-AAAA-555555555555' }, 'Alice'),
      model({
        id: 'local-outgoing-id', conversationId: 'local-conversation-id',
        type: 'outgoing', sent_at: 1_700_000_000_000, body: 'Hello',
      }),
      '11111111-2222-3333-AAAA-555555555555',
    )

    expect(event).toMatchObject({
      eventId: 'signal-outgoing:11111111-2222-3333-aaaa-555555555555:1700000000000:initial',
      message: {
        platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
        platformMessageId: '11111111-2222-3333-aaaa-555555555555:1700000000000',
        direction: 'out', senderExternalId: '11111111-2222-3333-aaaa-555555555555',
        conversationDisplayName: 'Alice', body: 'Hello', mediaRefs: [],
        editedAt: null, raw: { source: 'signal-desktop' },
      },
    })
    expect(parseNativeGuestEvent(event)).toEqual(event)
    expect(JSON.stringify(event)).not.toContain('local-outgoing-id')
    expect(JSON.stringify(event)).not.toContain('local-conversation-id')
  })

  it('历史出站按当前编辑 revision 回填，媒体或非出站消息不扩张本轮边界', () => {
    const conversation = model({ groupId: 'Z3JvdXA=' }, '客服群')
    const edited = normalizeSignalDesktopOutgoing(
      conversation,
      model({
        type: 'outgoing', sent_at: 1_700_000_000_000,
        editMessageTimestamp: 1_700_000_001_000, body: 'Edited',
      }),
      '11111111-2222-3333-aaaa-555555555555',
    )
    expect(edited?.message).toMatchObject({
      platformConversationId: 'g:Z3JvdXA=',
      editedAt: '2023-11-14T22:13:21.000Z', body: 'Edited',
    })
    expect(normalizeSignalDesktopOutgoing(
      conversation,
      model({ type: 'outgoing', sent_at: 1, body: 'caption', attachments: [{}] }),
      '11111111-2222-3333-aaaa-555555555555',
    )).toBeNull()
    expect(normalizeSignalDesktopOutgoing(
      conversation,
      model({ type: 'incoming', sent_at: 1, body: 'incoming' }),
      '11111111-2222-3333-aaaa-555555555555',
    )).toBeNull()
  })

  it('编辑沿用原消息规范键，以编辑时间推进版本并允许清空正文', () => {
    const event = normalizeSignalDesktopEdit(
      model({ type: 'private' }, 'Alice'),
      model({
        id: 'local-edited-id', type: 'incoming',
        sourceServiceId: '11111111-2222-3333-AAAA-555555555555',
        sent_at: 1_700_000_000_000,
        editMessageTimestamp: 1_700_000_001_000,
        body: '',
      }),
      model({}, 'Alice'),
    )

    expect(event).toMatchObject({
      type: 'message.upsert',
      eventId: 'signal-edit:11111111-2222-3333-aaaa-555555555555:1700000000000:1700000001000',
      message: {
        platformMessageId: '11111111-2222-3333-aaaa-555555555555:1700000000000',
        body: '', editVersion: null,
        editedAt: '2023-11-14T22:13:21.000Z',
      },
    })
    expect(parseNativeGuestEvent(event)).toEqual(event)
  })

  it('为所有人删除只接受入站目标和匹配的原时间戳', () => {
    const message = model({
      type: 'incoming', sourceServiceId: 'sender', sent_at: 1_700_000_000_000,
    })
    const event = normalizeSignalDesktopDelete(message, {
      targetSentTimestamp: 1_700_000_000_000,
      deleteServerTimestamp: 1_700_000_002_000,
      deleteSentByAci: 'not-exported',
    })
    expect(event).toEqual({
      protocolVersion: 3,
      type: 'message.deleted',
      eventId: 'signal-delete:sender:1700000000000:1700000002000',
      platformMessageId: 'sender:1700000000000',
      deletedAt: '2023-11-14T22:13:22.000Z',
    })
    expect(JSON.stringify(event)).not.toContain('not-exported')
    expect(normalizeSignalDesktopDelete(model({ type: 'outgoing' }), {})).toBeNull()
    expect(() => normalizeSignalDesktopDelete(message, {
      targetSentTimestamp: 1_700_000_000_001,
      deleteServerTimestamp: 1_700_000_002_000,
    })).toThrowError(expect.objectContaining<Partial<SignalDesktopInboundError>>({
      code: 'invalid_signal_delete',
    }))
  })

  it('回应使用目标规范键和回应者平台身份，删除回应生成墓碑', () => {
    const target = model({ type: 'outgoing' })
    const reactor = model({ serviceId: '99999999-2222-3333-AAAA-555555555555' })
    const reaction = {
      targetAuthorAci: '11111111-2222-3333-AAAA-555555555555',
      targetTimestamp: 1_700_000_000_000,
      timestamp: 1_700_000_003_000,
      emoji: '👍', remove: true,
      fromId: 'local-conversation-id-must-not-cross',
    }
    const event = normalizeSignalDesktopReaction(
      target, reaction, reactor, '11111111-2222-3333-aaaa-555555555555',
    )
    expect(event).toEqual({
      protocolVersion: 3,
      type: 'message.reaction',
      eventId: 'signal-reaction:99999999-2222-3333-aaaa-555555555555:11111111-2222-3333-aaaa-555555555555:1700000000000:1700000003000',
      targetPlatformMessageId: '11111111-2222-3333-aaaa-555555555555:1700000000000',
      reactorExternalId: '99999999-2222-3333-aaaa-555555555555',
      emoji: null,
      reactedAt: '2023-11-14T22:13:23.000Z',
    })
    expect(parseNativeGuestEvent(event)).toEqual(event)
    expect(JSON.stringify(event)).not.toContain('local-conversation-id-must-not-cross')

    expect(normalizeSignalDesktopReaction(
      target,
      { ...reaction, remove: false },
      model({ serviceId: '11111111-2222-3333-AAAA-555555555555' }),
      '11111111-2222-3333-aaaa-555555555555',
    )).toBeNull()
  })
})
