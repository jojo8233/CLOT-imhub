import { describe, expect, it } from 'vitest'
import {
  isTelegramMessageKeyForChat,
  parseTelegramMessageKey,
  telegramMessageKeyFromMtp,
  telegramMessageKeyFromTdlib,
  telegramServerMessageKey,
} from './telegram-message-id.js'

const CHAT_ID = '-1001234567890'

describe('Telegram canonical message id', () => {
  it('把 TDLib 与 MTProto 的同一条服务器消息归一成同一个键', () => {
    const serverMessageId = 123
    const tdlibMessageId = BigInt(serverMessageId) << 20n

    expect(telegramMessageKeyFromTdlib(CHAT_ID, tdlibMessageId))
      .toBe(`${CHAT_ID}:${serverMessageId}`)
    expect(telegramMessageKeyFromMtp(CHAT_ID, serverMessageId))
      .toBe(`${CHAT_ID}:${serverMessageId}`)
  })

  it('TDLib 本地 id 与 telegram-tt 小数 id 使用带来源的临时命名空间', () => {
    const tdlibLocalId = (123n << 20n) | 2n

    expect(telegramMessageKeyFromTdlib(CHAT_ID, tdlibLocalId))
      .toBe(`${CHAT_ID}:temp:tdlib:${tdlibLocalId}`)
    expect(telegramMessageKeyFromMtp(CHAT_ID, '123.000001'))
      .toBe(`${CHAT_ID}:temp:telegram-tt:123.000001`)
  })

  it('解析规范键时保留 chat、种类和来源', () => {
    expect(parseTelegramMessageKey(`${CHAT_ID}:456`)).toEqual({
      chatId: CHAT_ID,
      kind: 'server',
      serverMessageId: '456',
    })
    expect(parseTelegramMessageKey(`${CHAT_ID}:temp:tdlib:987654321`)).toEqual({
      chatId: CHAT_ID,
      kind: 'temporary',
      source: 'tdlib',
      localMessageId: '987654321',
    })
  })

  it('拒绝跨 chat、畸形和越界服务器 id', () => {
    expect(isTelegramMessageKeyForChat(`${CHAT_ID}:456`, CHAT_ID)).toBe(true)
    expect(isTelegramMessageKeyForChat(`${CHAT_ID}:456`, '-100999')).toBe(false)
    expect(parseTelegramMessageKey('chat-a:456')).toBeNull()
    expect(parseTelegramMessageKey(`${CHAT_ID}:0`)).toBeNull()
    expect(parseTelegramMessageKey(`${CHAT_ID}:2147483648`)).toBeNull()
    expect(() => telegramServerMessageKey(CHAT_ID, 0)).toThrow('server message id')
  })

  it('拒绝把无效 TDLib id 或指数格式本地 id 静默规范化', () => {
    expect(() => telegramMessageKeyFromTdlib(CHAT_ID, 0)).toThrow('TDLib message id')
    expect(() => telegramMessageKeyFromTdlib(CHAT_ID, Number.MAX_SAFE_INTEGER + 1))
      .toThrow('safe integer')
    expect(() => telegramMessageKeyFromMtp(CHAT_ID, '1e-7')).toThrow('MTProto message id')
    expect(() => telegramMessageKeyFromMtp(CHAT_ID, '-0.0')).toThrow('MTProto message id')
  })
})
