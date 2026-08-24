import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { KyselyMessageRepo } from './repo.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const repo = new KyselyMessageRepo(db)

let accountId: string

beforeEach(async () => {
  // 每个用例从干净状态开始；顺序按外键依赖倒序
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()

  const user = await db.insertInto('users').values({
    email: 'repo-test@example.com', display_name: 'T', role: 'agent', password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()

  const acc = await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: user.id, display_name: 'TG', status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()

  accountId = acc.id
})

afterAll(async () => { await db.destroy() })

function msg(over: Partial<Parameters<typeof repo.insertMessage>[0]> = {}) {
  return {
    conversationId: '', accountId, platform: 'telegram' as const,
    platformMessageId: '555', direction: 'in' as const, senderExternalId: '777',
    body: 'hello', mediaRefs: [], sentAt: new Date('2026-08-24T00:00:00Z'), raw: {},
    ...over,
  }
}

describe('KyselyMessageRepo.upsertConversation', () => {
  it('首次插入返回新 id', async () => {
    const { id } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    expect(id).toBeTruthy()
  })

  it('同一 (account, conversation) 重复 upsert 返回同一个 id', async () => {
    const a = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    const b = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    expect(b.id).toBe(a.id)
  })

  it('出向消息传 null 时不抹掉已知的联系人身份', async () => {
    await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: null, contactDisplayName: null,
    })
    const row = await db.selectFrom('conversations')
      .select(['contact_external_id', 'contact_display_name'])
      .where('platform_conversation_id', '=', 'c1').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('777')
    expect(row.contact_display_name).toBe('Jane')
  })

  it('会话由出向消息首次创建时用会话 id 兜底，之后被入向消息修正', async () => {
    await repo.upsertConversation({
      accountId, platformConversationId: 'c2', contactExternalId: null, contactDisplayName: null,
    })
    let row = await db.selectFrom('conversations').select('contact_external_id')
      .where('platform_conversation_id', '=', 'c2').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('c2')

    await repo.upsertConversation({
      accountId, platformConversationId: 'c2', contactExternalId: '888', contactDisplayName: 'Bob',
    })
    row = await db.selectFrom('conversations').select('contact_external_id')
      .where('platform_conversation_id', '=', 'c2').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('888')
  })
})

describe('KyselyMessageRepo.insertMessage', () => {
  it('首次插入 isNew 为 true', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const r = await repo.insertMessage(msg({ conversationId }))
    expect(r.isNew).toBe(true)
    expect(r.id).toBeTruthy()
  })

  it('重复插入同一 platform_message_id 时 isNew 为 false 且返回既有 id', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId }))
    const second = await repo.insertMessage(msg({ conversationId, body: '改过的内容' }))
    expect(second.isNew).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('重复插入不会覆盖已存的消息内容', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({ conversationId }))
    await repo.insertMessage(msg({ conversationId, body: '改过的内容' }))
    const row = await db.selectFrom('messages').select('body')
      .where('platform_message_id', '=', '555').executeTakeFirstOrThrow()
    expect(row.body).toBe('hello')
  })

  it('数据库里只留一行，去重约束真的生效', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({ conversationId }))
    await repo.insertMessage(msg({ conversationId }))
    const rows = await db.selectFrom('messages').select('id')
      .where('platform_message_id', '=', '555').execute()
    expect(rows).toHaveLength(1)
  })
})

describe('KyselyMessageRepo.touchConversation', () => {
  it('更新 last_message_at', async () => {
    const { id } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const at = new Date('2026-08-24T12:00:00Z')
    await repo.touchConversation(id, at)
    const row = await db.selectFrom('conversations').select('last_message_at')
      .where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.last_message_at?.toISOString()).toBe(at.toISOString())
  })
})
