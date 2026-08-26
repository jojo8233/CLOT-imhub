import { describe, expect, it } from 'vitest'
import { signNativeControlGrant, verifyNativeControlGrant } from './native-control-grant.js'

const secret = 'native-control-grant-test-secret-32-chars'

describe('native control grant', () => {
  it('绑定用户、账号、平台身份、版本与五分钟有效期', async () => {
    const now = new Date()
    const { grant, claims } = await signNativeControlGrant({
      userId: 'user-1',
      accountId: 'account-1',
      platform: 'telegram',
      expectedPlatformAccountExternalId: '778899',
      controlVersion: 3,
      now,
    }, secret)
    expect(claims.expiresAt.getTime() - Math.floor(now.getTime() / 1_000) * 1_000)
      .toBe(5 * 60 * 1_000)
    await expect(verifyNativeControlGrant(grant, secret)).resolves.toMatchObject({
      userId: 'user-1',
      accountId: 'account-1',
      platform: 'telegram',
      expectedPlatformAccountExternalId: '778899',
      controlVersion: 3,
    })
  })

  it('密钥不符或过期时拒绝', async () => {
    const { grant } = await signNativeControlGrant({
      userId: 'user-1',
      accountId: 'account-1',
      platform: 'telegram',
      expectedPlatformAccountExternalId: '778899',
      controlVersion: 1,
      now: new Date('2000-01-01T00:00:00.000Z'),
    }, secret)
    await expect(verifyNativeControlGrant(grant, 'different-native-control-secret-32')).rejects.toThrow()
    await expect(verifyNativeControlGrant(grant, secret)).rejects.toThrow()
  })
})
