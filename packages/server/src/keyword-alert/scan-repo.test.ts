import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import {
  KyselyKeywordAlertScanRepo,
  type ActiveKeywordRule,
  type KeywordAlertScanJob,
} from './scan-repo.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const repo = new KyselyKeywordAlertScanRepo(db)
const baseTime = new Date('2026-09-03T10:00:00.000Z')

interface Fixture {
  ownerId: string
  auditorId: string
  disabledAuditorId: string
  managerId: string
  unrelatedManagerId: string
  agentId: string
  unrelatedAgentId: string
  teamId: string
  unrelatedTeamId: string
  accountId: string
  conversationId: string
  messageId: string
}

beforeEach(async () => {
  await db.deleteFrom('keyword_alert_recipients').execute()
  await db.deleteFrom('keyword_alerts').execute()
  await db.deleteFrom('keyword_alert_scan_jobs').execute()
  await db.deleteFrom('keyword_rules').execute()
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('message_reactions').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('teams').execute()
  await db.deleteFrom('users').execute()
})

afterAll(async () => db.destroy())

async function insertUser(
  label: string,
  role: Role,
  disabledAt: Date | null = null,
): Promise<string> {
  const row = await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.com`,
    display_name: label,
    role,
    password_hash: 'test-only',
    disabled_at: disabledAt,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

async function seedFixture(): Promise<Fixture> {
  const ownerId = await insertUser('owner', 'owner')
  const auditorId = await insertUser('auditor', 'auditor')
  const disabledAuditorId = await insertUser('disabled-auditor', 'auditor', baseTime)
  const managerId = await insertUser('manager', 'manager')
  const unrelatedManagerId = await insertUser('unrelated-manager', 'manager')
  const agentId = await insertUser('account-agent', 'agent')
  const unrelatedAgentId = await insertUser('unrelated-agent', 'agent')
  const teamId = (await db.insertInto('teams').values({ name: 'Sales A' })
    .returning('id').executeTakeFirstOrThrow()).id
  const unrelatedTeamId = (await db.insertInto('teams').values({ name: 'Sales B' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: managerId, is_lead: true },
    { team_id: unrelatedTeamId, user_id: unrelatedManagerId, is_lead: true },
    { team_id: teamId, user_id: agentId, is_lead: false },
  ]).execute()
  const accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: agentId,
    team_id: teamId,
    display_name: 'Fixture account',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: 'fixture-conversation',
    contact_external_id: 'fixture-contact',
    contact_display_name: 'Fixture contact',
  }).returning('id').executeTakeFirstOrThrow()).id
  const messageId = await insertMessage(accountId, conversationId, 'fixture-message')

  return {
    ownerId,
    auditorId,
    disabledAuditorId,
    managerId,
    unrelatedManagerId,
    agentId,
    unrelatedAgentId,
    teamId,
    unrelatedTeamId,
    accountId,
    conversationId,
    messageId,
  }
}

async function insertMessage(
  accountId: string,
  conversationId: string,
  platformMessageId: string,
): Promise<string> {
  const row = await db.insertInto('messages').values({
    conversation_id: conversationId,
    account_id: accountId,
    platform: 'telegram',
    platform_message_id: platformMessageId,
    direction: 'in',
    sender_external_id: 'fixture-sender',
    body: 'current message body',
    body_lang: null,
    media_refs: JSON.stringify([]) as never,
    reply_to_platform_message_id: null,
    edited_at: null,
    edit_version: null,
    deleted_at: null,
    sent_at: baseTime,
    raw: JSON.stringify({}) as never,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

async function insertJob(
  messageId: string,
  options: {
    id?: string
    revision?: string
    body?: string
    createdAt?: Date
    availableAt?: Date
    attemptCount?: number
    leaseOwner?: string | null
    leaseExpiresAt?: Date | null
    lastErrorCode?: string | null
  } = {},
): Promise<string> {
  const row = await db.insertInto('keyword_alert_scan_jobs').values({
    ...(options.id ? { id: options.id } : {}),
    message_id: messageId,
    message_revision: options.revision ?? 'initial',
    body_snapshot: options.body ?? 'refund requested',
    created_at: options.createdAt ?? baseTime,
    available_at: options.availableAt ?? baseTime,
    attempt_count: options.attemptCount ?? 0,
    lease_owner: options.leaseOwner ?? null,
    lease_expires_at: options.leaseExpiresAt ?? null,
    last_error_code: options.lastErrorCode ?? null,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

async function insertRule(
  ownerId: string,
  options: {
    pattern?: string
    normalizedPattern?: string
    severity?: 'normal' | 'important' | 'urgent'
    enabled?: boolean
    revision?: number
    effectiveAt?: Date
    deletedAt?: Date | null
  } = {},
): Promise<string> {
  const row = await db.insertInto('keyword_rules').values({
    pattern: options.pattern ?? 'Refund',
    normalized_pattern: options.normalizedPattern ?? 'refund',
    severity: options.severity ?? 'urgent',
    enabled: options.enabled ?? true,
    revision: options.revision ?? 1,
    effective_at: options.effectiveAt ?? new Date('2026-09-03T09:00:00.000Z'),
    created_by_user_id: ownerId,
    updated_by_user_id: ownerId,
    created_at: new Date('2026-09-03T09:00:00.000Z'),
    updated_at: new Date('2026-09-03T09:00:00.000Z'),
    deleted_at: options.deletedAt ?? null,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

function findClaimedJob(
  jobs: readonly KeywordAlertScanJob[],
  id: string,
): KeywordAlertScanJob {
  const found = jobs.find(job => job.id === id)
  if (!found) throw new Error('expected claimed fixture job')
  return found
}

function findRule(rules: readonly ActiveKeywordRule[], id: string): ActiveKeywordRule {
  const found = rules.find(rule => rule.id === id)
  if (!found) throw new Error('expected active fixture rule')
  return found
}

describe('KyselyKeywordAlertScanRepo.claimBatch', () => {
  it('按 created_at,id 顺序领取最多 20 个符合条件的任务并设置 60 秒租约', async () => {
    const fixture = await seedFixture()
    const insertedJobs: Array<{ id: string; createdAt: Date }> = []
    for (let index = 22; index >= 1; index -= 1) {
      const messageId = index === 1
        ? fixture.messageId
        : await insertMessage(fixture.accountId, fixture.conversationId, `message-${index}`)
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      const createdAt = index > 11
        ? new Date('2026-09-03T09:59:00.000Z')
        : baseTime
      await insertJob(messageId, { id, createdAt })
      insertedJobs.push({ id, createdAt })
    }

    const claimed = await repo.claimBatch('worker-1', baseTime)

    expect(claimed.map(job => job.id)).toEqual(insertedJobs
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id))
      .slice(0, 20)
      .map(job => job.id))
    const leased = await db.selectFrom('keyword_alert_scan_jobs')
      .select(['id', 'lease_owner', 'lease_expires_at'])
      .where('id', 'in', claimed.map(job => job.id))
      .orderBy('id')
      .execute()
    expect(leased).toHaveLength(20)
    expect(leased.every(row => row.lease_owner === 'worker-1')).toBe(true)
    expect(leased.every(row => row.lease_expires_at?.toISOString()
      === '2026-09-03T10:01:00.000Z')).toBe(true)
  })

  it('未过期租约不被重领，租约到期后可由其他 worker 恢复', async () => {
    const fixture = await seedFixture()
    const jobId = await insertJob(fixture.messageId)

    await expect(repo.claimBatch('worker-1', baseTime)).resolves.toHaveLength(1)
    await expect(repo.claimBatch(
      'worker-2',
      new Date('2026-09-03T10:00:59.999Z'),
    )).resolves.toEqual([])
    const reclaimed = await repo.claimBatch(
      'worker-2',
      new Date('2026-09-03T10:01:00.000Z'),
    )

    expect(reclaimed.map(job => job.id)).toEqual([jobId])
    const row = await db.selectFrom('keyword_alert_scan_jobs')
      .select(['lease_owner', 'lease_expires_at'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      lease_owner: 'worker-2',
      lease_expires_at: new Date('2026-09-03T10:02:00.000Z'),
    })
  })

  it('使用 SKIP LOCKED 跳过另一事务正在处理的首行', async () => {
    const fixture = await seedFixture()
    const firstJobId = await insertJob(fixture.messageId, {
      id: '00000000-0000-4000-8000-000000000001',
    })
    const secondMessageId = await insertMessage(
      fixture.accountId,
      fixture.conversationId,
      'second-message',
    )
    const secondJobId = await insertJob(secondMessageId, {
      id: '00000000-0000-4000-8000-000000000002',
    })

    await db.transaction().execute(async trx => {
      await trx.selectFrom('keyword_alert_scan_jobs')
        .select('id')
        .where('id', '=', firstJobId)
        .forUpdate()
        .executeTakeFirstOrThrow()

      const claimed = await repo.claimBatch('worker-2', baseTime)
      expect(claimed.map(job => job.id)).toEqual([secondJobId])
    })
  })
})

describe('KyselyKeywordAlertScanRepo.complete', () => {
  it('同一事务创建每条命中规则的告警和接收人并删除含正文任务', async () => {
    const fixture = await seedFixture()
    const firstRuleId = await insertRule(fixture.ownerId)
    const secondRuleId = await insertRule(fixture.ownerId, {
      pattern: 'Chargeback',
      normalizedPattern: 'chargeback',
      severity: 'important',
    })
    const jobId = await insertJob(fixture.messageId, { body: 'refund and chargeback' })
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)
    const activeRules = await repo.loadActiveRules()
    const matchedRules = [
      findRule(activeRules, secondRuleId),
      findRule(activeRules, firstRuleId),
    ]

    const deliveries = await repo.complete('worker-1', claimed, matchedRules)

    const alerts = await db.selectFrom('keyword_alerts')
      .select([
        'id', 'rule_id', 'pattern_snapshot', 'severity_snapshot',
        'matched_message_revision', 'created_at',
      ])
      .orderBy('rule_id')
      .execute()
    expect(alerts).toHaveLength(2)
    expect(alerts.map(alert => ({
      ruleId: alert.rule_id,
      pattern: alert.pattern_snapshot,
      severity: alert.severity_snapshot,
      revision: alert.matched_message_revision,
    }))).toEqual([
      { ruleId: firstRuleId, pattern: 'Refund', severity: 'urgent', revision: 'initial' },
      { ruleId: secondRuleId, pattern: 'Chargeback', severity: 'important', revision: 'initial' },
    ].sort((left, right) => left.ruleId.localeCompare(right.ruleId)))
    expect(await db.selectFrom('keyword_alert_scan_jobs').select('id')
      .where('id', '=', jobId).execute()).toEqual([])
    expect(deliveries).toHaveLength(8)
    expect(deliveries.every(delivery => delivery.event.type === 'keyword_alert')).toBe(true)
    expect(JSON.stringify(deliveries)).not.toContain('refund and chargeback')
    expect(JSON.stringify(deliveries)).not.toContain('Chargeback')
  })

  it('重放已经完成的任务不重复创建告警、接收人或实时投递', async () => {
    const fixture = await seedFixture()
    const ruleId = await insertRule(fixture.ownerId)
    const jobId = await insertJob(fixture.messageId)
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)
    const activeRule = findRule(await repo.loadActiveRules(), ruleId)

    const first = await repo.complete('worker-1', claimed, [activeRule])
    const replay = await repo.complete('worker-1', claimed, [activeRule])

    expect(first).toHaveLength(4)
    expect(replay).toEqual([])
    expect(await db.selectFrom('keyword_alerts').select('id').execute()).toHaveLength(1)
    expect(await db.selectFrom('keyword_alert_recipients').select('user_id').execute())
      .toHaveLength(4)
  })

  it('没有命中规则时仍删除任务且不创建告警', async () => {
    const fixture = await seedFixture()
    const jobId = await insertJob(fixture.messageId, { body: 'ordinary question' })
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)

    await expect(repo.complete('worker-1', claimed, [])).resolves.toEqual([])

    expect(await db.selectFrom('keyword_alert_scan_jobs').select('id').execute()).toEqual([])
    expect(await db.selectFrom('keyword_alerts').select('id').execute()).toEqual([])
  })

  it('编辑首次命中会创建告警，后续命中保留第一次 revision 和规则快照', async () => {
    const fixture = await seedFixture()
    const ruleId = await insertRule(fixture.ownerId)
    const initialJobId = await insertJob(fixture.messageId, {
      body: 'ordinary question',
      revision: 'initial',
    })
    const initialJob = findClaimedJob(
      await repo.claimBatch('worker-1', baseTime),
      initialJobId,
    )
    await repo.complete('worker-1', initialJob, [])

    const firstMatchAt = new Date('2026-09-03T10:01:00.000Z')
    const firstMatchJobId = await insertJob(fixture.messageId, {
      body: 'refund requested',
      revision: 'edit-1',
      createdAt: firstMatchAt,
      availableAt: firstMatchAt,
    })
    const firstMatchJob = findClaimedJob(
      await repo.claimBatch('worker-1', firstMatchAt),
      firstMatchJobId,
    )
    await repo.complete(
      'worker-1',
      firstMatchJob,
      [findRule(await repo.loadActiveRules(), ruleId)],
    )

    await db.updateTable('keyword_rules').set({
      pattern: 'Reimbursement',
      normalized_pattern: 'reimbursement',
      severity: 'normal',
      revision: 2,
      effective_at: new Date('2026-09-03T10:02:00.000Z'),
    }).where('id', '=', ruleId).execute()
    const laterMatchAt = new Date('2026-09-03T10:03:00.000Z')
    const laterJobId = await insertJob(fixture.messageId, {
      body: 'reimbursement requested',
      revision: 'edit-2',
      createdAt: laterMatchAt,
      availableAt: laterMatchAt,
    })
    const laterJob = findClaimedJob(
      await repo.claimBatch('worker-1', laterMatchAt),
      laterJobId,
    )
    await expect(repo.complete(
      'worker-1',
      laterJob,
      [findRule(await repo.loadActiveRules(), ruleId)],
    )).resolves.toEqual([])

    expect(await db.selectFrom('keyword_alerts').select([
      'pattern_snapshot', 'severity_snapshot', 'matched_message_revision',
    ]).execute()).toEqual([{
      pattern_snapshot: 'Refund',
      severity_snapshot: 'urgent',
      matched_message_revision: 'edit-1',
    }])
    expect(await db.selectFrom('keyword_alert_scan_jobs').select('id').execute()).toEqual([])
  })

  it.each(['disabled', 'deleted', 'edited'] as const)(
    '规则在加载后被 %s 时，旧 revision 不创建告警',
    async mutation => {
      const fixture = await seedFixture()
      const ruleId = await insertRule(fixture.ownerId)
      const jobId = await insertJob(fixture.messageId)
      const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)
      const staleRule = findRule(await repo.loadActiveRules(), ruleId)

      if (mutation === 'disabled') {
        await db.updateTable('keyword_rules').set({ enabled: false })
          .where('id', '=', ruleId).execute()
      } else if (mutation === 'deleted') {
        await db.updateTable('keyword_rules').set({ deleted_at: baseTime })
          .where('id', '=', ruleId).execute()
      } else {
        await db.updateTable('keyword_rules').set({
          pattern: 'Changed pattern',
          normalized_pattern: 'changed pattern',
          severity: 'normal',
          revision: 2,
          effective_at: baseTime,
        }).where('id', '=', ruleId).execute()
      }

      await expect(repo.complete('worker-1', claimed, [staleRule])).resolves.toEqual([])
      expect(await db.selectFrom('keyword_alerts').select('id').execute()).toEqual([])
      expect(await db.selectFrom('keyword_alert_scan_jobs').select('id').execute()).toEqual([])
    },
  )

  it('快照全部有效 owner/auditor、账号团队 lead manager 和账号所属 agent 并去重', async () => {
    const fixture = await seedFixture()
    const ruleId = await insertRule(fixture.ownerId)
    const jobId = await insertJob(fixture.messageId)
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)
    await repo.complete(
      'worker-1',
      claimed,
      [findRule(await repo.loadActiveRules(), ruleId)],
    )
    const alert = await db.selectFrom('keyword_alerts').select('id')
      .executeTakeFirstOrThrow()

    const recipients = await db.selectFrom('keyword_alert_recipients')
      .select(['user_id', 'requires_ack'])
      .where('alert_id', '=', alert.id)
      .orderBy('user_id')
      .execute()

    expect(recipients).toEqual([
      { user_id: fixture.agentId, requires_ack: true },
      { user_id: fixture.auditorId, requires_ack: false },
      { user_id: fixture.managerId, requires_ack: true },
      { user_id: fixture.ownerId, requires_ack: true },
    ].sort((left, right) => left.user_id.localeCompare(right.user_id)))
    expect(recipients.map(recipient => recipient.user_id)).not.toContain(fixture.disabledAuditorId)
    expect(recipients.map(recipient => recipient.user_id)).not.toContain(fixture.unrelatedManagerId)
    expect(recipients.map(recipient => recipient.user_id)).not.toContain(fixture.unrelatedAgentId)
  })

  it('无团队账号不包含 manager，但仍包含 owner、auditor 和账号所属 agent', async () => {
    const fixture = await seedFixture()
    await db.updateTable('accounts').set({ team_id: null })
      .where('id', '=', fixture.accountId).execute()
    const ruleId = await insertRule(fixture.ownerId)
    const jobId = await insertJob(fixture.messageId)
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)

    await repo.complete(
      'worker-1',
      claimed,
      [findRule(await repo.loadActiveRules(), ruleId)],
    )

    expect(await db.selectFrom('keyword_alert_recipients')
      .select(['user_id', 'requires_ack'])
      .orderBy('user_id')
      .execute()).toEqual([
      { user_id: fixture.agentId, requires_ack: true },
      { user_id: fixture.auditorId, requires_ack: false },
      { user_id: fixture.ownerId, requires_ack: true },
    ].sort((left, right) => left.user_id.localeCompare(right.user_id)))
  })

  it('错误 worker 不能完成不属于自己的租约', async () => {
    const fixture = await seedFixture()
    const ruleId = await insertRule(fixture.ownerId)
    const jobId = await insertJob(fixture.messageId)
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)

    await expect(repo.complete(
      'worker-2',
      claimed,
      [findRule(await repo.loadActiveRules(), ruleId)],
    )).resolves.toEqual([])

    expect(await db.selectFrom('keyword_alert_scan_jobs').select('id').execute())
      .toEqual([{ id: jobId }])
    expect(await db.selectFrom('keyword_alerts').select('id').execute()).toEqual([])
  })
})

describe('KyselyKeywordAlertScanRepo failure recovery', () => {
  it('fail 只增一次 attempt、清租约、写固定代码并按新 attempt 精确退避', async () => {
    const fixture = await seedFixture()
    const firstJobId = await insertJob(fixture.messageId)
    const firstJob = findClaimedJob(await repo.claimBatch('worker-1', baseTime), firstJobId)

    await repo.fail('worker-1', firstJob, baseTime, 'scan_failed')

    expect(await db.selectFrom('keyword_alert_scan_jobs').select([
      'attempt_count', 'available_at', 'lease_owner', 'lease_expires_at', 'last_error_code',
    ]).where('id', '=', firstJobId).executeTakeFirstOrThrow()).toEqual({
      attempt_count: 1,
      available_at: new Date('2026-09-03T10:00:01.000Z'),
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: 'scan_failed',
    })

    const secondMessageId = await insertMessage(
      fixture.accountId,
      fixture.conversationId,
      'attempt-ten-message',
    )
    const tenthJobId = await insertJob(secondMessageId, { attemptCount: 9 })
    const tenthJob = findClaimedJob(await repo.claimBatch('worker-1', baseTime), tenthJobId)
    await repo.fail('worker-1', tenthJob, baseTime, 'scan_failed')

    expect(await db.selectFrom('keyword_alert_scan_jobs').select([
      'attempt_count', 'available_at', 'lease_owner', 'lease_expires_at', 'last_error_code',
    ]).where('id', '=', tenthJobId).executeTakeFirstOrThrow()).toEqual({
      attempt_count: 10,
      available_at: new Date('2026-09-03T10:05:00.000Z'),
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: 'scan_failed',
    })
  })

  it('错误 worker 不能增加 attempt 或改写租约', async () => {
    const fixture = await seedFixture()
    const jobId = await insertJob(fixture.messageId)
    const claimed = findClaimedJob(await repo.claimBatch('worker-1', baseTime), jobId)

    await repo.fail('worker-2', claimed, baseTime, 'scan_failed')

    expect(await db.selectFrom('keyword_alert_scan_jobs').select([
      'attempt_count', 'lease_owner', 'lease_expires_at', 'last_error_code',
    ]).where('id', '=', jobId).executeTakeFirstOrThrow()).toEqual({
      attempt_count: 0,
      lease_owner: 'worker-1',
      lease_expires_at: new Date('2026-09-03T10:01:00.000Z'),
      last_error_code: null,
    })
  })

  it('第 10 次失败不再自动领取、计入 degraded，owner retry 后归零并立即恢复', async () => {
    const fixture = await seedFixture()
    const jobId = await insertJob(fixture.messageId, {
      attemptCount: 10,
      availableAt: new Date('2026-09-03T09:55:00.000Z'),
      lastErrorCode: 'scan_failed',
    })

    await expect(repo.claimBatch('worker-1', baseTime)).resolves.toEqual([])
    await expect(repo.countDegraded()).resolves.toBe(1)
    await expect(repo.retryDegraded(baseTime)).resolves.toBe(1)
    expect(await db.selectFrom('keyword_alert_scan_jobs').select([
      'attempt_count', 'available_at', 'lease_owner', 'lease_expires_at', 'last_error_code',
    ]).where('id', '=', jobId).executeTakeFirstOrThrow()).toEqual({
      attempt_count: 0,
      available_at: baseTime,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    })
    await expect(repo.countDegraded()).resolves.toBe(0)
    await expect(repo.claimBatch('worker-2', baseTime)).resolves.toEqual([
      expect.objectContaining({ id: jobId, attemptCount: 0 }),
    ])
  })
})
