import { describe, expect, it } from 'vitest'
import { signSession, verifySession } from './session.js'

const secret = 'test-secret-at-least-16-chars'

describe('session', () => {
  it('签发后能还原出 claims', async () => {
    const token = await signSession({ userId: 'u1', role: 'manager' }, secret)
    expect(await verifySession(token, secret)).toEqual({ userId: 'u1', role: 'manager' })
  })

  it('密钥不对时校验失败', async () => {
    const token = await signSession({ userId: 'u1', role: 'agent' }, secret)
    await expect(verifySession(token, 'another-secret-16chars')).rejects.toThrow()
  })

  it('伪造的 token 校验失败', async () => {
    await expect(verifySession('not.a.jwt', secret)).rejects.toThrow()
  })
})
