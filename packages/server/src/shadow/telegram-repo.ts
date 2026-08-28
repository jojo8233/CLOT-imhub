import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'
import type {
  TelegramShadowEventType,
  TelegramShadowObservation,
} from './telegram.js'

export type TelegramShadowMatchStatus =
  | 'matched'
  | 'mismatched'
  | 'tdlib_only'
  | 'telegram_tt_only'

interface TelegramShadowStatusCounts {
  matched: number
  mismatched: number
  tdlibOnly: number
  telegramTtOnly: number
}

export interface TelegramShadowReportInput {
  accountId: string
  observedAfter: Date
  settledBefore: Date
  sampleLimit?: number
}

export interface TelegramShadowReport {
  observedAfter: Date
  settledBefore: Date
  total: number
  matched: number
  mismatched: number
  tdlibOnly: number
  telegramTtOnly: number
  unstableReplayFacts: number
  byEventType: Record<TelegramShadowEventType, TelegramShadowStatusCounts>
  samples: Record<TelegramShadowMatchStatus | 'unstable_replay', string[]>
}

interface AggregatedObservation {
  fact_key: string
  event_type: TelegramShadowEventType
  tdlib_hash: string | null
  telegram_tt_hash: string | null
  tdlib_conflict: boolean
  telegram_tt_conflict: boolean
}

const DEFAULT_SAMPLE_LIMIT = 10

export class KyselyTelegramShadowRepo {
  constructor(private readonly db: Kysely<Database>) {}

  record(observation: TelegramShadowObservation, observedAt = new Date()): Promise<void> {
    return recordTelegramShadowObservation(this.db, observation, observedAt)
  }

  async summarize(input: TelegramShadowReportInput): Promise<TelegramShadowReport> {
    if (input.observedAfter > input.settledBefore) {
      throw new Error('observedAfter must not be later than settledBefore')
    }
    const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
    if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 100) {
      throw new Error('sampleLimit must be an integer between 0 and 100')
    }

    const rows = await this.db.selectFrom('telegram_shadow_observations')
      .select([
        'fact_key',
        'event_type',
        sql<string | null>`max(semantic_hash) filter (where source = 'tdlib')`.as('tdlib_hash'),
        sql<string | null>`max(semantic_hash) filter (where source = 'telegram-tt')`
          .as('telegram_tt_hash'),
        sql<boolean>`coalesce(bool_or(has_conflict) filter (where source = 'tdlib'), false)`
          .as('tdlib_conflict'),
        sql<boolean>`coalesce(bool_or(has_conflict) filter (where source = 'telegram-tt'), false)`
          .as('telegram_tt_conflict'),
      ])
      .where('account_id', '=', input.accountId)
      .groupBy(['fact_key', 'event_type'])
      .having(sql<Date>`min(first_observed_at)`, '>=', input.observedAfter)
      .having(sql<Date>`min(first_observed_at)`, '<=', input.settledBefore)
      .orderBy('fact_key')
      .execute() as AggregatedObservation[]

    return buildReport(rows, input, sampleLimit)
  }
}

export async function recordTelegramShadowObservation(
  db: Kysely<Database> | Transaction<Database>,
  observation: TelegramShadowObservation,
  observedAt = new Date(),
): Promise<void> {
  await db.insertInto('telegram_shadow_observations')
    .values({
      account_id: observation.accountId,
      source: observation.source,
      event_type: observation.eventType,
      fact_key: observation.factKey,
      semantic_hash: observation.semanticHash,
      has_conflict: false,
      observation_count: 1,
      first_observed_at: observedAt,
      last_observed_at: observedAt,
    })
    .onConflict(oc => oc.columns(['account_id', 'source', 'fact_key']).doUpdateSet({
      first_observed_at: sql<Date>`least(
        telegram_shadow_observations.first_observed_at,
        excluded.first_observed_at
      )`,
      last_observed_at: sql<Date>`greatest(
        telegram_shadow_observations.last_observed_at,
        excluded.last_observed_at
      )`,
      observation_count: sql<number>`telegram_shadow_observations.observation_count + 1`,
      has_conflict: sql<boolean>`
        telegram_shadow_observations.has_conflict
        or telegram_shadow_observations.semantic_hash <> excluded.semantic_hash
      `,
    }))
    .execute()
}

function buildReport(
  rows: AggregatedObservation[],
  input: TelegramShadowReportInput,
  sampleLimit: number,
): TelegramShadowReport {
  const report: TelegramShadowReport = {
    observedAfter: input.observedAfter,
    settledBefore: input.settledBefore,
    total: rows.length,
    matched: 0,
    mismatched: 0,
    tdlibOnly: 0,
    telegramTtOnly: 0,
    unstableReplayFacts: 0,
    byEventType: {
      upsert: emptyStatusCounts(),
      delete: emptyStatusCounts(),
      remap: emptyStatusCounts(),
    },
    samples: {
      matched: [],
      mismatched: [],
      tdlib_only: [],
      telegram_tt_only: [],
      unstable_replay: [],
    },
  }

  for (const row of rows) {
    const isUnstable = row.tdlib_conflict || row.telegram_tt_conflict
    if (isUnstable) {
      report.unstableReplayFacts += 1
      addSample(report.samples.unstable_replay, row.fact_key, sampleLimit)
    }

    const status = classify(row, isUnstable)
    incrementStatus(report, report.byEventType[row.event_type], status)
    addSample(report.samples[status], row.fact_key, sampleLimit)
  }
  return report
}

function classify(
  observation: AggregatedObservation,
  isUnstable: boolean,
): TelegramShadowMatchStatus {
  if (observation.tdlib_hash && observation.telegram_tt_hash) {
    return !isUnstable && observation.tdlib_hash === observation.telegram_tt_hash
      ? 'matched'
      : 'mismatched'
  }
  return observation.tdlib_hash ? 'tdlib_only' : 'telegram_tt_only'
}

function incrementStatus(
  report: TelegramShadowReport,
  eventCounts: TelegramShadowStatusCounts,
  status: TelegramShadowMatchStatus,
): void {
  switch (status) {
    case 'matched':
      report.matched += 1
      eventCounts.matched += 1
      return
    case 'mismatched':
      report.mismatched += 1
      eventCounts.mismatched += 1
      return
    case 'tdlib_only':
      report.tdlibOnly += 1
      eventCounts.tdlibOnly += 1
      return
    case 'telegram_tt_only':
      report.telegramTtOnly += 1
      eventCounts.telegramTtOnly += 1
  }
}

function emptyStatusCounts(): TelegramShadowStatusCounts {
  return { matched: 0, mismatched: 0, tdlibOnly: 0, telegramTtOnly: 0 }
}

function addSample(samples: string[], factKey: string, limit: number): void {
  if (samples.length < limit) samples.push(factKey)
}
