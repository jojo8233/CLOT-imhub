import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import {
  KeywordRuleRepo,
  type KeywordAlertScanMaintenance,
} from './rule-repo.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

class InMemoryScanMaintenance implements KeywordAlertScanMaintenance {
  constructor(private degradedCount: number) {}

  async countDegraded(): Promise<number> {
    return this.degradedCount
  }

  async retryDegraded(): Promise<number> {
    const retried = this.degradedCount
    this.degradedCount = 0
    return retried
  }
}

let repo: KeywordRuleRepo

beforeEach(async () => {
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
  repo = new KeywordRuleRepo(db, new InMemoryScanMaintenance(2))
})

afterAll(async () => db.destroy())

async function insertUser(label: string, role: Role = 'owner'): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: 'test-only',
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function insertMessage(ownerId: string): Promise<string> {
  const accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: ownerId,
    display_name: 'Synthetic rule account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `rule-conversation-${randomUUID()}`,
    contact_external_id: `rule-contact-${randomUUID()}`,
  }).returning('id').executeTakeFirstOrThrow()).id
  return (await db.insertInto('messages').values({
    conversation_id: conversationId,
    account_id: accountId,
    platform: 'telegram',
    platform_message_id: `rule-message-${randomUUID()}`,
    direction: 'in',
    sender_external_id: 'synthetic-sender',
    body: 'refund requested',
    sent_at: new Date('2026-09-03T10:00:00.000Z'),
    media_refs: JSON.stringify([]) as never,
    raw: JSON.stringify({}) as never,
  }).returning('id').executeTakeFirstOrThrow()).id
}

describe('KeywordRuleRepo', () => {
  it('按 revision 原子创建、修改、停用、重启和软删除，删除后可重建', async () => {
    const ownerId = await insertUser('rule-owner')
    const nextOwnerId = await insertUser('next-rule-actor', 'agent')
    const created = await repo.create(ownerId, {
      pattern: '  ＲＥＦＵＮＤ  ', severity: 'important', enabled: true,
    })
    expect(created).toMatchObject({
      kind: 'created',
      rule: { pattern: 'ＲＥＦＵＮＤ', severity: 'important', enabled: true, revision: 1 },
    })
    if (created.kind !== 'created') throw new Error('expected created rule')
    expect(Object.keys(created.rule).sort()).toEqual([
      'createdAt', 'effectiveAt', 'enabled', 'id', 'pattern',
      'revision', 'severity', 'updatedAt',
    ])

    await db.updateTable('keyword_rules').set({
      effective_at: new Date('2000-01-01T00:00:00.000Z'),
      updated_at: new Date('2000-01-01T00:00:00.000Z'),
    }).where('id', '=', created.rule.id).execute()
    expect(await repo.update(created.rule.id, nextOwnerId, {
      baseRevision: 1, enabled: false,
    })).toMatchObject({ kind: 'updated', rule: { revision: 2, enabled: false } })
    expect(await repo.create(ownerId, {
      pattern: 'refund', severity: 'normal', enabled: true,
    })).toEqual({ kind: 'duplicate' })
    expect(await repo.update(created.rule.id, ownerId, {
      baseRevision: 1, severity: 'urgent',
    })).toEqual({ kind: 'conflict', currentRevision: 2 })
    expect(await repo.update(created.rule.id, nextOwnerId, {
      baseRevision: 2, severity: 'urgent',
    })).toMatchObject({ kind: 'updated', rule: { revision: 3, severity: 'urgent' } })
    expect(await repo.update(created.rule.id, nextOwnerId, {
      baseRevision: 3, enabled: true,
    })).toMatchObject({ kind: 'updated', rule: { revision: 4, enabled: true } })

    const mutationRow = await db.selectFrom('keyword_rules').select([
      'effective_at', 'updated_at', 'updated_by_user_id',
    ]).where('id', '=', created.rule.id).executeTakeFirstOrThrow()
    expect(mutationRow.updated_by_user_id).toBe(nextOwnerId)
    expect(mutationRow.effective_at.getUTCFullYear()).toBeGreaterThan(2000)
    expect(mutationRow.updated_at).toEqual(mutationRow.effective_at)

    const messageId = await insertMessage(ownerId)
    const alertId = (await db.insertInto('keyword_alerts').values({
      message_id: messageId,
      rule_id: created.rule.id,
      pattern_snapshot: created.rule.pattern,
      severity_snapshot: created.rule.severity,
      matched_message_revision: 'initial',
    }).returning('id').executeTakeFirstOrThrow()).id
    expect(await repo.remove(created.rule.id, nextOwnerId, 3))
      .toEqual({ kind: 'conflict', currentRevision: 4 })
    expect(await repo.remove(created.rule.id, nextOwnerId, 4)).toEqual({ kind: 'removed' })
    expect(await repo.list()).toEqual({ rules: [], degradedScanCount: 2 })
    expect(await db.selectFrom('keyword_alerts').select('id')
      .where('id', '=', alertId).executeTakeFirstOrThrow()).toEqual({ id: alertId })
    expect(await db.selectFrom('keyword_rules').select([
      'enabled', 'revision', 'deleted_at', 'updated_by_user_id',
    ]).where('id', '=', created.rule.id).executeTakeFirstOrThrow()).toMatchObject({
      enabled: false,
      revision: 5,
      deleted_at: expect.any(Date),
      updated_by_user_id: nextOwnerId,
    })
    expect(await repo.create(ownerId, {
      pattern: 'refund', severity: 'normal', enabled: true,
    })).toMatchObject({ kind: 'created', rule: { pattern: 'refund', revision: 1 } })
  })

  it('不存在或已软删除的规则不会被更新或再次删除', async () => {
    const ownerId = await insertUser('missing-owner')
    const missingId = randomUUID()
    expect(await repo.update(missingId, ownerId, { baseRevision: 1, enabled: false }))
      .toEqual({ kind: 'not_found' })
    expect(await repo.remove(missingId, ownerId, 1)).toEqual({ kind: 'not_found' })
    const created = await repo.create(ownerId, {
      pattern: 'chargeback', severity: 'urgent', enabled: true,
    })
    if (created.kind !== 'created') throw new Error('expected created rule')
    expect(await repo.remove(created.rule.id, ownerId, 1)).toEqual({ kind: 'removed' })
    expect(await repo.update(created.rule.id, ownerId, { baseRevision: 2, enabled: true }))
      .toEqual({ kind: 'not_found' })
    expect(await repo.remove(created.rule.id, ownerId, 2)).toEqual({ kind: 'not_found' })
  })

  it('软删竞态后旧 revision 仍返回删除版本 conflict，当前删除 revision 才返回 not_found', async () => {
    const ownerId = await insertUser('deleted-conflict-owner')
    const created = await repo.create(ownerId, {
      pattern: 'shipment delay', severity: 'important', enabled: true,
    })
    if (created.kind !== 'created') throw new Error('expected created rule')
    expect(await repo.update(created.rule.id, ownerId, {
      baseRevision: 1, enabled: false,
    })).toMatchObject({ kind: 'updated', rule: { revision: 2 } })
    expect(await repo.remove(created.rule.id, ownerId, 2)).toEqual({ kind: 'removed' })

    expect(await repo.update(created.rule.id, ownerId, {
      baseRevision: 1, severity: 'urgent',
    })).toEqual({ kind: 'conflict', currentRevision: 3 })
    expect(await repo.remove(created.rule.id, ownerId, 2))
      .toEqual({ kind: 'conflict', currentRevision: 3 })
    expect(await repo.update(created.rule.id, ownerId, {
      baseRevision: 3, enabled: true,
    })).toEqual({ kind: 'not_found' })
    expect(await repo.remove(created.rule.id, ownerId, 3)).toEqual({ kind: 'not_found' })
  })

  it('list 和 retry 只通过注入的 scan maintenance 暴露 degraded 状态', async () => {
    expect(await repo.list()).toEqual({ rules: [], degradedScanCount: 2 })
    expect(await repo.retryDegraded(new Date('2026-09-03T10:00:00.000Z')))
      .toEqual({ retried: 2 })
    expect(await repo.list()).toEqual({ rules: [], degradedScanCount: 0 })
  })
})
