import { describe, expect, it } from 'vitest'
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from '@im-hub/shared'
import { NativeControlRegistry } from './native-control-registry.js'

const now = Date.parse('2026-08-26T12:00:00.000Z')

function verification(accountId: string, externalId = '778899') {
  return {
    accountId,
    platform: 'telegram' as const,
    expectedPlatformAccountExternalId: externalId,
    expiresAt: '2026-08-26T12:05:00.000Z',
  }
}

describe('NativeControlRegistry', () => {
  it('只有 guest 身份与 grant 预期身份一致后才开放能力', () => {
    const registry = new NativeControlRegistry()
    expect(registry.configure(11, 'account-1', 'grant-1', verification('account-1'), now).state?.state)
      .toBe('waiting')
    expect(() => registry.requireGrant(11, 'account-1', now)).toThrow('核对')

    const decision = registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '778899',
    }, now)
    expect(decision.state?.state).toBe('ready')
    expect(registry.requireGrant(11, 'account-1', now)).toBe('grant-1')
  })

  it('身份不匹配时阻断并要求撤销 grant', () => {
    const registry = new NativeControlRegistry()
    registry.configure(11, 'account-1', 'grant-1', verification('account-1'), now)
    const decision = registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: 'other-user',
    }, now)
    expect(decision).toMatchObject({ forward: true, grantToRevoke: 'grant-1' })
    expect(decision.state).toMatchObject({ state: 'blocked' })
    expect(() => registry.requireGrant(11, 'account-1', now)).toThrow('账号不一致')
  })

  it('grant 过期后不能继续发送或代理请求', () => {
    const registry = new NativeControlRegistry()
    registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '778899',
    }, now)
    registry.configure(11, 'account-1', 'grant-1', verification('account-1'), now)
    const expiredAt = now + 5 * 60 * 1_000
    expect(() => registry.requireGrant(11, 'account-1', expiredAt)).toThrow('过期')
    expect(registry.stateFor(11, 'account-1', expiredAt)).toMatchObject({
      state: 'blocked',
      message: expect.stringContaining('过期'),
    })
  })

  it('不同 partition 的账号与 grant 不能串号', () => {
    const registry = new NativeControlRegistry()
    registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '111',
    }, now)
    registry.observeGuestEvent(22, 'account-2', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '222',
    }, now)
    registry.configure(11, 'account-1', 'grant-1', verification('account-1', '111'), now)
    registry.configure(22, 'account-2', 'grant-2', verification('account-2', '222'), now)
    expect(registry.requireGrant(11, 'account-1', now)).toBe('grant-1')
    expect(registry.requireGrant(22, 'account-2', now)).toBe('grant-2')
    expect(() => registry.requireGrant(11, 'account-2', now)).toThrow('尚未建立')
  })

  it('guest 退出账号会立即撤销控制能力', () => {
    const registry = new NativeControlRegistry()
    registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: '778899',
    }, now)
    registry.configure(11, 'account-1', 'grant-1', verification('account-1'), now)
    const decision = registry.observeGuestEvent(11, 'account-1', {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.signed-out',
    }, now)
    expect(decision.grantToRevoke).toBe('grant-1')
    expect(decision.state).toMatchObject({ state: 'blocked' })
    expect(() => registry.requireGrant(11, 'account-1', now)).toThrow('已退出')
  })
})
