import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import {
  emptyCustomerProfile,
  type CustomerProfileUpdate,
} from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { ScopedCustomerProfileRepo } from './repo.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let ownerId: string
let outsiderId: string
let accountId: string
let conversationId: string
let ownerRepo: ScopedCustomerProfileRepo
let outsiderRepo: ScopedCustomerProfileRepo

function syntheticUpdate(expectedRevision: number): CustomerProfileUpdate {
  return {
    name: 'Synthetic Name',
    ageLocation: null,
    occupation: 'Synthetic Occupation',
    family: null,
    interests: null,
    other: null,
    expectedRevision,
  }
}

function saveSyntheticProfile(
  repo: ScopedCustomerProfileRepo,
  targetConversationId: string,
  actorUserId: string,
  expectedRevision: number,
) {
  return repo.save(
    targetConversationId,
    actorUserId,
    syntheticUpdate(expectedRevision),
  )
}

beforeEach(async () => {
  await db.deleteFrom('customer_profiles').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').execute()

  ownerId = (await db.insertInto('users').values({
    email: `profile-owner-${randomUUID()}@example.test`,
    display_name: 'Synthetic profile owner',
    role: 'agent',
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
  outsiderId = (await db.insertInto('users').values({
    email: `profile-outsider-${randomUUID()}@example.test`,
    display_name: 'Synthetic profile outsider',
    role: 'agent',
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
  accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: ownerId,
    display_name: 'Synthetic profile account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `synthetic-conversation-${randomUUID()}`,
    contact_external_id: `synthetic-contact-${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id

  ownerRepo = new ScopedCustomerProfileRepo(db, {
    kind: 'self',
    userId: ownerId,
  })
  outsiderRepo = new ScopedCustomerProfileRepo(db, {
    kind: 'self',
    userId: outsiderId,
  })
})

afterAll(async () => db.destroy())

describe('ScopedCustomerProfileRepo', () => {
  it('可见但未建档案时返回 revision 0 空快照', async () => {
    expect(await ownerRepo.get(conversationId)).toEqual({
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

  it('首建档案返回 revision 1 的完整快照', async () => {
    const result = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
    expect(result).toEqual({
      kind: 'saved',
      profile: expect.objectContaining({
        conversationId,
        name: 'Synthetic Name',
        occupation: 'Synthetic Occupation',
        revision: 1,
      }),
    })
  })

  it('相同内容重复保存不增加 revision', async () => {
    const first = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
    expect(first).toMatchObject({ kind: 'saved', profile: { revision: 1 } })
    const second = await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 1)
    expect(second).toEqual({
      kind: 'saved',
      profile: expect.objectContaining({ revision: 1 }),
    })
  })

  it('修改已有档案增加 revision 并返回新快照', async () => {
    await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
    const result = await ownerRepo.save(conversationId, ownerId, {
      ...syntheticUpdate(1),
      family: 'Synthetic Family Note',
    })
    expect(result).toEqual({
      kind: 'saved',
      profile: expect.objectContaining({
        family: 'Synthetic Family Note',
        revision: 2,
      }),
    })
  })

  it('旧 revision 返回冲突且不覆盖服务器档案', async () => {
    await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
    const result = await ownerRepo.save(conversationId, ownerId, {
      ...syntheticUpdate(0),
      name: 'Stale Draft',
    })
    expect(result).toEqual({ kind: 'conflict', currentRevision: 1 })
    expect((await ownerRepo.get(conversationId))?.name).toBe('Synthetic Name')
  })

  it('两个 expectedRevision 0 并发首建只有一个成功', async () => {
    const [left, right] = await Promise.all([
      saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0),
      saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0),
    ])
    expect([left.kind, right.kind].sort()).toEqual(['conflict', 'saved'])
  })

  it('不可见会话既读不到也写不入档案', async () => {
    expect(await outsiderRepo.get(conversationId)).toBeNull()
    expect(await outsiderRepo.save(conversationId, outsiderId, syntheticUpdate(0)))
      .toEqual({ kind: 'not_found' })
  })

  it('写入步骤失败时整个事务回滚', async () => {
    const unknownActorId = '00000000-0000-4000-8000-000000000099'
    await expect(ownerRepo.save(conversationId, unknownActorId, syntheticUpdate(0)))
      .rejects.toThrow()
    expect(await ownerRepo.get(conversationId)).toEqual(emptyCustomerProfile(conversationId))
  })

  it('删除会话会级联删除档案', async () => {
    await saveSyntheticProfile(ownerRepo, conversationId, ownerId, 0)
    await db.deleteFrom('conversations').where('id', '=', conversationId).execute()
    expect(await db.selectFrom('customer_profiles').selectAll().execute()).toEqual([])
  })
})
