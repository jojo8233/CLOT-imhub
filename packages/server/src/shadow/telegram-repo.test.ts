import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { KyselyTelegramShadowRepo } from './telegram-repo.js'
import type { TelegramShadowObservation, TelegramShadowSource } from './telegram.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const repo = new KyselyTelegramShadowRepo(db)

let accountId: string

beforeEach(async () => {
  await db.deleteFrom('telegram_shadow_observations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').execute()

  const user = await db.insertInto('users').values({
    email: 'shadow-test@example.com', display_name: 'Shadow', role: 'agent', password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()
  accountId = (await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: user.id, display_name: 'TG', status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => { await db.destroy() })

function observation(
  source: TelegramShadowSource,
  factKey: string,
  semanticHash = 'a'.repeat(64),
  eventType: TelegramShadowObservation['eventType'] = 'upsert',
): TelegramShadowObservation {
  return { accountId, source, eventType, factKey, semanticHash }
}

describe('KyselyTelegramShadowRepo', () => {
  it('classifies matched, mismatched, and one-sided settled facts', async () => {
    const observedAt = new Date('2026-08-29T00:01:00.000Z')
    await repo.record(observation('tdlib', 'matched'), observedAt)
    await repo.record(observation('telegram-tt', 'matched'), observedAt)
    await repo.record(observation('tdlib', 'mismatched'), observedAt)
    await repo.record(observation('telegram-tt', 'mismatched', 'b'.repeat(64)), observedAt)
    await repo.record(observation('tdlib', 'tdlib-only', undefined, 'delete'), observedAt)
    await repo.record(observation('telegram-tt', 'telegram-tt-only', undefined, 'remap'), observedAt)

    const report = await repo.summarize({
      accountId,
      observedAfter: new Date('2026-08-29T00:00:00.000Z'),
      settledBefore: new Date('2026-08-29T00:02:00.000Z'),
    })

    expect(report).toMatchObject({
      total: 4, matched: 1, mismatched: 1, tdlibOnly: 1, telegramTtOnly: 1,
      unstableReplayFacts: 0,
      byEventType: {
        upsert: { matched: 1, mismatched: 1, tdlibOnly: 0, telegramTtOnly: 0 },
        delete: { matched: 0, mismatched: 0, tdlibOnly: 1, telegramTtOnly: 0 },
        remap: { matched: 0, mismatched: 0, tdlibOnly: 0, telegramTtOnly: 1 },
      },
    })
  })

  it('deduplicates replays and exposes inconsistent same-source payloads', async () => {
    const observedAt = new Date('2026-08-29T00:01:00.000Z')
    await repo.record(observation('tdlib', 'unstable'), observedAt)
    await repo.record(observation('tdlib', 'unstable'), observedAt)
    await repo.record(observation('tdlib', 'unstable', 'b'.repeat(64)), observedAt)

    const row = await db.selectFrom('telegram_shadow_observations')
      .select(['observation_count', 'has_conflict', 'semantic_hash'])
      .where('account_id', '=', accountId)
      .where('fact_key', '=', 'unstable')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      observation_count: 3, has_conflict: true, semantic_hash: 'a'.repeat(64),
    })

    const report = await repo.summarize({
      accountId,
      observedAfter: new Date('2026-08-29T00:00:00.000Z'),
      settledBefore: new Date('2026-08-29T00:02:00.000Z'),
    })
    expect(report).toMatchObject({
      total: 1, tdlibOnly: 1, unstableReplayFacts: 1,
      samples: { tdlib_only: ['unstable'], unstable_replay: ['unstable'] },
    })
  })

  it('keeps the earliest and latest observation when replays arrive out of order', async () => {
    await repo.record(observation('tdlib', 'out-of-order'), new Date('2026-08-29T00:02:00.000Z'))
    await repo.record(observation('tdlib', 'out-of-order'), new Date('2026-08-29T00:01:00.000Z'))

    const row = await db.selectFrom('telegram_shadow_observations')
      .select(['first_observed_at', 'last_observed_at'])
      .where('account_id', '=', accountId)
      .where('fact_key', '=', 'out-of-order')
      .executeTakeFirstOrThrow()
    expect(row.first_observed_at).toEqual(new Date('2026-08-29T00:01:00.000Z'))
    expect(row.last_observed_at).toEqual(new Date('2026-08-29T00:02:00.000Z'))
  })

  it('excludes facts newer than the settle boundary', async () => {
    await repo.record(observation('tdlib', 'settled'), new Date('2026-08-29T00:01:00.000Z'))
    await repo.record(observation('tdlib', 'recent'), new Date('2026-08-29T00:04:00.000Z'))

    const report = await repo.summarize({
      accountId,
      observedAfter: new Date('2026-08-29T00:00:00.000Z'),
      settledBefore: new Date('2026-08-29T00:03:00.000Z'),
    })
    expect(report.total).toBe(1)
    expect(report.samples.tdlib_only).toEqual(['settled'])
  })
})
