import { describe, expect, it } from 'vitest'
import { nativeControlGrantIsUsable } from './native-control-grant.js'

describe('native control grant validity', () => {
  it('只把未阻断且尚未过期的授权视为可用', () => {
    const now = Date.parse('2026-09-02T00:00:00.000Z')
    const futureExpiry = '2026-09-02T00:00:01.000Z'
    const currentExpiry = '2026-09-02T00:00:00.000Z'
    const expiredExpiry = '2026-09-01T23:59:59.000Z'

    expect(nativeControlGrantIsUsable({ state: 'ready', expiresAt: futureExpiry }, now)).toBe(true)
    expect(nativeControlGrantIsUsable({ state: 'waiting', expiresAt: futureExpiry }, now)).toBe(true)
    expect(nativeControlGrantIsUsable({ state: 'blocked', expiresAt: futureExpiry }, now)).toBe(false)
    expect(nativeControlGrantIsUsable({ state: 'ready', expiresAt: currentExpiry }, now)).toBe(false)
    expect(nativeControlGrantIsUsable({ state: 'ready', expiresAt: expiredExpiry }, now)).toBe(false)
    expect(nativeControlGrantIsUsable({ state: 'waiting', expiresAt: expiredExpiry }, now)).toBe(false)
    expect(nativeControlGrantIsUsable({ state: 'ready', expiresAt: 'not-a-date' }, now)).toBe(false)
    expect(nativeControlGrantIsUsable({ state: 'waiting', expiresAt: null }, now)).toBe(false)
  })
})
