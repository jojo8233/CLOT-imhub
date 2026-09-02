import { describe, expect, it } from 'vitest'
import {
  isSignalConversationId,
  normalizeSignalAci,
  normalizeSignalPersonId,
  parseSignalMessageKey,
  signalDirectConversationId,
  signalGroupConversationId,
  signalMessageKey,
} from './signal.js'

describe('Signal canonical identity', () => {
  it('统一 UUID 大小写并让 Desktop/CLI 生成同一个消息键', () => {
    const upper = '11111111-2222-3333-AAAA-555555555555'
    const lower = '11111111-2222-3333-aaaa-555555555555'
    expect(normalizeSignalPersonId(upper)).toBe(lower)
    expect(signalMessageKey(upper, 1_700_000_000_000))
      .toBe(`${lower}:1700000000000`)
    expect(normalizeSignalAci(` ${upper} `)).toBe(lower)
    expect(() => normalizeSignalAci('not-an-aci')).toThrow('UUID')
  })

  it('消息键从最后一个冒号拆分，兼容未来带命名空间的发送者 id', () => {
    expect(parseSignalMessageKey('aci:person:1700000000000')).toEqual({
      senderId: 'aci:person',
      sentAtMs: 1_700_000_000_000,
    })
  })

  it('只接受规范会话 id 和安全整数时间戳', () => {
    expect(signalDirectConversationId('ABC')).toBe('u:ABC')
    expect(signalGroupConversationId(' Z3JvdXA= ')).toBe('g:Z3JvdXA=')
    expect(isSignalConversationId('u:ABC')).toBe(true)
    expect(isSignalConversationId('g:Z3JvdXA=')).toBe(true)
    expect(isSignalConversationId('ABC')).toBe(false)
    expect(parseSignalMessageKey('person:not-a-time')).toBeNull()
    expect(() => signalMessageKey('person', -1)).toThrow()
  })
})
