import { describe, expect, it } from 'vitest'
import fixture from './fixtures/text-message.json' with { type: 'json' }
import { normalizeTelegramMessage } from './normalize.js'

describe('normalizeTelegramMessage', () => {
  it('把 TDLib updateNewMessage 转成 NormalizedMessage', () => {
    expect(normalizeTelegramMessage(fixture, 'acc-1')).toMatchObject({
      platform: 'telegram',
      accountId: 'acc-1',
      platformConversationId: '-1001234567890',
      platformMessageId: '1048576',
      direction: 'in',
      senderExternalId: '777000',
      body: 'Hello, is this still available?',
      mediaRefs: [],
    })
  })

  it('date 是 Unix 秒，要转成毫秒精度的 Date', () => {
    expect(normalizeTelegramMessage(fixture, 'acc-1')!.sentAt.getTime()).toBe(1756000000 * 1000)
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
})
