import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  Kysely,
  PostgresDialect,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely'
import pg from 'pg'
import type { KeywordAlertListItem, Role, ScopeFilter } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { ScopedKeywordAlertRepo } from './scoped-repo.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

const matchedAt = new Date('2026-09-03T10:00:00.000Z')
const acknowledgedAt = new Date('2026-09-03T10:05:00.000Z')
const lowerAlertId = '00000000-0000-4000-8000-000000000001'
const higherAlertId = '00000000-0000-4000-8000-000000000002'
const sameTimestampHigherAlertId = '00000000-0000-4000-8000-000000000003'

interface Fixture {
  ownerId: string
  auditorId: string
  managerAId: string
  managerBId: string
  newManagerId: string
  agentAId: string
  agentBId: string
  teamAId: string
  teamBId: string
  accountAId: string
  accountBId: string
  alertAId: string
  alertBId: string
  messageAId: string
  messageBId: string
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

beforeEach(cleanDatabase)

afterAll(async () => {
  await cleanDatabase()
  await db.destroy()
})

async function insertUser(label: string, role: Role): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: label,
    role,
    password_hash: 'test-only',
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function insertAccount(
  ownerUserId: string,
  teamId: string,
  label: string,
  platform: 'telegram' | 'signal',
): Promise<{ accountId: string; conversationId: string }> {
  const accountId = (await db.insertInto('accounts').values({
    platform,
    owner_user_id: ownerUserId,
    team_id: teamId,
    display_name: `${label} account`,
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  const conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: `${label}-external-conversation`,
    contact_external_id: `${label}-external-contact`,
    contact_display_name: `${label} customer`,
  }).returning('id').executeTakeFirstOrThrow()).id
  return { accountId, conversationId }
}

async function insertAlert(input: {
  id: string
  ownerId: string
  accountId: string
  conversationId: string
  platform: 'telegram' | 'signal'
  body: string
  pattern: string
  severity: 'normal' | 'important' | 'urgent'
  recipients: Array<{ userId: string; requiresAck: boolean; acknowledgedAt?: Date }>
}): Promise<{ alertId: string; messageId: string }> {
  const messageId = (await db.insertInto('messages').values({
    conversation_id: input.conversationId,
    account_id: input.accountId,
    platform: input.platform,
    platform_message_id: `external-message-${randomUUID()}`,
    direction: 'in',
    sender_external_id: `external-sender-${randomUUID()}`,
    body: input.body,
    body_lang: null,
    media_refs: JSON.stringify([{ private: 'media-reference' }]) as never,
    reply_to_platform_message_id: `external-reply-${randomUUID()}`,
    edited_at: null,
    edit_version: null,
    deleted_at: null,
    sent_at: matchedAt,
    raw: JSON.stringify({ private: 'raw-payload' }) as never,
  }).returning('id').executeTakeFirstOrThrow()).id
  const ruleId = (await db.insertInto('keyword_rules').values({
    pattern: input.pattern,
    normalized_pattern: `${input.pattern.toLowerCase()}-${randomUUID()}`,
    severity: input.severity,
    enabled: true,
    revision: 1,
    effective_at: new Date('2026-09-03T09:00:00.000Z'),
    created_by_user_id: input.ownerId,
    updated_by_user_id: input.ownerId,
    created_at: new Date('2026-09-03T09:00:00.000Z'),
    updated_at: new Date('2026-09-03T09:00:00.000Z'),
    deleted_at: null,
  }).returning('id').executeTakeFirstOrThrow()).id
  const alertId = (await db.insertInto('keyword_alerts').values({
    id: input.id,
    message_id: messageId,
    rule_id: ruleId,
    pattern_snapshot: input.pattern,
    severity_snapshot: input.severity,
    matched_message_revision: 'initial',
    created_at: matchedAt,
  }).returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('keyword_alert_recipients').values(input.recipients.map(recipient => ({
    alert_id: alertId,
    user_id: recipient.userId,
    requires_ack: recipient.requiresAck,
    acknowledged_at: recipient.acknowledgedAt ?? null,
    created_at: matchedAt,
  }))).execute()
  return { alertId, messageId }
}

async function seedFixture(): Promise<Fixture> {
  const ownerId = await insertUser('owner', 'owner')
  const auditorId = await insertUser('auditor', 'auditor')
  const managerAId = await insertUser('manager-a', 'manager')
  const managerBId = await insertUser('manager-b', 'manager')
  const newManagerId = await insertUser('manager-new', 'manager')
  const agentAId = await insertUser('agent-a', 'agent')
  const agentBId = await insertUser('agent-b', 'agent')
  const teamAId = (await db.insertInto('teams').values({ name: 'Team A' })
    .returning('id').executeTakeFirstOrThrow()).id
  const teamBId = (await db.insertInto('teams').values({ name: 'Team B' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: teamAId, user_id: managerAId, is_lead: true },
    { team_id: teamBId, user_id: managerBId, is_lead: true },
    { team_id: teamAId, user_id: newManagerId, is_lead: true },
  ]).execute()
  const accountA = await insertAccount(agentAId, teamAId, 'A', 'telegram')
  const accountB = await insertAccount(agentBId, teamBId, 'B', 'signal')
  const alertA = await insertAlert({
    id: lowerAlertId,
    ownerId,
    accountId: accountA.accountId,
    conversationId: accountA.conversationId,
    platform: 'telegram',
    body: 'customer asks for REFUND today',
    pattern: 'Refund',
    severity: 'urgent',
    recipients: [
      { userId: ownerId, requiresAck: true },
      { userId: auditorId, requiresAck: false },
      { userId: managerAId, requiresAck: true },
      { userId: agentAId, requiresAck: true },
    ],
  })
  const alertB = await insertAlert({
    id: higherAlertId,
    ownerId,
    accountId: accountB.accountId,
    conversationId: accountB.conversationId,
    platform: 'signal',
    body: 'customer reports a CHARGEBACK',
    pattern: 'Chargeback',
    severity: 'important',
    recipients: [
      { userId: ownerId, requiresAck: true, acknowledgedAt },
      { userId: auditorId, requiresAck: false },
      { userId: managerBId, requiresAck: true },
      { userId: agentBId, requiresAck: true },
    ],
  })
  return {
    ownerId,
    auditorId,
    managerAId,
    managerBId,
    newManagerId,
    agentAId,
    agentBId,
    teamAId,
    teamBId,
    accountAId: accountA.accountId,
    accountBId: accountB.accountId,
    alertAId: alertA.alertId,
    alertBId: alertB.alertId,
    messageAId: alertA.messageId,
    messageBId: alertB.messageId,
  }
}

async function insertBulkAlerts(fixture: Fixture, count: number): Promise<void> {
  const indexes = Array.from({ length: count }, (_, index) => index + 1)
  const ids = indexes.map(index => ({
    ruleId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    messageId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    alertId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    index,
  }))
  await db.insertInto('keyword_rules').values(ids.map(row => ({
    id: row.ruleId,
    pattern: `Bulk ${row.index}`,
    normalized_pattern: `bulk ${row.index}`,
    severity: 'normal' as const,
    enabled: true,
    revision: 1,
    effective_at: new Date('2026-09-03T09:00:00.000Z'),
    created_by_user_id: fixture.ownerId,
    updated_by_user_id: fixture.ownerId,
    created_at: new Date('2026-09-03T09:00:00.000Z'),
    updated_at: new Date('2026-09-03T09:00:00.000Z'),
    deleted_at: null,
  }))).execute()
  const conversationId = (await db.selectFrom('conversations').select('id')
    .where('account_id', '=', fixture.accountAId).executeTakeFirstOrThrow()).id
  await db.insertInto('messages').values(ids.map(row => ({
    id: row.messageId,
    conversation_id: conversationId,
    account_id: fixture.accountAId,
    platform: 'telegram' as const,
    platform_message_id: `bulk-external-message-${row.index}`,
    direction: 'in' as const,
    sender_external_id: 'bulk-external-sender',
    body: `Bulk ${row.index}`,
    body_lang: null,
    media_refs: JSON.stringify([]) as never,
    reply_to_platform_message_id: null,
    edited_at: null,
    edit_version: null,
    deleted_at: null,
    sent_at: matchedAt,
    raw: JSON.stringify({}) as never,
  }))).execute()
  await db.insertInto('keyword_alerts').values(ids.map(row => ({
    id: row.alertId,
    message_id: row.messageId,
    rule_id: row.ruleId,
    pattern_snapshot: `Bulk ${row.index}`,
    severity_snapshot: 'normal' as const,
    matched_message_revision: 'initial',
    created_at: new Date('2026-09-03T09:59:00.000Z'),
  }))).execute()
  await db.insertInto('keyword_alert_recipients').values(ids.map(row => ({
    alert_id: row.alertId,
    user_id: fixture.ownerId,
    requires_ack: true,
    acknowledged_at: null,
    created_at: matchedAt,
  }))).execute()
}

function repo(scope: ScopeFilter, actorUserId: string): ScopedKeywordAlertRepo {
  return new ScopedKeywordAlertRepo(db, scope, actorUserId)
}

function itemKeys(item: KeywordAlertListItem): string[] {
  return Object.keys(item).sort()
}

function createAcknowledgeBoundaryDatabase(): {
  database: Kysely<Database>
  reached: Promise<void>
  release: () => void
} {
  const postgresDialect = new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  })
  const underlyingDriver = postgresDialect.createDriver()
  const underlyingConnections = new WeakMap<DatabaseConnection, DatabaseConnection>()
  let signalReached: (() => void) | undefined
  const reached = new Promise<void>(resolve => {
    signalReached = resolve
  })
  let resumeQuery: (() => void) | undefined
  const released = new Promise<void>(resolve => {
    resumeQuery = resolve
  })
  let boundaryUsed = false

  const pauseAtBoundary = async (): Promise<void> => {
    const signal = signalReached
    if (signal === undefined) throw new Error('acknowledgement boundary signal unavailable')
    signal()
    await released
  }
  const originalConnection = (connection: DatabaseConnection): DatabaseConnection => (
    underlyingConnections.get(connection) ?? connection
  )
  const driver: Driver = {
    init: () => underlyingDriver.init(),
    async acquireConnection() {
      const connection = await underlyingDriver.acquireConnection()
      const wrapped: DatabaseConnection = {
        async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
          if (boundaryUsed) return connection.executeQuery<R>(compiledQuery)
          boundaryUsed = true
          if (compiledQuery.sql.trimStart().startsWith('select')) {
            const result = await connection.executeQuery<R>(compiledQuery)
            await pauseAtBoundary()
            return result
          }
          await pauseAtBoundary()
          return connection.executeQuery<R>(compiledQuery)
        },
        streamQuery<R>(compiledQuery: CompiledQuery, chunkSize?: number) {
          return connection.streamQuery<R>(compiledQuery, chunkSize)
        },
      }
      underlyingConnections.set(wrapped, connection)
      return wrapped
    },
    beginTransaction: (connection, settings) => underlyingDriver.beginTransaction(
      originalConnection(connection),
      settings,
    ),
    commitTransaction: connection => underlyingDriver.commitTransaction(
      originalConnection(connection),
    ),
    rollbackTransaction: connection => underlyingDriver.rollbackTransaction(
      originalConnection(connection),
    ),
    releaseConnection: connection => underlyingDriver.releaseConnection(
      originalConnection(connection),
    ),
    destroy: () => underlyingDriver.destroy(),
  }
  const dialect: Dialect = {
    createDriver: () => driver,
    createQueryCompiler: () => postgresDialect.createQueryCompiler(),
    createAdapter: () => postgresDialect.createAdapter(),
    createIntrospector: database => postgresDialect.createIntrospector(database),
  }
  return {
    database: new Kysely<Database>({ dialect }),
    reached,
    release: () => {
      const resume = resumeQuery
      if (resume === undefined) throw new Error('acknowledgement boundary release unavailable')
      resume()
    },
  }
}

describe('ScopedKeywordAlertRepo visibility and filters', () => {
  it('当前 recipient 与当前 account scope 必须同时满足，新增 manager 不继承旧告警', async () => {
    const fixture = await seedFixture()

    await expect(repo({ kind: 'all' }, fixture.ownerId).list({ status: 'all' }))
      .resolves.toMatchObject({ items: [{ alertId: fixture.alertBId }, { alertId: fixture.alertAId }] })
    const auditor = await repo({ kind: 'all' }, fixture.auditorId).list({ status: 'all' })
    expect(auditor.items.map(item => item.alertId)).toEqual([fixture.alertBId, fixture.alertAId])
    expect(auditor.items.every(item => item.requiresAcknowledgement === false)).toBe(true)

    expect((await repo(
      { kind: 'teams', teamIds: [fixture.teamAId] },
      fixture.managerAId,
    ).list({ status: 'all' })).items.map(item => item.alertId)).toEqual([fixture.alertAId])
    expect((await repo(
      { kind: 'teams', teamIds: [fixture.teamBId] },
      fixture.managerBId,
    ).list({ status: 'all' })).items.map(item => item.alertId)).toEqual([fixture.alertBId])
    expect((await repo(
      { kind: 'self', userId: fixture.agentAId },
      fixture.agentAId,
    ).list({ status: 'all' })).items.map(item => item.alertId)).toEqual([fixture.alertAId])
    expect((await repo(
      { kind: 'self', userId: fixture.agentBId },
      fixture.agentBId,
    ).list({ status: 'all' })).items.map(item => item.alertId)).toEqual([fixture.alertBId])
    expect((await repo(
      { kind: 'teams', teamIds: [fixture.teamAId] },
      fixture.newManagerId,
    ).list({ status: 'all' })).items).toEqual([])
  })

  it('角色或归属变化后隐藏旧告警，但不删除命中时 recipient 快照', async () => {
    const fixture = await seedFixture()

    expect((await repo(
      { kind: 'teams', teamIds: [fixture.teamBId] },
      fixture.managerAId,
    ).list({ status: 'all' })).items).toEqual([])
    expect(await db.selectFrom('keyword_alert_recipients').select('alert_id')
      .where('alert_id', '=', fixture.alertAId)
      .where('user_id', '=', fixture.managerAId).executeTakeFirst()).toBeDefined()

    await db.updateTable('accounts').set({ owner_user_id: fixture.agentBId })
      .where('id', '=', fixture.accountAId).execute()
    expect((await repo(
      { kind: 'self', userId: fixture.agentAId },
      fixture.agentAId,
    ).list({ status: 'all' })).items).toEqual([])
    expect(await db.selectFrom('keyword_alert_recipients').select('alert_id')
      .where('alert_id', '=', fixture.alertAId)
      .where('user_id', '=', fixture.agentAId).executeTakeFirst()).toBeDefined()
  })

  it('pending、acknowledged、all 与 severity/platform/account 筛选给出精确结果', async () => {
    const fixture = await seedFixture()
    const ownerRepo = repo({ kind: 'all' }, fixture.ownerId)

    expect((await ownerRepo.list({ status: 'pending' })).items.map(item => item.alertId))
      .toEqual([fixture.alertAId])
    expect((await ownerRepo.list({ status: 'acknowledged' })).items.map(item => item.alertId))
      .toEqual([fixture.alertBId])
    expect((await ownerRepo.list({ status: 'all' })).items.map(item => item.alertId))
      .toEqual([fixture.alertBId, fixture.alertAId])
    expect((await ownerRepo.list({ status: 'all', severity: 'urgent' })).items
      .map(item => item.alertId)).toEqual([fixture.alertAId])
    expect((await ownerRepo.list({ status: 'all', platform: 'signal' })).items
      .map(item => item.alertId)).toEqual([fixture.alertBId])
    expect((await ownerRepo.list({ status: 'all', accountId: fixture.accountAId })).items
      .map(item => item.alertId)).toEqual([fixture.alertAId])
  })

  it('auditor 的 all 流只读且未确认数恒为零', async () => {
    const fixture = await seedFixture()
    const auditorRepo = repo({ kind: 'all' }, fixture.auditorId)

    expect((await auditorRepo.list({ status: 'all' })).items).toHaveLength(2)
    expect((await auditorRepo.list({ status: 'pending' })).items).toEqual([])
    await expect(auditorRepo.unacknowledgedCount()).resolves.toBe(0)
  })

  it('未确认计数同时按 actor recipient、requiresAck 和当前 scope 收敛', async () => {
    const fixture = await seedFixture()

    await expect(repo({ kind: 'all' }, fixture.ownerId).unacknowledgedCount()).resolves.toBe(1)
    await expect(repo(
      { kind: 'teams', teamIds: [fixture.teamAId] },
      fixture.managerAId,
    ).unacknowledgedCount()).resolves.toBe(1)
    await expect(repo(
      { kind: 'self', userId: fixture.agentAId },
      fixture.agentAId,
    ).unacknowledgedCount()).resolves.toBe(1)
    await expect(repo(
      { kind: 'teams', teamIds: [fixture.teamBId] },
      fixture.managerAId,
    ).unacknowledgedCount()).resolves.toBe(0)
    await expect(repo({ kind: 'all' }, fixture.auditorId).unacknowledgedCount()).resolves.toBe(0)
  })
})

describe('ScopedKeywordAlertRepo DTO and pagination', () => {
  it('删除消息强制 excerpt=null，编辑消息使用当前短摘录并标记 revision 已变化', async () => {
    const fixture = await seedFixture()
    await db.updateTable('messages').set({
      body: 'the currently edited body still says REFUND',
      edit_version: 2,
      edited_at: new Date('2026-09-03T10:10:00.000Z'),
    }).where('id', '=', fixture.messageAId).execute()
    await db.updateTable('messages').set({
      deleted_at: new Date('2026-09-03T10:11:00.000Z'),
    }).where('id', '=', fixture.messageBId).execute()

    const page = await repo({ kind: 'all' }, fixture.ownerId).list({ status: 'all' })
    const edited = page.items.find(item => item.alertId === fixture.alertAId)
    const deleted = page.items.find(item => item.alertId === fixture.alertBId)
    expect(edited).toMatchObject({
      excerpt: 'the currently edited body still says REFUND',
      messageChangedAfterMatch: true,
      messageDeleted: false,
    })
    expect(deleted).toMatchObject({
      excerpt: null,
      messageChangedAfterMatch: false,
      messageDeleted: true,
    })
  })

  it('同 timestamp 按 alert UUID 降序分页且无缺失或重复', async () => {
    const fixture = await seedFixture()
    const ownerRepo = repo({ kind: 'all' }, fixture.ownerId)

    const first = await ownerRepo.list({ status: 'all', limit: 1 })
    expect(first.items.map(item => item.alertId)).toEqual([higherAlertId])
    expect(first.nextCursor).toEqual(expect.any(String))
    if (first.nextCursor === null) throw new Error('expected next cursor')
    const second = await ownerRepo.list({ status: 'all', limit: 1, cursor: first.nextCursor })
    expect(second.items.map(item => item.alertId)).toEqual([lowerAlertId])
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(item => item.alertId)).size).toBe(2)

  })

  it('跨页保留 PostgreSQL 微秒精度并按相同 timestamp 的 alert UUID 降序续页', async () => {
    const fixture = await seedFixture()
    await insertAlert({
      id: sameTimestampHigherAlertId,
      ownerId: fixture.ownerId,
      accountId: fixture.accountAId,
      conversationId: (await db.selectFrom('conversations').select('id')
        .where('account_id', '=', fixture.accountAId).executeTakeFirstOrThrow()).id,
      platform: 'telegram',
      body: 'customer asks for another REFUND',
      pattern: 'Refund again',
      severity: 'normal',
      recipients: [{ userId: fixture.ownerId, requiresAck: true }],
    })
    await db.updateTable('keyword_alerts')
      .set({ created_at: sql<Date>`${'2026-09-03T10:00:00.123456Z'}::timestamptz` })
      .where('id', '=', higherAlertId)
      .execute()
    await db.updateTable('keyword_alerts')
      .set({ created_at: sql<Date>`${'2026-09-03T10:00:00.123123Z'}::timestamptz` })
      .where('id', 'in', [sameTimestampHigherAlertId, lowerAlertId])
      .execute()

    const ownerRepo = repo({ kind: 'all' }, fixture.ownerId)
    const first = await ownerRepo.list({ status: 'all', limit: 1 })
    if (first.nextCursor === null) throw new Error('expected first cursor')
    const second = await ownerRepo.list({ status: 'all', limit: 1, cursor: first.nextCursor })
    if (second.nextCursor === null) throw new Error('expected second cursor')
    const third = await ownerRepo.list({ status: 'all', limit: 1, cursor: second.nextCursor })

    expect([
      ...first.items,
      ...second.items,
      ...third.items,
    ].map(item => item.alertId)).toEqual([
      higherAlertId,
      sameTimestampHigherAlertId,
      lowerAlertId,
    ])
    expect(third.nextCursor).toBeNull()
  })

  it('limit 缺失或小于 1 使用 50，超过 100 时封顶为 100', async () => {
    const fixture = await seedFixture()
    await insertBulkAlerts(fixture, 101)
    const ownerRepo = repo({ kind: 'all' }, fixture.ownerId)

    expect((await ownerRepo.list({ status: 'all' })).items).toHaveLength(50)
    expect((await ownerRepo.list({ status: 'all', limit: 0 })).items).toHaveLength(50)
    expect((await ownerRepo.list({ status: 'all', limit: 101 })).items).toHaveLength(100)
  })

  it('返回对象严格匹配 KeywordAlertListItem 白名单且不含平台原始字段或其他接收人', async () => {
    const fixture = await seedFixture()
    const item = (await repo({ kind: 'all' }, fixture.ownerId).list({ status: 'pending' })).items[0]
    if (item === undefined) throw new Error('expected visible alert')

    expect(itemKeys(item)).toEqual([
      'accountDisplayName',
      'accountId',
      'acknowledgedAt',
      'alertId',
      'conversationDisplayName',
      'conversationId',
      'excerpt',
      'matchedAt',
      'messageChangedAfterMatch',
      'messageDeleted',
      'messageId',
      'pattern',
      'platform',
      'requiresAcknowledgement',
      'severity',
    ])
    expect(JSON.stringify(item)).not.toContain('external-message')
    expect(JSON.stringify(item)).not.toContain('external-sender')
    expect(JSON.stringify(item)).not.toContain('external-reply')
    expect(JSON.stringify(item)).not.toContain('raw-payload')
    expect(JSON.stringify(item)).not.toContain(fixture.auditorId)
  })
})

describe('ScopedKeywordAlertRepo acknowledgement', () => {
  it('只幂等确认当前 actor 自己的可见 recipient，并保留第一次时间', async () => {
    const fixture = await seedFixture()
    const agentRepo = repo({ kind: 'self', userId: fixture.agentAId }, fixture.agentAId)
    const firstAt = new Date('2026-09-03T11:00:00.000Z')
    const laterAt = new Date('2026-09-03T12:00:00.000Z')

    await expect(agentRepo.acknowledge(fixture.alertAId, firstAt)).resolves.toEqual({
      acknowledgedAt: firstAt.toISOString(),
    })
    await expect(agentRepo.acknowledge(fixture.alertAId, laterAt)).resolves.toEqual({
      acknowledgedAt: firstAt.toISOString(),
    })
    const rows = await db.selectFrom('keyword_alert_recipients')
      .select(['user_id', 'acknowledged_at'])
      .where('alert_id', '=', fixture.alertAId)
      .orderBy('user_id')
      .execute()
    expect(rows.find(row => row.user_id === fixture.agentAId)?.acknowledged_at)
      .toEqual(firstAt)
    expect(rows.find(row => row.user_id === fixture.ownerId)?.acknowledged_at).toBeNull()
  })

  it('不可见、缺失或无需确认的 recipient 不可被确认', async () => {
    const fixture = await seedFixture()
    const at = new Date('2026-09-03T11:00:00.000Z')

    await expect(repo({ kind: 'all' }, fixture.auditorId)
      .acknowledge(fixture.alertAId, at)).resolves.toBeNull()
    await expect(repo({ kind: 'self', userId: fixture.agentAId }, fixture.agentAId)
      .acknowledge(fixture.alertBId, at)).resolves.toBeNull()
    await expect(repo({ kind: 'all' }, fixture.ownerId)
      .acknowledge(randomUUID(), at)).resolves.toBeNull()
  })

  it('scope 在确认语句边界失效时不得更新历史 recipient', async () => {
    const fixture = await seedFixture()
    const boundary = createAcknowledgeBoundaryDatabase()
    const at = new Date('2026-09-03T11:00:00.000Z')
    const acknowledgePromise = new ScopedKeywordAlertRepo(
      boundary.database,
      { kind: 'self', userId: fixture.agentAId },
      fixture.agentAId,
    ).acknowledge(fixture.alertAId, at)

    try {
      await boundary.reached
      await db.updateTable('accounts')
        .set({ owner_user_id: fixture.agentBId })
        .where('id', '=', fixture.accountAId)
        .execute()
      boundary.release()

      await expect(acknowledgePromise).resolves.toBeNull()
      await expect(db.selectFrom('keyword_alert_recipients')
        .select('acknowledged_at')
        .where('alert_id', '=', fixture.alertAId)
        .where('user_id', '=', fixture.agentAId)
        .executeTakeFirstOrThrow()).resolves.toMatchObject({ acknowledged_at: null })
    } finally {
      boundary.release()
      await acknowledgePromise.catch(() => undefined)
      await boundary.database.destroy()
    }
  })
})
