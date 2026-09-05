import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../../db/types.js'
import type { MessageRouteDeps } from './messages.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'organization-auth-route-test-secret-32'

let app: FastifyInstance
let db: typeof import('../../db/client.js').db
let hashPassword: typeof import('../../auth/password.js').hashPassword
let verifyPassword: typeof import('../../auth/password.js').verifyPassword
let verifySession: typeof import('../../auth/session.js').verifySession
let hub: InstanceType<typeof import('../ws.js').WsHub>

const insertedUserIds: string[] = []

async function insertUser(input: {
  password: string
  mustChangePassword?: boolean
  temporaryPasswordExpiresAt?: Date | null
  sessionVersion?: number
}): Promise<{ id: string; email: string }> {
  const id = randomUUID()
  const email = `auth-m4-${id}@example.test`
  insertedUserIds.push(id)
  await db.insertInto('users').values({
    id,
    email,
    display_name: 'Synthetic auth user',
    role: 'agent',
    password_hash: await hashPassword(input.password),
    must_change_password: input.mustChangePassword ?? false,
    temporary_password_expires_at: input.temporaryPasswordExpiresAt ?? null,
    session_version: input.sessionVersion ?? 1,
  }).execute()
  return { id, email }
}

async function login(email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  })
}

beforeAll(async () => {
  const serverModule = await import('../server.js')
  const wsModule = await import('../ws.js')
  const dbModule = await import('../../db/client.js')
  const passwordModule = await import('../../auth/password.js')
  const sessionModule = await import('../../auth/session.js')
  db = dbModule.db
  hashPassword = passwordModule.hashPassword
  verifyPassword = passwordModule.verifyPassword
  verifySession = sessionModule.verifySession
  hub = new wsModule.WsHub()
  app = await serverModule.buildServer({} as MessageRouteDeps, hub)
})

afterEach(async () => {
  if (insertedUserIds.length === 0) return
  await db.deleteFrom('users').where('id', 'in', insertedUserIds.splice(0)).execute()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('organization authentication routes', () => {
  it('普通密码登录返回带数据库 session version 的正式会话', async () => {
    const user = await insertUser({ password: 'synthetic-normal-password' })

    const response = await login(user.email, 'synthetic-normal-password')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      kind: 'authenticated',
      user: { id: user.id, role: 'agent', displayName: 'Synthetic auth user' },
    })
    const body = response.json<{ token: string }>()
    expect(await verifySession(body.token, process.env.JWT_SECRET ?? '')).toEqual({
      userId: user.id,
      sessionVersion: 1,
    })
  })

  it('有效临时密码只返回 setup token，不返回普通 token', async () => {
    const user = await insertUser({
      password: 'synthetic-temporary-password',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })

    const response = await login(user.email, 'synthetic-temporary-password')

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      kind: 'password_change_required',
      setupToken: expect.any(String),
      user: { id: user.id, role: 'agent' },
    })
    expect(response.json()).not.toHaveProperty('token')
  })

  it('过期临时密码使用统一无效凭据响应', async () => {
    const user = await insertUser({
      password: 'synthetic-expired-password',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() - 60_000),
    })

    const response = await login(user.email, 'synthetic-expired-password')

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'invalid credentials' })
  })

  it('首次改密要求 12 至 128 个字符且不 trim', async () => {
    const tooShort = await insertUser({
      password: 'temporary-short-test',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })
    const shortLogin = await login(tooShort.email, 'temporary-short-test')
    const shortSetup = shortLogin.json<{ setupToken: string }>().setupToken
    const shortResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/initial-password/complete',
      headers: { authorization: `InitialPassword ${shortSetup}` },
      payload: { newPassword: '12345678901' },
    })
    expect(shortResponse.statusCode).toBe(400)

    const boundary = await insertUser({
      password: 'temporary-boundary-test',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })
    const boundaryLogin = await login(boundary.email, 'temporary-boundary-test')
    const boundarySetup = boundaryLogin.json<{ setupToken: string }>().setupToken
    const twelveCharacters = ' 123456789 '
    expect(twelveCharacters).toHaveLength(11)
    const exactTwelveCharacters = `${twelveCharacters}x`
    const boundaryResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/initial-password/complete',
      headers: { authorization: `InitialPassword ${boundarySetup}` },
      payload: { newPassword: exactTwelveCharacters },
    })
    expect(boundaryResponse.statusCode).toBe(200)
    const stored = await db.selectFrom('users')
      .select('password_hash')
      .where('id', '=', boundary.id)
      .executeTakeFirstOrThrow()
    expect(await verifyPassword(stored.password_hash, exactTwelveCharacters)).toBe(true)

    const tooLong = await insertUser({
      password: 'temporary-long-test',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })
    const longLogin = await login(tooLong.email, 'temporary-long-test')
    const longSetup = longLogin.json<{ setupToken: string }>().setupToken
    const longResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/initial-password/complete',
      headers: { authorization: `InitialPassword ${longSetup}` },
      payload: { newPassword: 'x'.repeat(129) },
    })
    expect(longResponse.statusCode).toBe(400)
  })

  it('setup token 的 session version 过期后不能改密', async () => {
    const user = await insertUser({
      password: 'temporary-version-test',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })
    const temporaryLogin = await login(user.email, 'temporary-version-test')
    const setupToken = temporaryLogin.json<{ setupToken: string }>().setupToken
    await db.updateTable('users')
      .set({ session_version: 2 })
      .where('id', '=', user.id)
      .execute()

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/initial-password/complete',
      headers: { authorization: `InitialPassword ${setupToken}` },
      payload: { newPassword: 'replacement-password' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('首次改密成功清除临时状态、递增版本并签发正式会话', async () => {
    const user = await insertUser({
      password: 'temporary-complete-test',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 60_000),
    })
    const temporaryLogin = await login(user.email, 'temporary-complete-test')
    const setupToken = temporaryLogin.json<{ setupToken: string }>().setupToken

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/initial-password/complete',
      headers: { authorization: `InitialPassword ${setupToken}` },
      payload: { newPassword: 'replacement-password' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ kind: string; token: string }>()
    expect(body.kind).toBe('authenticated')
    expect(await verifySession(body.token, process.env.JWT_SECRET ?? '')).toEqual({
      userId: user.id,
      sessionVersion: 2,
    })
    expect(await db.selectFrom('users').select([
      'must_change_password',
      'temporary_password_expires_at',
      'session_version',
    ]).where('id', '=', user.id).executeTakeFirstOrThrow()).toEqual({
      must_change_password: false,
      temporary_password_expires_at: null,
      session_version: 2,
    })
  })

  it('自助改密换发会话，并让旧 token 立即失效', async () => {
    const user = await insertUser({ password: 'synthetic-current-password' })
    const loginResponse = await login(user.email, 'synthetic-current-password')
    const oldToken = loginResponse.json<{ token: string }>().token

    const response = await app.inject({
      method: 'POST',
      url: '/api/session/password',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: {
        currentPassword: 'synthetic-current-password',
        newPassword: 'synthetic-next-password',
      },
    })

    expect(response.statusCode).toBe(200)
    const replacementToken = response.json<{ token: string }>().token
    expect((await app.inject({
      method: 'GET',
      url: '/api/session/me',
      headers: { authorization: `Bearer ${oldToken}` },
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: '/api/session/me',
      headers: { authorization: `Bearer ${replacementToken}` },
    })).statusCode).toBe(200)
  })

  it('自助改密提交后立即撤销该用户已经连接的旧 WebSocket', async () => {
    const user = await insertUser({ password: 'synthetic-current-ws-password' })
    const loginResponse = await login(user.email, 'synthetic-current-ws-password')
    const oldToken = loginResponse.json<{ token: string }>().token
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    }
    hub.add(user.id, socket as never)

    const response = await app.inject({
      method: 'POST',
      url: '/api/session/password',
      headers: { authorization: `Bearer ${oldToken}` },
      payload: {
        currentPassword: 'synthetic-current-ws-password',
        newPassword: 'synthetic-next-ws-password',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session_revoked' }))
    expect(socket.close).toHaveBeenCalledWith(4001, 'session revoked')
  })
})
