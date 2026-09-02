import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { KyselyTelegramShadowCoverageRepo } from './coverage.js'
import { KyselyTelegramShadowRepo } from './telegram-repo.js'
import type { TelegramShadowEventType, TelegramShadowSource } from './telegram.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const coverageRepo = new KyselyTelegramShadowCoverageRepo(db)
const shadowRepo = new KyselyTelegramShadowRepo(db)

let accountId: string
let conversationId: string

beforeEach(async () => {
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').execute()

  const user = await db.insertInto('users').values({
    email: 'shadow-coverage@example.com',
    display_name: 'Shadow coverage',
    role: 'agent',
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()
  accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: user.id,
    display_name: 'TG',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: '-1001',
    contact_external_id: 'contact',
  }).returning('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => { await db.destroy() })

async function insertMessage(input: {
  platformMessageId: string
  sentAt: string
  editedAt?: string
  deletedAt?: string
  targetConversationId?: string
}): Promise<void> {
  await db.insertInto('messages').values({
    account_id: accountId,
    conversation_id: input.targetConversationId ?? conversationId,
    platform: 'telegram',
    platform_message_id: input.platformMessageId,
    direction: 'in',
    sender_external_id: 'contact',
    body: '',
    media_refs: JSON.stringify([]),
    raw: JSON.stringify({}),
    sent_at: new Date(input.sentAt),
    edited_at: input.editedAt ? new Date(input.editedAt) : null,
    deleted_at: input.deletedAt ? new Date(input.deletedAt) : null,
  }).execute()
}

async function observe(
  source: TelegramShadowSource,
  factKey: string,
  observedAt: string,
  semanticHash = 'a'.repeat(64),
  eventType: TelegramShadowEventType = 'upsert',
): Promise<void> {
  await shadowRepo.record({
    accountId,
    source,
    factKey,
    semanticHash,
    eventType,
  }, new Date(observedAt))
}

describe('KyselyTelegramShadowCoverageRepo', () => {
  it('distinguishes coverage gaps from pre-observation and source-local history', async () => {
    await insertMessage({ platformMessageId: '-1001:101', sentAt: '2026-08-29T00:00:00.000Z' })
    await insertMessage({
      platformMessageId: '-1001:temp:tdlib:1048577',
      sentAt: '2026-08-29T00:01:00.000Z',
    })
    await insertMessage({ platformMessageId: '-1001:102', sentAt: '2026-08-29T00:11:00.000Z' })
    await insertMessage({
      platformMessageId: '-1001:103',
      sentAt: '2026-08-29T00:12:00.000Z',
      editedAt: '2026-08-29T00:15:00.000Z',
    })
    await insertMessage({
      platformMessageId: '-1001:104',
      sentAt: '2026-08-29T00:13:00.000Z',
      deletedAt: '2026-08-29T00:16:00.000Z',
    })
    await insertMessage({ platformMessageId: '-1001:105', sentAt: '2026-08-29T00:14:00.000Z' })

    await observe('tdlib', 'upsert:-1001:102:base', '2026-08-29T00:10:00.000Z')
    await observe('telegram-tt', 'upsert:-1001:102:base', '2026-08-29T00:10:01.000Z')
    await observe('tdlib', 'upsert:-1001:103:base', '2026-08-29T00:13:00.000Z')
    await observe(
      'telegram-tt',
      'upsert:-1001:103:edited-at:2026-08-29T00:15:00.000Z',
      '2026-08-29T00:15:01.000Z',
    )
    await observe('tdlib', 'upsert:-1001:105:base', '2026-08-29T00:14:01.000Z')
    await observe(
      'telegram-tt',
      'upsert:-1001:105:base',
      '2026-08-29T00:14:02.000Z',
      'b'.repeat(64),
    )

    const report = await coverageRepo.scan({
      accountId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
    })

    expect(report).toMatchObject({
      coverageStartedAt: new Date('2026-08-29T00:10:00.000Z'),
      progress: { processedMessages: 6, pageMessages: 6, hasMore: false, nextCursor: null },
      messages: { final: 5, sourceLocal: 1 },
      facts: {
        total: 8,
        comparable: 6,
        matched: 1,
        mismatched: 1,
        tdlibOnly: 1,
        telegramTtOnly: 1,
        missing: 2,
        preObservation: 1,
        coverageUnavailable: 0,
        sourceLocal: 1,
      },
      byEventType: {
        upsert: {
          matched: 1, mismatched: 1, tdlibOnly: 1, telegramTtOnly: 1,
          missing: 1, preObservation: 1, coverageUnavailable: 0, sourceLocal: 1,
        },
        delete: {
          matched: 0, mismatched: 0, tdlibOnly: 0, telegramTtOnly: 0,
          missing: 1, preObservation: 0, coverageUnavailable: 0, sourceLocal: 0,
        },
      },
      repairability: {
        none: 1,
        currentSnapshotFetchable: 1,
        historicalEventUnrecoverable: 3,
        manualInvestigation: 1,
        preObservation: 1,
        coverageUnavailable: 0,
        sourceLocal: 1,
      },
      actions: {
        tdlibRefreshCandidateCount: 1,
        tdlibRefreshCandidates: ['-1001:103'],
      },
    })
    expect(report.samples.matched).toEqual(['upsert:-1001:102:base'])
    expect(report.samples.pre_observation).toEqual(['upsert:-1001:101:base'])
    expect(report.samples.source_local).toEqual([
      'upsert:-1001:temp:tdlib:1048577:base',
    ])
  })

  it('uses a scope-bound keyset cursor and reports observable progress', async () => {
    await insertMessage({ platformMessageId: '-1001:201', sentAt: '2026-08-29T00:01:00.000Z' })
    await insertMessage({ platformMessageId: '-1001:202', sentAt: '2026-08-29T00:02:00.000Z' })
    await insertMessage({ platformMessageId: '-1001:203', sentAt: '2026-08-29T00:03:00.000Z' })

    const input = {
      accountId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
      limit: 2,
    }
    const first = await coverageRepo.scan(input)
    expect(first.progress).toMatchObject({
      processedMessages: 2,
      pageMessages: 2,
      hasMore: true,
    })
    expect(first.progress.nextCursor).toEqual(expect.any(String))
    expect(first.facts).toMatchObject({ coverageUnavailable: 2 })

    const second = await coverageRepo.scan({
      ...input,
      cursor: first.progress.nextCursor ?? undefined,
    })
    expect(second.progress).toEqual({
      processedMessages: 3,
      pageMessages: 1,
      hasMore: false,
      nextCursor: null,
    })
    expect(second.facts).toMatchObject({ coverageUnavailable: 1 })
    expect([
      ...first.samples.coverage_unavailable,
      ...second.samples.coverage_unavailable,
    ]).toEqual([
      'upsert:-1001:203:base',
      'upsert:-1001:202:base',
      'upsert:-1001:201:base',
    ])

    await expect(coverageRepo.scan({
      ...input,
      sentBefore: new Date('2026-08-29T00:59:00.000Z'),
      cursor: first.progress.nextCursor ?? undefined,
    })).rejects.toThrow('another scan scope')
  })

  it('enforces conversation, time-window, page, and cursor boundaries', async () => {
    const otherConversationId = (await db.insertInto('conversations').values({
      account_id: accountId,
      platform_conversation_id: '-1002',
      contact_external_id: 'other-contact',
    }).returning('id').executeTakeFirstOrThrow()).id
    await insertMessage({ platformMessageId: '-1001:301', sentAt: '2026-08-29T00:01:00.000Z' })
    await insertMessage({
      platformMessageId: '-1002:301',
      sentAt: '2026-08-29T00:02:00.000Z',
      targetConversationId: otherConversationId,
    })

    const report = await coverageRepo.scan({
      accountId,
      conversationId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
    })
    expect(report.progress.pageMessages).toBe(1)
    expect(report.samples.coverage_unavailable).toEqual(['upsert:-1001:301:base'])

    await insertMessage({ platformMessageId: 'legacy-id', sentAt: '2026-08-29T00:03:00.000Z' })
    await expect(coverageRepo.scan({
      accountId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
    })).rejects.toThrow('non-canonical Telegram message id')

    await expect(coverageRepo.scan({
      accountId,
      sentAfter: new Date('2026-01-01T00:00:00.000Z'),
      sentBefore: new Date('2026-02-02T00:00:00.000Z'),
    })).rejects.toThrow('at most 31 days')
    await expect(coverageRepo.scan({
      accountId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
      limit: 501,
    })).rejects.toThrow('between 1 and 500')
    await expect(coverageRepo.scan({
      accountId,
      sentAfter: new Date('2026-08-29T00:00:00.000Z'),
      sentBefore: new Date('2026-08-29T01:00:00.000Z'),
      cursor: 'not-a-cursor',
    })).rejects.toThrow('coverage cursor is invalid')
  })
})
