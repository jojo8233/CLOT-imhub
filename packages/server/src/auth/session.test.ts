import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { signNativeControlGrant } from './native-control-grant.js'
import { signInitialPasswordSetup } from './initial-password.js'
import { signSession, verifySession } from './session.js'

const secret = 'test-secret-at-least-16-chars'

describe('session', () => {
  it('签发后能还原出 claims', async () => {
    const token = await signSession({ userId: 'u1', sessionVersion: 4 }, secret)
    expect(await verifySession(token, secret)).toEqual({ userId: 'u1', sessionVersion: 4 })
  })

  it('密钥不对时校验失败', async () => {
    const token = await signSession({ userId: 'u1', sessionVersion: 1 }, secret)
    await expect(verifySession(token, 'another-secret-16chars')).rejects.toThrow()
  })

  it('伪造的 token 校验失败', async () => {
    await expect(verifySession('not.a.jwt', secret)).rejects.toThrow()
  })

  it('签名有效但 payload 缺 userId 时拒绝', async () => {
    const bad = await new SignJWT({ kind: 'session', notUserId: 'x' })
      .setProtectedHeader({ alg: 'HS256', typ: 'im-hub-session+jwt' })
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(new TextEncoder().encode(secret))
    await expect(verifySession(bad, secret)).rejects.toThrow()
  })

  it('过期的 token 被拒绝', async () => {
    const expired = await new SignJWT({ kind: 'session', userId: 'u1', sessionVersion: 1 })
      .setProtectedHeader({ alg: 'HS256', typ: 'im-hub-session+jwt' })
      .setIssuedAt()
      .setExpirationTime('-1s')
      .sign(new TextEncoder().encode(secret))
    await expect(verifySession(expired, secret)).rejects.toThrow()
  })

  it('上线前已签发的无类型 session 被拒绝并要求重新登录', async () => {
    const legacy = await new SignJWT({ userId: 'u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(new TextEncoder().encode(secret))
    await expect(verifySession(legacy, secret)).rejects.toThrow()
  })

  it('签名有效但 payload 缺 sessionVersion 时拒绝', async () => {
    const bad = await new SignJWT({ kind: 'session', userId: 'u1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'im-hub-session+jwt' })
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(new TextEncoder().encode(secret))
    await expect(verifySession(bad, secret)).rejects.toThrow()
  })

  it('首次改密 setup token 不能冒充普通会话', async () => {
    const setupToken = await signInitialPasswordSetup({
      userId: 'u1',
      sessionVersion: 1,
    }, secret)
    await expect(verifySession(setupToken, secret)).rejects.toThrow()
  })

  it('native control grant 不能冒充用户会话', async () => {
    const { grant } = await signNativeControlGrant({
      userId: 'u1',
      accountId: 'a1',
      platform: 'telegram',
      expectedPlatformAccountExternalId: '778899',
      controlVersion: 1,
    }, secret)
    await expect(verifySession(grant, secret)).rejects.toThrow()
  })
})
