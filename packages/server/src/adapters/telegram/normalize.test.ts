import { describe, expect, it } from 'vitest'
import fixture from './fixtures/text-message.json' with { type: 'json' }
import { normalizeTelegramMessage, normalizeTelegramStoredMessage } from './normalize.js'

describe('normalizeTelegramMessage', () => {
  it('把 TDLib updateNewMessage 转成 NormalizedMessage', () => {
    expect(normalizeTelegramMessage(fixture, 'acc-1')).toMatchObject({
      platform: 'telegram',
      accountId: 'acc-1',
      platformConversationId: '-1001234567890',
      platformMessageId: '-1001234567890:1',
      direction: 'in',
      senderExternalId: '777000',
      body: 'Hello, is this still available?',
      mediaRefs: [],
    })
  })

  it('date 是 Unix 秒，要转成毫秒精度的 Date', () => {
    expect(normalizeTelegramMessage(fixture, 'acc-1')!.sentAt.getTime()).toBe(1756000000 * 1000)
  })

  it('把 getMessage 返回的已编辑文本转换成带 editedAt 的 NormalizedMessage', () => {
    const edited = {
      ...fixture.message,
      edit_date: 1756000060,
      content: {
        ...fixture.message.content,
        text: { ...fixture.message.content.text, text: 'Edited body' },
      },
    }

    expect(normalizeTelegramStoredMessage(edited, 'acc-1')).toMatchObject({
      platformMessageId: '-1001234567890:1',
      body: 'Edited body',
      editedAt: new Date(1756000060 * 1000),
      editVersion: null,
      raw: edited,
    })
  })

  it('规范化媒体 caption、媒体语义形状和同会话回复键', () => {
    const file = (id: number, size: number, remoteId: string) => ({
      _: 'file',
      id,
      size,
      expected_size: size,
      remote: { _: 'remoteFile', id: remoteId, unique_id: `unique-${id}` },
    })
    const normalizeContent = (content: unknown) => normalizeTelegramStoredMessage({
      ...fixture.message,
      reply_to: {
        _: 'messageReplyToMessage',
        chat_id: fixture.message.chat_id,
        message_id: 2 * 2 ** 20,
      },
      content,
    }, 'acc-1')

    const photo = normalizeContent({
      _: 'messagePhoto',
      caption: { _: 'formattedText', text: 'photo caption', entities: [] },
      photo: {
        _: 'photo',
        sizes: [{ _: 'photoSize', photo: file(1, 120, 'photo-remote') }],
      },
    })
    expect(photo).toMatchObject({
      body: 'photo caption',
      replyToPlatformMessageId: '-1001234567890:2',
    })
    expect(photo?.mediaRefs).toEqual([{ kind: 'image', remoteId: 'photo-remote' }])

    expect(normalizeContent({
      _: 'messageVideo',
      caption: { _: 'formattedText', text: 'video caption', entities: [] },
      video: {
        _: 'video', file_name: 'clip.mp4', mime_type: 'video/mp4', video: file(2, 240, 'video-remote'),
      },
    })?.mediaRefs).toEqual([{
      kind: 'video', remoteId: 'video-remote', fileName: 'clip.mp4',
      mimeType: 'video/mp4', sizeBytes: 240,
    }])

    expect(normalizeContent({
      _: 'messageAudio',
      caption: { _: 'formattedText', text: '', entities: [] },
      audio: {
        _: 'audio', file_name: 'track.mp3', mime_type: 'audio/mpeg', audio: file(3, 360, 'audio-remote'),
      },
    })?.mediaRefs).toEqual([{
      kind: 'audio', remoteId: 'audio-remote', fileName: 'track.mp3',
      mimeType: 'audio/mpeg', sizeBytes: 360,
    }])

    expect(normalizeContent({
      _: 'messageVoiceNote',
      caption: { _: 'formattedText', text: '', entities: [] },
      voice_note: { _: 'voiceNote', mime_type: 'audio/ogg', voice: file(4, 480, 'voice-remote') },
    })?.mediaRefs).toEqual([{
      kind: 'audio', remoteId: 'voice-remote', mimeType: 'audio/ogg', sizeBytes: 480,
    }])

    expect(normalizeContent({
      _: 'messageDocument',
      caption: { _: 'formattedText', text: '', entities: [] },
      document: {
        _: 'document', file_name: 'invoice.pdf', mime_type: 'application/pdf',
        document: file(5, 600, 'document-remote'),
      },
    })?.mediaRefs).toEqual([{
      kind: 'file', remoteId: 'document-remote', fileName: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 600,
    }])

    expect(normalizeContent({
      _: 'messageSticker',
      sticker: { _: 'sticker', id: 'sticker-id', sticker: file(6, 720, 'sticker-remote') },
    })?.mediaRefs).toEqual([{ kind: 'sticker', remoteId: 'sticker-remote' }])
  })

  it('不把跨会话回复猜成当前会话的规范键', () => {
    const crossChatReply = {
      ...fixture.message,
      reply_to: {
        _: 'messageReplyToMessage',
        chat_id: 12345,
        message_id: 2 * 2 ** 20,
      },
    }

    expect(normalizeTelegramStoredMessage(crossChatReply, 'acc-1')?.replyToPlatformMessageId)
      .toBeNull()
  })

  it('is_outgoing 为 true 时方向是 out', () => {
    const outgoing = { ...fixture, message: { ...fixture.message, is_outgoing: true } }
    expect(normalizeTelegramMessage(outgoing, 'acc-1')!.direction).toBe('out')
  })

  it('messageSenderChat 取 chat_id 作为发送者', () => {
    const fromChat = {
      ...fixture,
      message: { ...fixture.message, sender_id: { _: 'messageSenderChat', chat_id: -100999 } },
    }
    expect(normalizeTelegramMessage(fromChat, 'acc-1')!.senderExternalId).toBe('-100999')
  })

  it('非 updateNewMessage 的 update 返回 null', () => {
    expect(normalizeTelegramMessage({ _: 'updateUserStatus' }, 'acc-1')).toBeNull()
  })

  it('不支持的消息内容类型返回 null，不抛错', () => {
    const sticker = { ...fixture, message: { ...fixture.message, content: { _: 'messageSticker' } } }
    expect(normalizeTelegramMessage(sticker, 'acc-1')).toBeNull()
  })

  it('结构残缺的 update 返回 null，不抛错', () => {
    expect(normalizeTelegramMessage({ _: 'updateNewMessage' }, 'acc-1')).toBeNull()
    expect(normalizeTelegramMessage(null, 'acc-1')).toBeNull()
    expect(normalizeTelegramMessage(undefined, 'acc-1')).toBeNull()
    expect(normalizeTelegramMessage('not an object', 'acc-1')).toBeNull()
  })

  it('messageText 但 text 字段缺失时返回 null', () => {
    const broken = { ...fixture, message: { ...fixture.message, content: { _: 'messageText' } } }
    expect(normalizeTelegramMessage(broken, 'acc-1')).toBeNull()
  })

  it('保留原始 update 到 raw 字段', () => {
    expect(normalizeTelegramMessage(fixture, 'acc-1')!.raw).toEqual(fixture)
  })

  it('platformMessageId 与 platformConversationId 都是字符串，不是数字', () => {
    const m = normalizeTelegramMessage(fixture, 'acc-1')!
    expect(typeof m.platformMessageId).toBe('string')
    expect(typeof m.platformConversationId).toBe('string')
  })

  it('TDLib 尚未确认的本地 id 进入临时命名空间', () => {
    const localId = 1_048_578
    const local = { ...fixture, message: { ...fixture.message, id: localId } }

    expect(normalizeTelegramMessage(local, 'acc-1')?.platformMessageId)
      .toBe(`-1001234567890:temp:tdlib:${localId}`)
  })

  it('无效 TDLib message id 返回 null，不让异常逃出 update 回调', () => {
    const invalid = { ...fixture, message: { ...fixture.message, id: 0 } }
    expect(normalizeTelegramMessage(invalid, 'acc-1')).toBeNull()
  })

  it('未知的发送者类型返回 null，不产生 undefined 字符串', () => {
    const weird = {
      ...fixture,
      message: { ...fixture.message, sender_id: { _: 'messageSenderSomethingNew', foo: 1 } },
    }
    expect(normalizeTelegramMessage(weird, 'acc-1')).toBeNull()
  })
})
