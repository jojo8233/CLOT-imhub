import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import { ScopedDb } from '../../rbac/scoped-db.js'
import type { ActorRepo } from '../actor.js'
import { keywordAlertRoutes } from './keyword-alerts.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
const TEST_JWT_SECRET = 'keyword-alert-route-test-secret-32c'
process.env.JWT_SECRET = TEST_JWT_SECRET

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const actorRoles = new Map<string, Role>()
const actorMemberships = new Map<string, Array<{ team_id: string; is_lead: boolean }>>()
const matchedAt = new Date('2026-09-03T10:00:00.000Z')
let app: FastifyInstance

interface RouteFixture {
  ownerId: string
  auditorId: string
  managerId: string
  agentId: string
  outsiderId: string
  accountId: string
  alertIds: [string, string]
  tokens: Record<'owner' | 'auditor' | 'manager' | 'agent' | 'outsider', string>
}

let fixture: RouteFixture

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) => {
      const role = actorRoles.get(userId)
      return role ? { id: userId, role, disabled_at: null } : null
    },
    findMemberships: async userId => actorMemberships.get(userId) ?? [],
  }
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

async function insertUser(label: string, role: Role): Promise<string> {
  const id = (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: label,
    role,
    password_hash: 'test-only',
  }).returning('id').executeTakeFirstOrThrow()).id
  actorRoles.set(id, role)
  return id
}

async function seedRouteFixture(): Promise<RouteFixture> {
  const ownerId = await insertUser('owner', 'owner')
  const auditorId = await insertUser('auditor', 'auditor')
  const managerId = await insertUser('manager', 'manager')
  const agentId = await insertUser('agent', 'agent')
  const outsiderId = await insertUser('outsider', 'agent')
  const teamId = (await db.insertInto('teams').values({ name: 'Route Team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values({
    team_id: teamId,
    user_id: managerId,
    is_lead: true,
  }).execute()
  actorMemberships.set(managerId, [{ team_id: teamId, is_lead: true }])
  const accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: agentId,
    team_id: teamId,
    display_name: 'Route account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `external-conversation-${randomUUID()}`,
    contact_external_id: `external-contact-${randomUUID()}`,
    contact_display_name: 'Route customer',
  }).returning('id').executeTakeFirstOrThrow()).id
  const alertIds: [string, string] = [
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
  ]

  for (const [index, alertId] of alertIds.entries()) {
    const messageId = (await db.insertInto('messages').values({
      conversation_id: conversationId,
      account_id: accountId,
      platform: 'telegram',
      platform_message_id: `external-message-${randomUUID()}`,
      direction: 'in',
      sender_external_id: `external-sender-${randomUUID()}`,
      body: `customer requests refund ${index}`,
      body_lang: null,
      media_refs: JSON.stringify([]) as never,
      reply_to_platform_message_id: null,
      edited_at: null,
      edit_version: null,
      deleted_at: null,
      sent_at: matchedAt,
      raw: JSON.stringify({ private: 'raw-route-value' }) as never,
    }).returning('id').executeTakeFirstOrThrow()).id
    const ruleId = (await db.insertInto('keyword_rules').values({
      pattern: `Refund ${index}`,
      normalized_pattern: `refund ${index}`,
      severity: index === 0 ? 'urgent' : 'normal',
      enabled: true,
      revision: 1,
      effective_at: new Date('2026-09-03T09:00:00.000Z'),
      created_by_user_id: ownerId,
      updated_by_user_id: ownerId,
      created_at: new Date('2026-09-03T09:00:00.000Z'),
      updated_at: new Date('2026-09-03T09:00:00.000Z'),
      deleted_at: null,
    }).returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('keyword_alerts').values({
      id: alertId,
      message_id: messageId,
      rule_id: ruleId,
      pattern_snapshot: `Refund ${index}`,
      severity_snapshot: index === 0 ? 'urgent' : 'normal',
      matched_message_revision: 'initial',
      created_at: matchedAt,
    }).execute()
    await db.insertInto('keyword_alert_recipients').values([
      { alert_id: alertId, user_id: ownerId, requires_ack: true, created_at: matchedAt },
      { alert_id: alertId, user_id: auditorId, requires_ack: false, created_at: matchedAt },
      { alert_id: alertId, user_id: managerId, requires_ack: true, created_at: matchedAt },
      { alert_id: alertId, user_id: agentId, requires_ack: true, created_at: matchedAt },
      // 故意保留一个已失去 account scope 的旧 recipient，验证双重约束。
      { alert_id: alertId, user_id: outsiderId, requires_ack: true, created_at: matchedAt },
    ]).execute()
  }

  const { signSession } = await import('../../auth/session.js')
  return {
    ownerId,
    auditorId,
    managerId,
    agentId,
    outsiderId,
    accountId,
    alertIds,
    tokens: {
      owner: await signSession({ userId: ownerId }, TEST_JWT_SECRET),
      auditor: await signSession({ userId: auditorId }, TEST_JWT_SECRET),
      manager: await signSession({ userId: managerId }, TEST_JWT_SECRET),
      agent: await signSession({ userId: agentId }, TEST_JWT_SECRET),
      outsider: await signSession({ userId: outsiderId }, TEST_JWT_SECRET),
    },
  }
}

async function cleanDatabase(): Promise<void> {
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
}

beforeEach(async () => {
  actorRoles.clear()
  actorMemberships.clear()
  await cleanDatabase()

  fixture = await seedRouteFixture()
  const { buildServer } = await import('../server.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer(
    { adapters: {} as never, gateway: {} as never },
    new WsHub(),
    { actorRepo: fakeActorRepo() },
  )
})

afterEach(async () => app?.close())
afterAll(async () => {
  await cleanDatabase()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('keyword alert route authentication and visibility', () => {
  it('三个 endpoint 均要求认证', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/keyword-alerts/search', payload: { status: 'all' } }),
      app.inject({ method: 'GET', url: '/api/keyword-alerts/unacknowledged-count' }),
      app.inject({
        method: 'PATCH',
        url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
        payload: {},
      }),
    ])
    expect(responses.map(response => response.statusCode)).toEqual([401, 401, 401])
  })

  it.each([
    ['owner', 'pending'],
    ['manager', 'pending'],
    ['agent', 'pending'],
    ['auditor', 'all'],
  ] as const)('%s 只能看到当前 recipient 与当前 scope 交集中的告警', async (role, status) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/keyword-alerts/search',
      headers: auth(fixture.tokens[role]),
      payload: { status },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ items: Array<{ alertId: string }>; nextCursor: string | null }>())
      .toMatchObject({
        items: [{ alertId: fixture.alertIds[1] }, { alertId: fixture.alertIds[0] }],
        nextCursor: null,
      })
  })

  it.each(['owner', 'manager', 'agent'] as const)('%s 的未确认计数只统计自己的两行', async role => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/keyword-alerts/unacknowledged-count',
      headers: auth(fixture.tokens[role]),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ count: 2 })
  })

  it('auditor 只接受 status=all，count 安全返回 0，ack 固定 403', async () => {
    const search = await app.inject({
      method: 'POST',
      url: '/api/keyword-alerts/search',
      headers: auth(fixture.tokens.auditor),
      payload: { status: 'pending' },
    })
    const count = await app.inject({
      method: 'GET',
      url: '/api/keyword-alerts/unacknowledged-count',
      headers: auth(fixture.tokens.auditor),
    })
    const ack = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
      headers: auth(fixture.tokens.auditor),
      payload: {},
    })

    expect(search.statusCode).toBe(400)
    expect(search.body).toBe('{"error":"关键词告警请求无效"}')
    expect(count.json()).toEqual({ count: 0 })
    expect(ack.statusCode).toBe(403)
    expect(ack.body).toBe('{"error":"forbidden"}')
  })

  it('有旧 recipient 但当前 account 不可见时，search 为空且 ack 返回 404', async () => {
    const search = await app.inject({
      method: 'POST',
      url: '/api/keyword-alerts/search',
      headers: auth(fixture.tokens.outsider),
      payload: { status: 'all', accountId: fixture.accountId },
    })
    const ack = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
      headers: auth(fixture.tokens.outsider),
      payload: {},
    })

    expect(search.json()).toEqual({ items: [], nextCursor: null })
    expect(ack.statusCode).toBe(404)
    expect(ack.body).toBe('{"error":"关键词告警不存在"}')
  })
})

describe('keyword alert route validation and cursor binding', () => {
  it.each([
    ['null body', 'null', 'application/json'],
    ['extra key', { status: 'all', extra: 'FILTER-MUST-NOT-LEAK' }],
    ['null status', { status: null }],
    ['null severity', { status: 'all', severity: null }],
    ['null platform', { status: 'all', platform: null }],
    ['null account', { status: 'all', accountId: null }],
    ['null limit', { status: 'all', limit: null }],
    ['null cursor', { status: 'all', cursor: null }],
    ['bad limit', { status: 'all', limit: 101 }],
  ])('search 拒绝 %s，固定 400 且不回显筛选值', async (_label, payload, contentType?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/keyword-alerts/search',
      headers: {
        ...auth(fixture.tokens.owner),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('{"error":"关键词告警请求无效"}')
    expect(response.body).not.toContain('FILTER-MUST-NOT-LEAK')
  })

  it('malformed、跨筛选与跨 actor cursor 均返回固定 400', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/keyword-alerts/search',
      headers: auth(fixture.tokens.owner),
      payload: { status: 'pending', limit: 1 },
    })
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor
    if (cursor === null) throw new Error('expected route cursor')
    const requests = [
      { token: fixture.tokens.owner, payload: { status: 'pending', cursor: 'CURSOR-SECRET' } },
      { token: fixture.tokens.owner, payload: { status: 'all', cursor } },
      { token: fixture.tokens.agent, payload: { status: 'pending', cursor } },
    ]
    for (const request of requests) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/keyword-alerts/search',
        headers: auth(request.token),
        payload: request.payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toBe('{"error":"关键词告警请求无效"}')
      expect(response.body).not.toContain('CURSOR-SECRET')
    }
  })
})

describe('keyword alert personal acknowledgement', () => {
  it.each(['owner', 'manager'] as const)('%s 只确认自己的 recipient', async role => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
      headers: auth(fixture.tokens[role]),
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    const ownUserId = role === 'owner' ? fixture.ownerId : fixture.managerId
    const recipients = await db.selectFrom('keyword_alert_recipients')
      .select(['user_id', 'acknowledged_at'])
      .where('alert_id', '=', fixture.alertIds[0])
      .execute()
    expect(recipients.find(row => row.user_id === ownUserId)?.acknowledged_at)
      .toEqual(expect.any(Date))
    expect(recipients.find(row => row.user_id === fixture.agentId)?.acknowledged_at).toBeNull()
  })

  it('不存在告警返回 404，重复确认返回第一次 acknowledgedAt 且不影响其他 recipient', async () => {
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${randomUUID()}/acknowledge`,
      headers: auth(fixture.tokens.agent),
      payload: {},
    })
    expect(missing.statusCode).toBe(404)

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
      headers: auth(fixture.tokens.agent),
      payload: {},
    })
    const second = await app.inject({
      method: 'PATCH',
      url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
      headers: auth(fixture.tokens.agent),
      payload: {},
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
    expect(Object.keys(first.json())).toEqual(['acknowledgedAt'])
    const count = await app.inject({
      method: 'GET',
      url: '/api/keyword-alerts/unacknowledged-count',
      headers: auth(fixture.tokens.agent),
    })
    expect(count.json()).toEqual({ count: 1 })
    const ownerRecipient = await db.selectFrom('keyword_alert_recipients')
      .select('acknowledged_at')
      .where('alert_id', '=', fixture.alertIds[0])
      .where('user_id', '=', fixture.ownerId)
      .executeTakeFirstOrThrow()
    expect(ownerRecipient.acknowledged_at).toBeNull()
  })

  it('acknowledge 只接受 strict 空 object，显式 null 或额外字段均固定 400', async () => {
    for (const request of [
      { payload: 'null', contentType: 'application/json' },
      { payload: { extra: 'ACK-MUST-NOT-LEAK' }, contentType: undefined },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
        headers: {
          ...auth(fixture.tokens.agent),
          ...(request.contentType ? { 'content-type': request.contentType } : {}),
        },
        payload: request.payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toBe('{"error":"关键词告警请求无效"}')
      expect(response.body).not.toContain('ACK-MUST-NOT-LEAK')
    }
  })

  it('acknowledge access log 不记录 URL 中的告警业务 ID', async () => {
    const lines: string[] = []
    const isolated = Fastify({
      logger: {
        stream: { write: line => { lines.push(line) } },
      },
    })
    isolated.addHook('onRequest', async req => {
      req.actor = { userId: fixture.agentId, role: 'agent', leadTeamIds: [] }
      req.scoped = new ScopedDb(
        db,
        { kind: 'self', userId: fixture.agentId },
        fixture.agentId,
      )
    })
    await keywordAlertRoutes(isolated)

    try {
      const response = await isolated.inject({
        method: 'PATCH',
        url: `/api/keyword-alerts/${fixture.alertIds[0]}/acknowledge`,
        payload: {},
      })
      expect(response.statusCode).toBe(200)
      expect(lines.join('\n')).not.toContain(fixture.alertIds[0])
    } finally {
      await isolated.close()
    }
  })
})
