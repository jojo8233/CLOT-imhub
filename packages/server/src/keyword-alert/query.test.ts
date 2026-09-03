import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  KeywordAlertCursorError,
  decodeKeywordAlertCursor,
  encodeKeywordAlertCursor,
  keywordAlertFilterFingerprint,
} from './query.js'

const actorUserId = '00000000-0000-4000-8000-000000000001'
const alertId = '00000000-0000-4000-8000-000000000002'

function fingerprint(overrides: {
  actorUserId?: string
  teamIds?: string[]
  status?: 'pending' | 'acknowledged' | 'all'
  severity?: 'normal' | 'important' | 'urgent' | null
  platform?: 'telegram' | 'signal' | 'zoom' | 'whatsapp' | null
  accountId?: string | null
} = {}): string {
  return keywordAlertFilterFingerprint({
    actorUserId: overrides.actorUserId ?? actorUserId,
    scope: { kind: 'teams', teamIds: overrides.teamIds ?? ['b', 'a'] },
    status: overrides.status ?? 'pending',
    severity: overrides.severity === undefined ? 'urgent' : overrides.severity,
    platform: overrides.platform === undefined ? 'telegram' : overrides.platform,
    accountId: overrides.accountId === undefined ? null : overrides.accountId,
  })
}

describe('keyword alert cursor', () => {
  it('只编码版本、位置和 SHA-256 筛选指纹，不暴露原始筛选值', () => {
    const filterFingerprint = fingerprint()
    const cursor = encodeKeywordAlertCursor({
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: filterFingerprint,
    })

    expect(filterFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(cursor).not.toContain('telegram')
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: filterFingerprint,
    })
    expect(decodeKeywordAlertCursor(cursor, filterFingerprint)).toEqual({
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: filterFingerprint,
    })
  })

  it('team id 排序后再计算指纹，同一 scope 的顺序变化不使游标失效', () => {
    expect(fingerprint({ teamIds: ['b', 'a'] })).toBe(fingerprint({ teamIds: ['a', 'b'] }))
  })

  it.each([
    ['actor', fingerprint({ actorUserId: '00000000-0000-4000-8000-000000000003' })],
    ['status', fingerprint({ status: 'all' })],
    ['severity', fingerprint({ severity: 'normal' })],
    ['platform', fingerprint({ platform: 'signal' })],
    ['account', fingerprint({ accountId: '00000000-0000-4000-8000-000000000004' })],
    ['team scope', fingerprint({ teamIds: ['a', 'c'] })],
  ])('拒绝跨 %s 复用游标', (_label, otherFingerprint) => {
    const expectedFingerprint = fingerprint()
    const cursor = encodeKeywordAlertCursor({
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: expectedFingerprint,
    })

    expect(() => decodeKeywordAlertCursor(cursor, otherFingerprint))
      .toThrow(KeywordAlertCursorError)
  })

  it.each([
    ['not-base64url'],
    [Buffer.from('{bad json', 'utf8').toString('base64url')],
    [Buffer.from(JSON.stringify({
      v: 2,
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: fingerprint(),
    }), 'utf8').toString('base64url')],
    [Buffer.from(JSON.stringify({
      v: 1,
      createdAt: 'not-a-date',
      alertId,
      fingerprint: fingerprint(),
    }), 'utf8').toString('base64url')],
    [Buffer.from(JSON.stringify({
      v: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId: 'not-a-uuid',
      fingerprint: fingerprint(),
    }), 'utf8').toString('base64url')],
  ])('拒绝 malformed cursor %#', (cursor) => {
    expect(() => decodeKeywordAlertCursor(cursor, fingerprint()))
      .toThrow(KeywordAlertCursorError)
  })

  it('拒绝会被宽松 base64 解码器忽略的非法字符', () => {
    const expectedFingerprint = fingerprint()
    const cursor = encodeKeywordAlertCursor({
      createdAt: '2026-09-03T00:00:00.000Z',
      alertId,
      fingerprint: expectedFingerprint,
    })

    expect(() => decodeKeywordAlertCursor(`${cursor}!`, expectedFingerprint))
      .toThrow(KeywordAlertCursorError)
  })
})
