import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { signSession } from './session.js'
import {
  signInitialPasswordSetup,
  verifyInitialPasswordSetup,
} from './initial-password.js'

const secret = 'test-secret-at-least-16-chars'

describe('initial password setup token', () => {
  it('签发后还原用户和 session version', async () => {
    const token = await signInitialPasswordSetup({
      userId: 'u1',
      sessionVersion: 7,
    }, secret)

    expect(await verifyInitialPasswordSetup(token, secret)).toEqual({
      userId: 'u1',
      sessionVersion: 7,
    })
  })

  it('普通 session token 不能冒充首次改密凭证', async () => {
    const token = await signSession({ userId: 'u1', sessionVersion: 1 }, secret)

    await expect(verifyInitialPasswordSetup(token, secret)).rejects.toThrow()
  })

  it('过期 setup token 被拒绝', async () => {
    const token = await new SignJWT({
      purpose: 'initial_password',
      userId: 'u1',
      sessionVersion: 1,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'im-hub-initial-password+jwt' })
      .setIssuedAt()
      .setExpirationTime('-1s')
      .sign(new TextEncoder().encode(secret))

    await expect(verifyInitialPasswordSetup(token, secret)).rejects.toThrow()
  })
})
