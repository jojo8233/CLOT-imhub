import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { CustomerProfileUpdate, Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
const TEST_JWT_SECRET = 'customer-profile-route-test-secret-32c'
process.env.JWT_SECRET = TEST_JWT_SECRET

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let app: FastifyInstance
let conversationId: string
let ownerToken: string
let auditorToken: string
let agentToken: string
let outsiderToken: string
let managerToken: string
let unrelatedManagerToken: string
const actorRoles = new Map<string, Role>()
const memberships = new Map<string, { team_id: string; is_lead: boolean }[]>()

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) => {
      const role = actorRoles.get(userId)
      return role ? { id: userId, role, disabled_at: null, session_version: 1 } : null
    },
    findMemberships: async (userId) => memberships.get(userId) ?? [],
  }
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

function validBody(expectedRevision: number): CustomerProfileUpdate {
  return {
    name: 'Synthetic Name',
    ageLocation: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
    expectedRevision,
  }
}

function putProfile(token: string, payload: CustomerProfileUpdate) {
  return app.inject({
    method: 'PUT',
    url: `/api/conversations/${conversationId}/customer-profile`,
    headers: auth(token),
    payload,
  })
}

beforeEach(async () => {
  actorRoles.clear()
  memberships.clear()
  await db.deleteFrom('customer_profiles').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('teams').execute()
  await db.deleteFrom('users').execute()

  const teamId = (await db.insertInto('teams').values({
    name: `Synthetic team ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  const unrelatedTeamId = (await db.insertInto('teams').values({
    name: `Synthetic unrelated team ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id

  async function createUser(role: Role, label: string): Promise<string> {
    const id = (await db.insertInto('users').values({
      email: `${label}-${randomUUID()}@example.test`,
      display_name: `Synthetic ${label}`,
      role,
      password_hash: 'x',
    }).returning('id').executeTakeFirstOrThrow()).id
    actorRoles.set(id, role)
    return id
  }

  const ownerId = await createUser('owner', 'owner')
  const auditorId = await createUser('auditor', 'auditor')
  const agentId = await createUser('agent', 'agent')
  const outsiderId = await createUser('agent', 'outsider')
  const managerId = await createUser('manager', 'manager')
  const unrelatedManagerId = await createUser('manager', 'unrelated-manager')
  memberships.set(managerId, [{ team_id: teamId, is_lead: true }])
  memberships.set(unrelatedManagerId, [{ team_id: unrelatedTeamId, is_lead: true }])

  const accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: agentId,
    team_id: teamId,
    display_name: 'Synthetic customer profile account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `synthetic-conversation-${randomUUID()}`,
    contact_external_id: `synthetic-contact-${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id

  const { buildServer } = await import('../server.js')
  const { signSession } = await import('../../auth/session.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer(
    { adapters: {} as never, gateway: {} as never },
    new WsHub(),
    { actorRepo: fakeActorRepo() },
  )
  ownerToken = await signSession({ userId: ownerId, sessionVersion: 1 }, TEST_JWT_SECRET)
  auditorToken = await signSession({ userId: auditorId, sessionVersion: 1 }, TEST_JWT_SECRET)
  agentToken = await signSession({ userId: agentId, sessionVersion: 1 }, TEST_JWT_SECRET)
  outsiderToken = await signSession({ userId: outsiderId, sessionVersion: 1 }, TEST_JWT_SECRET)
  managerToken = await signSession({ userId: managerId, sessionVersion: 1 }, TEST_JWT_SECRET)
  unrelatedManagerToken = await signSession({ userId: unrelatedManagerId, sessionVersion: 1 }, TEST_JWT_SECRET)
})

afterEach(async () => app?.close())

afterAll(async () => {
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('customer profile routes', () => {
  it('可见但尚未填写时 GET 返回 revision 0 空档案', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/customer-profile`,
      headers: auth(agentToken),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      conversationId,
      name: null,
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      revision: 0,
      updatedAt: null,
    })
  })

  it('PUT trim 字段并首建 revision 1', async () => {
    const res = await putProfile(agentToken, {
      name: '  Synthetic Name  ',
      ageLocation: null,
      occupation: null,
      family: null,
      interests: ' Synthetic Interest ',
      other: null,
      expectedRevision: 0,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      name: 'Synthetic Name',
      interests: 'Synthetic Interest',
      revision: 1,
    })
  })

  it.each([
    ['outsider agent', () => outsiderToken],
    ['unrelated manager', () => unrelatedManagerToken],
  ])('%s 对不可见会话 GET/PUT 均为 404', async (_label, token) => {
    const headers = auth(token())
    const url = `/api/conversations/${conversationId}/customer-profile`
    const get = await app.inject({ method: 'GET', url, headers })
    const put = await app.inject({ method: 'PUT', url, headers, payload: validBody(0) })
    expect([get.statusCode, put.statusCode]).toEqual([404, 404])
  })

  it('同团队 manager 可写，auditor 可读但不能写', async () => {
    expect((await putProfile(managerToken, validBody(0))).statusCode).toBe(200)
    const url = `/api/conversations/${conversationId}/customer-profile`
    expect((await app.inject({ method: 'GET', url, headers: auth(auditorToken) })).statusCode)
      .toBe(200)
    expect((await app.inject({
      method: 'PUT',
      url,
      headers: auth(auditorToken),
      payload: validBody(1),
    })).statusCode).toBe(403)
  })

  it('owner 可写并在旧 revision 时收到不含服务器正文的 409', async () => {
    await putProfile(ownerToken, validBody(0))
    const res = await putProfile(ownerToken, { ...validBody(0), name: 'Stale Draft' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: '档案已被其他人更新', currentRevision: 1 })
    expect(res.body).not.toContain('Synthetic Name')
  })

  it('无 token 返回 401，非法会话 UUID 返回 400', async () => {
    const noToken = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/customer-profile`,
    })
    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/conversations/not-a-uuid/customer-profile',
      headers: auth(ownerToken),
    })
    expect([noToken.statusCode, invalidId.statusCode]).toEqual([401, 400])
  })

  it.each([
    ['extra key', { ...validBody(0), unexpected: true }],
    ['negative revision', { ...validBody(0), expectedRevision: -1 }],
    ['fractional revision', { ...validBody(0), expectedRevision: 0.5 }],
  ])('%s 返回 400', async (_label, payload) => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/conversations/${conversationId}/customer-profile`,
      headers: auth(ownerToken),
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('姓名按 Unicode code point 限制为 200', async () => {
    const accepted = await putProfile(ownerToken, {
      ...validBody(0),
      name: '😀'.repeat(200),
    })
    expect(accepted.statusCode).toBe(200)
    const rejected = await putProfile(ownerToken, {
      ...validBody(1),
      name: '😀'.repeat(201),
    })
    expect(rejected.statusCode).toBe(400)
  })

  it('其他字段超过 2000 code points 返回 400', async () => {
    const res = await putProfile(ownerToken, {
      ...validBody(0),
      other: 'x'.repeat(2_001),
    })
    expect(res.statusCode).toBe(400)
  })

  it('纯空白字段规范成 null', async () => {
    const res = await putProfile(ownerToken, {
      ...validBody(0),
      name: ' \n ',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ name: null, revision: 0 })
  })

  it('相同内容重复 PUT 不增加 revision', async () => {
    const first = await putProfile(ownerToken, validBody(0))
    const second = await putProfile(ownerToken, validBody(1))
    expect(first.json()).toMatchObject({ revision: 1 })
    expect(second.json()).toMatchObject({ revision: 1 })
  })
})
