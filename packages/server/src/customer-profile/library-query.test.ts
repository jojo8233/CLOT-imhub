import { describe, expect, it } from 'vitest'
import {
  CustomerProfileCursorError,
  customerProfileFilterFingerprint,
  decodeCustomerProfileCursor,
  encodeCustomerProfileCursor,
  escapeCustomerProfileLikeLiteral,
} from './library-query.js'

describe('customer profile library query helpers', () => {
  it('把 LIKE 元字符转义成普通文字', () => {
    expect(escapeCustomerProfileLikeLiteral('50%_off\\code'))
      .toBe('50\\%\\_off\\\\code')
  })

  it('往返版本化游标但不保存原始查询词', () => {
    const fingerprint = customerProfileFilterFingerprint({
      q: 'Sensitive synthetic phrase',
      platform: 'telegram',
      accountId: null,
    })
    const cursor = encodeCustomerProfileCursor({
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint,
    })

    expect(cursor).not.toContain('Sensitive')
    expect(decodeCustomerProfileCursor(cursor, fingerprint)).toEqual({
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint,
    })
  })

  it('拒绝损坏、跨筛选和版本不支持的游标', () => {
    expect(() => decodeCustomerProfileCursor('bad', 'a'.repeat(64)))
      .toThrow(CustomerProfileCursorError)

    const cursor = encodeCustomerProfileCursor({
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'a'.repeat(64),
    })
    expect(() => decodeCustomerProfileCursor(cursor, 'b'.repeat(64)))
      .toThrow(CustomerProfileCursorError)

    const unsupported = Buffer.from(JSON.stringify({
      v: 2,
      snapshotAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      conversationId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'a'.repeat(64),
    }), 'utf8').toString('base64url')
    expect(() => decodeCustomerProfileCursor(unsupported, 'a'.repeat(64)))
      .toThrow(CustomerProfileCursorError)
  })
})
