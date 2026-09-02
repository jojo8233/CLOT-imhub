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
const TEST_JWT_SECRET = 'customer-profile-library-route-secret'
process.env.JWT_SECRET = TEST_JWT_SECRET

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

const actorRoles = new Map<string, Role>()
const memberships = new Map<string, { team_id: string; is_lead: boolean }[]>()
const externalContactToken = `external-contact-${randomUUID()}`
const messageBodyOnlyToken = `message-body-${randomUUID()}`

let app: FastifyInstance
let ownerToken: string
let auditorToken: string
let managerToken: string
let agentToken: string
let invisibleAccountId: string
let writableConversationId: string

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) => {
      const role = actorRoles.get(userId)
      return role ? { id: userId, role, disabled_at: null } : null
    },
    findMemberships: async (userId) => memberships.get(userId) ?? [],
  }
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

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

beforeEach(async () => {
  actorRoles.clear()
  memberships.clear()
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

  const firstTeamId = (await db.insertInto('teams').values({
    name: `Library first team ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  const secondTeamId = (await db.insertInto('teams').values({
    name: `Library second team ${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id

  const ownerId = await createUser('owner', 'owner')
  const auditorId = await createUser('auditor', 'auditor')
  const managerId = await createUser('manager', 'manager')
  const firstAgentId = await createUser('agent', 'first-agent')
  const secondAgentId = await createUser('agent', 'second-agent')
  const thirdAgentId = await createUser('agent', 'third-agent')
  memberships.set(managerId, [{ team_id: firstTeamId, is_lead: true }])

  const accountRows = await db.insertInto('accounts').values([
    {
      platform: 'telegram',
      owner_user_id: firstAgentId,
      team_id: firstTeamId,
      display_name: 'Library first account',
      status: 'connected',
      platform_account_external_id: `external-account-${randomUUID()}`,
    },
    {
      platform: 'signal',
      owner_user_id: secondAgentId,
      team_id: firstTeamId,
      display_name: 'Library second account',
      status: 'connected',
    },
    {
      platform: 'whatsapp',
      owner_user_id: thirdAgentId,
      team_id: secondTeamId,
      display_name: 'Library third account',
      status: 'connected',
    },
  ]).returning(['id', 'owner_user_id']).execute()
  const firstAccountId = accountRows.find(row => row.owner_user_id === firstAgentId)?.id
  const secondAccountId = accountRows.find(row => row.owner_user_id === secondAgentId)?.id
  invisibleAccountId = accountRows.find(row => row.owner_user_id === thirdAgentId)?.id ?? ''
  if (!firstAccountId || !secondAccountId || !invisibleAccountId) {
    throw new Error('synthetic customer profile account fixture is incomplete')
  }

  const conversations = await db.insertInto('conversations').values([
    {
      account_id: firstAccountId,
      platform_conversation_id: `library-first-${randomUUID()}`,
      contact_external_id: externalContactToken,
      contact_display_name: 'Library first customer',
    },
    {
      account_id: secondAccountId,
      platform_conversation_id: `library-second-${randomUUID()}`,
      contact_external_id: `library-second-contact-${randomUUID()}`,
      contact_display_name: 'Library second customer',
    },
    {
      account_id: invisibleAccountId,
      platform_conversation_id: `library-third-${randomUUID()}`,
      contact_external_id: `library-third-contact-${randomUUID()}`,
      contact_display_name: 'Library third customer',
    },
  ]).returning(['id', 'account_id']).execute()
  writableConversationId = conversations.find(row => row.account_id === firstAccountId)?.id ?? ''
  if (!writableConversationId) throw new Error('synthetic writable conversation is missing')

  const actorByAccountId = new Map([
    [firstAccountId, firstAgentId],
    [secondAccountId, secondAgentId],
    [invisibleAccountId, thirdAgentId],
  ])
  await db.insertInto('customer_profiles').values(conversations.map((conversation, index) => ({
    conversation_id: conversation.id,
    name: `Library profile ${index + 1}`,
    age_location: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
    revision: 1,
    updated_by_user_id: actorByAccountId.get(conversation.account_id) ?? null,
  }))).execute()

  await db.insertInto('messages').values({
    conversation_id: writableConversationId,
    account_id: firstAccountId,
    platform: 'telegram',
    platform_message_id: `library-message-${randomUUID()}`,
    direction: 'in',
    sender_external_id: externalContactToken,
    body: messageBodyOnlyToken,
    sent_at: new Date(),
    media_refs: JSON.stringify([]),
    raw: JSON.stringify({}),
  }).execute()

  const { buildServer } = await import('../server.js')
  const { signSession } = await import('../../auth/session.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer(
    { adapters: {} as never, gateway: {} as never },
    new WsHub(),
    { actorRepo: fakeActorRepo() },
  )
  ownerToken = await signSession({ userId: ownerId }, TEST_JWT_SECRET)
  auditorToken = await signSession({ userId: auditorId }, TEST_JWT_SECRET)
  managerToken = await signSession({ userId: managerId }, TEST_JWT_SECRET)
  agentToken = await signSession({ userId: firstAgentId }, TEST_JWT_SECRET)
})

afterEach(async () => app?.close())

afterAll(async () => {
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('customer profile library routes', () => {
  it('requires authentication and rejects query-string search', async () => {
    expect((await app.inject({
      method: 'POST',
      url: '/api/customer-profiles/search',
      payload: {},
    })).statusCode).toBe(401)
    expect((await app.inject({
      method: 'GET',
      url: '/api/customer-profiles/search?q=must-not-enter-url',
      headers: auth(ownerToken),
    })).statusCode).toBe(404)
  })

  it('returns only scoped internal, display, and profile fields for all four roles', async () => {
    for (const [token, expectedCount] of [
      [ownerToken, 3],
      [auditorToken, 3],
      [managerToken, 2],
      [agentToken, 1],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/customer-profiles/search',
        headers: auth(token),
        payload: {},
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.items).toHaveLength(expectedCount)
      expect(response.body).not.toContain(externalContactToken)
      expect(response.body).not.toContain(messageBodyOnlyToken)
    }
  })

  it.each([
    ['extra key', { unexpected: true }],
    ['bad account', { accountId: 'not-a-uuid' }],
    ['bad limit', { limit: 101 }],
    ['long q', { q: 'x'.repeat(101) }],
    ['bad cursor', { cursor: 'invalid' }],
  ])('%s returns 400 without echoing the request body', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/customer-profiles/search',
      headers: auth(ownerToken),
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toBe('{"error":"客户档案库查询无效"}')
  })

  it('returns an empty page instead of revealing an invisible account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/customer-profiles/search',
      headers: auth(managerToken),
      payload: { accountId: invisibleAccountId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [], nextCursor: null })
  })

  it('keeps the existing auditor write boundary at 403', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/conversations/${writableConversationId}/customer-profile`,
      headers: auth(auditorToken),
      payload: {
        name: 'Must not write',
        ageLocation: null,
        occupation: null,
        family: null,
        interests: null,
        other: null,
        expectedRevision: 1,
      },
    })

    expect(response.statusCode).toBe(403)
  })
})
