import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
const TEST_JWT_SECRET = 'keyword-rule-route-test-secret-32c'
process.env.JWT_SECRET = TEST_JWT_SECRET

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const actorRoles = new Map<string, Role>()
let app: FastifyInstance
let ownerToken: string
let managerToken: string
let auditorToken: string
let agentToken: string

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) => {
      const role = actorRoles.get(userId)
      return role ? { id: userId, role, disabled_at: null, session_version: 1 } : null
    },
    findMemberships: async () => [],
  }
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function createUser(role: Role): Promise<string> {
  const id = (await db.insertInto('users').values({
    email: `${role}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${role}`,
    role,
    password_hash: 'test-only',
  }).returning('id').executeTakeFirstOrThrow()).id
  actorRoles.set(id, role)
  return id
}

async function insertDegradedJob(agentId: string): Promise<void> {
  const accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: agentId,
    display_name: 'Synthetic degraded account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `degraded-conversation-${randomUUID()}`,
    contact_external_id: `degraded-contact-${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  const messageId = (await db.insertInto('messages').values({
    conversation_id: conversationId,
    account_id: accountId,
    platform: 'telegram',
    platform_message_id: `degraded-message-${randomUUID()}`,
    direction: 'in',
    sender_external_id: 'synthetic-sender',
    body: 'retry me',
    sent_at: new Date('2026-09-03T10:00:00.000Z'),
    media_refs: JSON.stringify([]) as never,
    raw: JSON.stringify({}) as never,
  }).returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('keyword_alert_scan_jobs').values({
    message_id: messageId,
    message_revision: 'initial',
    body_snapshot: 'retry me',
    available_at: new Date('2026-09-03T10:00:00.000Z'),
    attempt_count: 10,
    last_error_code: 'scan_failed',
  }).execute()
}

beforeEach(async () => {
  actorRoles.clear()
  await db.deleteFrom('keyword_alert_recipients').execute()
  await db.deleteFrom('keyword_alerts').execute()
  await db.deleteFrom('keyword_alert_scan_jobs').execute()
  await db.deleteFrom('keyword_rules').execute()
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('message_reactions').execute()
  await db.deleteFrom('message_id_aliases').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('customer_profiles').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('teams').execute()
  await db.deleteFrom('users').execute()

  const ownerId = await createUser('owner')
  const managerId = await createUser('manager')
  const auditorId = await createUser('auditor')
  const agentId = await createUser('agent')
  await insertDegradedJob(agentId)
  const { buildServer } = await import('../server.js')
  const { signSession } = await import('../../auth/session.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer(
    { adapters: {} as never, gateway: {} as never },
    new WsHub(),
    { actorRepo: fakeActorRepo() },
  )
  ownerToken = await signSession({ userId: ownerId, sessionVersion: 1 }, TEST_JWT_SECRET)
  managerToken = await signSession({ userId: managerId, sessionVersion: 1 }, TEST_JWT_SECRET)
  auditorToken = await signSession({ userId: auditorId, sessionVersion: 1 }, TEST_JWT_SECRET)
  agentToken = await signSession({ userId: agentId, sessionVersion: 1 }, TEST_JWT_SECRET)
})

afterEach(async () => app?.close())
afterAll(async () => {
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

interface RouteRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: string
  payload?: string | Record<string, unknown>
}

function ownerOnlyRequests(): RouteRequest[] {
  const id = randomUUID()
  return [
    { method: 'GET', url: '/api/keyword-rules' },
    {
      method: 'POST', url: '/api/keyword-rules',
      payload: { pattern: 'refund', severity: 'important', enabled: true },
    },
    {
      method: 'PATCH', url: `/api/keyword-rules/${id}`,
      payload: { baseRevision: 1, enabled: false },
    },
    {
      method: 'DELETE', url: `/api/keyword-rules/${id}`,
      payload: { baseRevision: 1 },
    },
    { method: 'POST', url: '/api/keyword-alert-scans/retry', payload: {} },
  ]
}

describe('keyword rule routes', () => {
  it('五个 endpoint 均要求认证', async () => {
    for (const request of ownerOnlyRequests()) {
      expect((await app.inject(request)).statusCode).toBe(401)
    }
  })

  it.each([
    ['manager', () => managerToken],
    ['auditor', () => auditorToken],
    ['agent', () => agentToken],
  ])('%s 在校验 body 或调用仓储前被五个 endpoint 拒绝', async (_role, token) => {
    const id = randomUUID()
    const invalidRequests: RouteRequest[] = [
      { method: 'GET', url: '/api/keyword-rules' },
      { method: 'POST', url: '/api/keyword-rules', payload: { extra: true } },
      { method: 'PATCH', url: `/api/keyword-rules/${id}`, payload: {} },
      { method: 'DELETE', url: `/api/keyword-rules/${id}`, payload: { extra: true } },
      { method: 'POST', url: '/api/keyword-alert-scans/retry', payload: { extra: true } },
    ]
    for (const request of invalidRequests) {
      const response = await app.inject({ ...request, headers: auth(token()) })
      expect(response.statusCode).toBe(403)
      expect(response.body).toBe('{"error":"forbidden"}')
    }
  })

  it('owner 可完整 CRUD、读取 degraded 数量并触发 retry', async () => {
    const initial = await app.inject({
      method: 'GET', url: '/api/keyword-rules', headers: auth(ownerToken),
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toEqual({ rules: [], degradedScanCount: 1 })
    const created = await app.inject({
      method: 'POST', url: '/api/keyword-rules', headers: auth(ownerToken),
      payload: { pattern: '  ＲＥＦＵＮＤ  ', severity: 'important', enabled: true },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      pattern: 'ＲＥＦＵＮＤ', severity: 'important', enabled: true, revision: 1,
    })
    expect(Object.keys(created.json()).sort()).toEqual([
      'createdAt', 'effectiveAt', 'enabled', 'id', 'pattern',
      'revision', 'severity', 'updatedAt',
    ])
    const ruleId = created.json<{ id: string }>().id
    const updated = await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${ruleId}`, headers: auth(ownerToken),
      payload: { baseRevision: 1, enabled: false },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ id: ruleId, enabled: false, revision: 2 })
    const stale = await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${ruleId}`, headers: auth(ownerToken),
      payload: { baseRevision: 1, severity: 'urgent' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: '关键词规则已被更新', currentRevision: 2 })
    const removed = await app.inject({
      method: 'DELETE', url: `/api/keyword-rules/${ruleId}`, headers: auth(ownerToken),
      payload: { baseRevision: 2 },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual({ deleted: true })
    const retried = await app.inject({
      method: 'POST', url: '/api/keyword-alert-scans/retry', headers: auth(ownerToken), payload: {},
    })
    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toEqual({ retried: 1 })
    expect((await app.inject({
      method: 'GET', url: '/api/keyword-rules', headers: auth(ownerToken),
    })).json()).toEqual({ rules: [], degradedScanCount: 0 })
  })

  it('规范化重复和 stale revision 返回互不混淆的固定 409', async () => {
    const create = (pattern: string) => app.inject({
      method: 'POST' as const,
      url: '/api/keyword-rules',
      headers: auth(ownerToken),
      payload: { pattern, severity: 'important', enabled: true },
    })
    const first = await create('  ＲＥＦＵＮＤ  ')
    const duplicate = await create('refund')
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.body).toBe('{"error":"关键词规则已存在"}')
    const ruleId = first.json<{ id: string }>().id
    await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${ruleId}`, headers: auth(ownerToken),
      payload: { baseRevision: 1, enabled: false },
    })
    const stale = await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${ruleId}`, headers: auth(ownerToken),
      payload: { baseRevision: 1, severity: 'urgent' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: '关键词规则已被更新', currentRevision: 2 })
  })

  it('不存在的规则在 PATCH 和 DELETE 均返回固定 404', async () => {
    const id = randomUUID()
    const patch = await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${id}`, headers: auth(ownerToken),
      payload: { baseRevision: 1, enabled: false },
    })
    const remove = await app.inject({
      method: 'DELETE', url: `/api/keyword-rules/${id}`, headers: auth(ownerToken),
      payload: { baseRevision: 1 },
    })
    expect([patch.statusCode, remove.statusCode]).toEqual([404, 404])
    expect([patch.body, remove.body]).toEqual([
      '{"error":"关键词规则不存在"}', '{"error":"关键词规则不存在"}',
    ])
  })

  it.each([
    ['null body', 'null', 'application/json'],
    ['extra key', { pattern: 'secret-extra', severity: 'normal', enabled: true, extra: true }],
    ['empty pattern', { pattern: '   ', severity: 'normal', enabled: true }],
    ['control pattern', { pattern: 'secret\ncontrol', severity: 'normal', enabled: true }],
    ['long pattern', { pattern: 's'.repeat(101), severity: 'normal', enabled: true }],
    ['bad severity', { pattern: 'secret-severity', severity: 'critical', enabled: true }],
    ['null enabled', { pattern: 'secret-enabled', severity: 'normal', enabled: null }],
  ])('POST 拒绝 %s 且固定 400 不回显内容', async (_label, payload, contentType?: string) => {
    const response = await app.inject({
      method: 'POST', url: '/api/keyword-rules',
      headers: { ...auth(ownerToken), ...(contentType ? { 'content-type': contentType } : {}) },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('{"error":"关键词规则请求无效"}')
    expect(response.body).not.toContain('secret')
    expect(response.body).not.toContain('control')
  })

  it.each([
    ['null body', 'null', 'application/json'],
    ['extra key', { baseRevision: 1, enabled: false, pattern: 'secret-extra', extra: true }],
    ['missing update', { baseRevision: 1 }],
    ['zero revision', { baseRevision: 0, enabled: false }],
    ['fractional revision', { baseRevision: 1.5, enabled: false }],
    ['null revision', { baseRevision: null, enabled: false }],
    ['null pattern', { baseRevision: 1, pattern: null }],
  ])('PATCH 拒绝 %s 且固定 400 不回显内容', async (_label, payload, contentType?: string) => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/keyword-rules/${randomUUID()}`,
      headers: { ...auth(ownerToken), ...(contentType ? { 'content-type': contentType } : {}) },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('{"error":"关键词规则请求无效"}')
    expect(response.body).not.toContain('secret')
  })

  it('DELETE 和 retry 只接受各自严格 JSON object', async () => {
    const requests: RouteRequest[] = [
      {
        method: 'DELETE', url: `/api/keyword-rules/${randomUUID()}`,
        payload: { baseRevision: 1, extra: 'secret-delete' },
      },
      { method: 'DELETE', url: `/api/keyword-rules/${randomUUID()}`, payload: { baseRevision: 0 } },
      { method: 'POST', url: '/api/keyword-alert-scans/retry', payload: { extra: 'secret-retry' } },
    ]
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: auth(ownerToken) })
      expect(response.statusCode).toBe(400)
      expect(response.body).toBe('{"error":"关键词规则请求无效"}')
      expect(response.body).not.toContain('secret')
    }
    for (const request of [
      { method: 'DELETE' as const, url: `/api/keyword-rules/${randomUUID()}` },
      { method: 'POST' as const, url: '/api/keyword-alert-scans/retry' },
    ]) {
      const response = await app.inject({
        ...request,
        headers: { ...auth(ownerToken), 'content-type': 'application/json' },
        payload: 'null',
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toBe('{"error":"关键词规则请求无效"}')
    }
  })
})
