import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'
import type { MessageRouteDeps } from './messages.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'conversations-route-test-secret-32c'

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let OWNER_ID: string
let OUTSIDER_ID: string
let AUDITOR_ID: string

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) => {
      if (userId === OWNER_ID) return { id: OWNER_ID, role: 'owner' as Role, disabled_at: null }
      if (userId === OUTSIDER_ID) return { id: OUTSIDER_ID, role: 'agent' as Role, disabled_at: null }
      if (userId === AUDITOR_ID) return { id: AUDITOR_ID, role: 'auditor' as Role, disabled_at: null }
      return null
    },
    findMemberships: async () => [],
  }
}

let app: FastifyInstance
let ownerToken: string
let outsiderToken: string
let auditorToken: string
let conversationId: string

beforeEach(async () => {
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()

  const owner = await db.insertInto('users').values(
    { email: 'owner-conv-route@example.com', display_name: 'O', role: 'owner', password_hash: 'x' },
  ).returning('id').executeTakeFirstOrThrow()
  OWNER_ID = owner.id

  const outsider = await db.insertInto('users').values(
    { email: 'outsider-conv-route@example.com', display_name: 'Out', role: 'agent', password_hash: 'x' },
  ).returning('id').executeTakeFirstOrThrow()
  OUTSIDER_ID = outsider.id

  const auditor = await db.insertInto('users').values(
    { email: 'auditor-conv-route@example.com', display_name: 'Audit', role: 'auditor', password_hash: 'x' },
  ).returning('id').executeTakeFirstOrThrow()
  AUDITOR_ID = auditor.id

  // 账号归 OWNER_ID 所有；outsider 是 agent 且不拥有它，所以在 self scope 下看不到这个会话
  const acc = await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: OWNER_ID, display_name: 'TG', status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()

  const conv = await db.insertInto('conversations').values({
    account_id: acc.id, platform_conversation_id: 'pc-1', contact_external_id: 'contact-1',
    target_lang: null,
  }).returning('id').executeTakeFirstOrThrow()
  conversationId = conv.id

  const deps: MessageRouteDeps = { adapters: {} as never, gateway: {} as never }
  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer(deps, new (await import('../ws.js')).WsHub(), { actorRepo: fakeActorRepo() })
  ownerToken = await signSession({ userId: OWNER_ID }, process.env.JWT_SECRET!)
  outsiderToken = await signSession({ userId: OUTSIDER_ID }, process.env.JWT_SECRET!)
  auditorToken = await signSession({ userId: AUDITOR_ID }, process.env.JWT_SECRET!)
})

afterAll(async () => {
  await app?.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

describe('PATCH /api/conversations/:id/target-lang', () => {
  it('可见范围内的会话可以锁定目标语言', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      headers: auth(ownerToken), payload: { targetLang: 'en' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: conversationId, targetLang: 'en' })

    const row = await db.selectFrom('conversations').select('target_lang')
      .where('id', '=', conversationId).executeTakeFirstOrThrow()
    expect(row.target_lang).toBe('en')
  })

  it('传 null 解锁，回到自动跟随', async () => {
    await db.updateTable('conversations').set({ target_lang: 'fr' }).where('id', '=', conversationId).execute()

    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      headers: auth(ownerToken), payload: { targetLang: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: conversationId, targetLang: null })

    const row = await db.selectFrom('conversations').select('target_lang')
      .where('id', '=', conversationId).executeTakeFirstOrThrow()
    expect(row.target_lang).toBeNull()
  })

  it('可见范围外的会话返回 404 且不修改数据', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      headers: auth(outsiderToken), payload: { targetLang: 'en' },
    })
    expect(res.statusCode).toBe(404)

    const row = await db.selectFrom('conversations').select('target_lang')
      .where('id', '=', conversationId).executeTakeFirstOrThrow()
    expect(row.target_lang).toBeNull()
  })

  it('auditor 即使全局可见也不能修改回复语言', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      headers: auth(auditorToken), payload: { targetLang: 'en' },
    })
    expect(res.statusCode).toBe(403)
    const row = await db.selectFrom('conversations').select('target_lang')
      .where('id', '=', conversationId).executeTakeFirstOrThrow()
    expect(row.target_lang).toBeNull()
  })

  it('不存在的会话 id 返回 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/conversations/00000000-0000-0000-0000-000000000000/target-lang',
      headers: auth(ownerToken), payload: { targetLang: 'en' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('无效 body（既不是字符串也不是 null）返回 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      headers: auth(ownerToken), payload: { targetLang: 123 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('无 token 返回 401', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/target-lang`,
      payload: { targetLang: 'en' },
    })
    expect(res.statusCode).toBe(401)
  })
})
