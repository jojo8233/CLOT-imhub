import { createHash } from 'node:crypto'
import { parseTelegramMessageKey } from '@im-hub/shared'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import type { TelegramShadowEventType, TelegramShadowSource } from './telegram.js'

export type TelegramShadowCoverageStatus =
  | 'matched'
  | 'mismatched'
  | 'tdlib_only'
  | 'telegram_tt_only'
  | 'missing'
  | 'pre_observation'
  | 'coverage_unavailable'
  | 'source_local'

export type TelegramShadowRepairability =
  | 'none'
  | 'current_snapshot_fetchable'
  | 'historical_event_unrecoverable'
  | 'manual_investigation'
  | 'pre_observation'
  | 'coverage_unavailable'
  | 'source_local'

export class TelegramShadowCoverageInputError extends Error {}

interface CoverageStatusCounts {
  matched: number
  mismatched: number
  tdlibOnly: number
  telegramTtOnly: number
  missing: number
  preObservation: number
  coverageUnavailable: number
  sourceLocal: number
}

interface RepairabilityCounts {
  none: number
  currentSnapshotFetchable: number
  historicalEventUnrecoverable: number
  manualInvestigation: number
  preObservation: number
  coverageUnavailable: number
  sourceLocal: number
}

export interface TelegramShadowCoverageInput {
  accountId: string
  conversationId?: string
  sentAfter: Date
  sentBefore: Date
  limit?: number
  cursor?: string
  sampleLimit?: number
}

export interface TelegramShadowCoverageReport {
  sentAfter: Date
  sentBefore: Date
  coverageStartedAt: Date | null
  progress: {
    processedMessages: number
    pageMessages: number
    hasMore: boolean
    nextCursor: string | null
  }
  messages: {
    final: number
    sourceLocal: number
  }
  facts: CoverageStatusCounts & {
    total: number
    comparable: number
  }
  byEventType: Record<'upsert' | 'delete', CoverageStatusCounts>
  repairability: RepairabilityCounts
  actions: {
    tdlibRefreshCandidateCount: number
    /** Capped at 100; active refresh uses pages of at most 10 messages. */
    tdlibRefreshCandidates: string[]
  }
  samples: Record<TelegramShadowCoverageStatus, string[]>
}

interface CoverageCursor {
  version: 1
  scope: string
  sentAt: Date
  messageId: string
  processedMessages: number
}

interface MessageRow {
  id: string
  platform_message_id: string
  sent_at: Date
  edited_at: Date | null
  deleted_at: Date | null
}

interface ExpectedFact {
  factKey: string
  eventType: 'upsert' | 'delete'
  eventAt: Date
  revision: 'base' | 'edit' | 'delete'
  sourceLocal: boolean
  message: MessageRow
}

interface ObservationRow {
  fact_key: string
  source: TelegramShadowSource
  event_type: TelegramShadowEventType
  semantic_hash: string
  has_conflict: boolean
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const DEFAULT_SAMPLE_LIMIT = 10
const MAX_SAMPLE_LIMIT = 100
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000
const MAX_CURSOR_LENGTH = 2_048

export class KyselyTelegramShadowCoverageRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async scan(input: TelegramShadowCoverageInput): Promise<TelegramShadowCoverageReport> {
    const limit = validateInput(input)
    const scope = coverageScope(input)
    const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null

    let query = this.db.selectFrom('messages')
      .select(['id', 'platform_message_id', 'sent_at', 'edited_at', 'deleted_at'])
      .where('account_id', '=', input.accountId)
      .where('platform', '=', 'telegram')
      .where('sent_at', '>=', input.sentAfter)
      .where('sent_at', '<', input.sentBefore)

    if (input.conversationId) {
      query = query.where('conversation_id', '=', input.conversationId)
    }
    if (cursor) {
      query = query.where(eb => eb.or([
        eb('sent_at', '<', cursor.sentAt),
        eb.and([
          eb('sent_at', '=', cursor.sentAt),
          eb('id', '<', cursor.messageId),
        ]),
      ]))
    }

    const fetched = await query
      .orderBy('sent_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute()
    const hasMore = fetched.length > limit
    const messages = fetched.slice(0, limit)
    const facts = messages.flatMap(buildExpectedFacts)
    const observations = await this.loadObservations(input.accountId, facts)
    const coverageStartedAt = await this.coverageStartedAt(input.accountId)
    const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
    const report = emptyReport(input, coverageStartedAt)
    const tdlibRefreshCandidates = new Set<string>()

    for (const message of messages) {
      if (isFinalTelegramMessage(message.platform_message_id)) report.messages.final += 1
      else report.messages.sourceLocal += 1
    }

    for (const fact of facts) {
      const status = classifyCoverage(
        fact,
        observations.get(fact.factKey) ?? [],
        coverageStartedAt,
      )
      const repairability = classifyRepairability(fact, status)
      incrementStatus(report.facts, status)
      incrementStatus(report.byEventType[fact.eventType], status)
      incrementRepairability(report.repairability, repairability)
      addSample(report.samples[status], fact.factKey, sampleLimit)
      if ((status === 'telegram_tt_only' || status === 'missing')
        && repairability === 'current_snapshot_fetchable') {
        tdlibRefreshCandidates.add(fact.message.platform_message_id)
      }
      report.facts.total += 1
      if (status !== 'source_local'
        && status !== 'pre_observation'
        && status !== 'coverage_unavailable') {
        report.facts.comparable += 1
      }
    }

    report.actions = {
      tdlibRefreshCandidateCount: tdlibRefreshCandidates.size,
      tdlibRefreshCandidates: [...tdlibRefreshCandidates].slice(0, 100),
    }

    const processedMessages = (cursor?.processedMessages ?? 0) + messages.length
    const lastMessage = messages.at(-1)
    report.progress = {
      processedMessages,
      pageMessages: messages.length,
      hasMore,
      nextCursor: hasMore && lastMessage
        ? encodeCursor({
            version: 1,
            scope,
            sentAt: lastMessage.sent_at,
            messageId: lastMessage.id,
            processedMessages,
          })
        : null,
    }
    return report
  }

  private async coverageStartedAt(accountId: string): Promise<Date | null> {
    const result = await this.db.selectFrom('telegram_shadow_observations')
      .select(sql<Date | null>`min(first_observed_at)`.as('coverage_started_at'))
      .where('account_id', '=', accountId)
      .executeTakeFirst()
    return result?.coverage_started_at ?? null
  }

  private async loadObservations(
    accountId: string,
    facts: ExpectedFact[],
  ): Promise<Map<string, ObservationRow[]>> {
    if (facts.length === 0) return new Map()
    const factKeys = [...new Set(facts.map(fact => fact.factKey))]
    const rows = await this.db.selectFrom('telegram_shadow_observations')
      .select(['fact_key', 'source', 'event_type', 'semantic_hash', 'has_conflict'])
      .where('account_id', '=', accountId)
      .where('fact_key', 'in', factKeys)
      .execute()
    const byFactKey = new Map<string, ObservationRow[]>()
    for (const row of rows) {
      const existing = byFactKey.get(row.fact_key)
      if (existing) existing.push(row)
      else byFactKey.set(row.fact_key, [row])
    }
    return byFactKey
  }
}

function validateInput(input: TelegramShadowCoverageInput): number {
  if (!isValidDate(input.sentAfter) || !isValidDate(input.sentBefore)) {
    throw new TelegramShadowCoverageInputError('sentAfter and sentBefore must be valid dates')
  }
  const windowMs = input.sentBefore.getTime() - input.sentAfter.getTime()
  if (windowMs <= 0 || windowMs > MAX_WINDOW_MS) {
    throw new TelegramShadowCoverageInputError(
      'coverage window must be greater than zero and at most 31 days',
    )
  }
  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TelegramShadowCoverageInputError(
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    )
  }
  const sampleLimit = input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > MAX_SAMPLE_LIMIT) {
    throw new TelegramShadowCoverageInputError(
      `sampleLimit must be an integer between 0 and ${MAX_SAMPLE_LIMIT}`,
    )
  }
  return limit
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function coverageScope(input: TelegramShadowCoverageInput): string {
  return createHash('sha256').update(JSON.stringify({
    accountId: input.accountId,
    conversationId: input.conversationId ?? null,
    sentAfter: input.sentAfter.toISOString(),
    sentBefore: input.sentBefore.toISOString(),
  })).digest('hex')
}

function encodeCursor(cursor: CoverageCursor): string {
  return Buffer.from(JSON.stringify({
    version: cursor.version,
    scope: cursor.scope,
    sentAt: cursor.sentAt.toISOString(),
    messageId: cursor.messageId,
    processedMessages: cursor.processedMessages,
  })).toString('base64url')
}

function decodeCursor(value: string, expectedScope: string): CoverageCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new TelegramShadowCoverageInputError('coverage cursor is invalid')
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed)
      || parsed.version !== 1
      || parsed.scope !== expectedScope
      || typeof parsed.sentAt !== 'string'
      || typeof parsed.messageId !== 'string'
      || parsed.messageId.length === 0
      || typeof parsed.processedMessages !== 'number'
      || !Number.isInteger(parsed.processedMessages)
      || parsed.processedMessages < 0) {
      throw new Error('invalid cursor fields')
    }
    const sentAt = new Date(parsed.sentAt)
    if (!isValidDate(sentAt) || sentAt.toISOString() !== parsed.sentAt) {
      throw new Error('invalid cursor time')
    }
    return {
      version: 1,
      scope: parsed.scope,
      sentAt,
      messageId: parsed.messageId,
      processedMessages: parsed.processedMessages,
    }
  } catch {
    throw new TelegramShadowCoverageInputError(
      'coverage cursor is invalid or belongs to another scan scope',
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildExpectedFacts(message: MessageRow): ExpectedFact[] {
  const parsed = parseTelegramMessageKey(message.platform_message_id)
  if (!parsed) throw new Error('coverage scan found a non-canonical Telegram message id')
  const sourceLocal = parsed.kind === 'temporary'
  const facts: ExpectedFact[] = [{
    factKey: `upsert:${message.platform_message_id}:base`,
    eventType: 'upsert',
    eventAt: message.sent_at,
    revision: 'base',
    sourceLocal,
    message,
  }]
  if (message.edited_at) {
    facts.push({
      factKey: `upsert:${message.platform_message_id}:edited-at:${message.edited_at.toISOString()}`,
      eventType: 'upsert',
      eventAt: message.edited_at,
      revision: 'edit',
      sourceLocal,
      message,
    })
  }
  if (message.deleted_at) {
    facts.push({
      factKey: `delete:${message.platform_message_id}`,
      eventType: 'delete',
      eventAt: message.deleted_at,
      revision: 'delete',
      sourceLocal,
      message,
    })
  }
  return facts
}

function isFinalTelegramMessage(platformMessageId: string): boolean {
  return parseTelegramMessageKey(platformMessageId)?.kind === 'server'
}

function classifyCoverage(
  fact: ExpectedFact,
  observations: ObservationRow[],
  coverageStartedAt: Date | null,
): TelegramShadowCoverageStatus {
  if (fact.sourceLocal) return 'source_local'
  if (observations.length === 0) {
    if (!coverageStartedAt) return 'coverage_unavailable'
    return fact.eventAt < coverageStartedAt ? 'pre_observation' : 'missing'
  }

  const tdlib = observations.find(row => row.source === 'tdlib')
  const telegramTt = observations.find(row => row.source === 'telegram-tt')
  if (tdlib && telegramTt) {
    const wrongEventType = tdlib.event_type !== fact.eventType
      || telegramTt.event_type !== fact.eventType
    return !wrongEventType
      && !tdlib.has_conflict
      && !telegramTt.has_conflict
      && tdlib.semantic_hash === telegramTt.semantic_hash
      ? 'matched'
      : 'mismatched'
  }
  return tdlib ? 'tdlib_only' : 'telegram_tt_only'
}

function classifyRepairability(
  fact: ExpectedFact,
  status: TelegramShadowCoverageStatus,
): TelegramShadowRepairability {
  if (status === 'source_local') return 'source_local'
  if (status === 'pre_observation') return 'pre_observation'
  if (status === 'coverage_unavailable') return 'coverage_unavailable'
  if (status === 'matched') return 'none'
  if (status === 'mismatched') return 'manual_investigation'
  if (fact.revision === 'delete'
    || fact.message.deleted_at
    || (fact.revision === 'base' && fact.message.edited_at)) {
    return 'historical_event_unrecoverable'
  }
  return 'current_snapshot_fetchable'
}

function emptyReport(
  input: TelegramShadowCoverageInput,
  coverageStartedAt: Date | null,
): TelegramShadowCoverageReport {
  return {
    sentAfter: input.sentAfter,
    sentBefore: input.sentBefore,
    coverageStartedAt,
    progress: {
      processedMessages: 0,
      pageMessages: 0,
      hasMore: false,
      nextCursor: null,
    },
    messages: { final: 0, sourceLocal: 0 },
    facts: { total: 0, comparable: 0, ...emptyStatusCounts() },
    byEventType: {
      upsert: emptyStatusCounts(),
      delete: emptyStatusCounts(),
    },
    repairability: emptyRepairabilityCounts(),
    actions: {
      tdlibRefreshCandidateCount: 0,
      tdlibRefreshCandidates: [],
    },
    samples: {
      matched: [],
      mismatched: [],
      tdlib_only: [],
      telegram_tt_only: [],
      missing: [],
      pre_observation: [],
      coverage_unavailable: [],
      source_local: [],
    },
  }
}

function emptyStatusCounts(): CoverageStatusCounts {
  return {
    matched: 0,
    mismatched: 0,
    tdlibOnly: 0,
    telegramTtOnly: 0,
    missing: 0,
    preObservation: 0,
    coverageUnavailable: 0,
    sourceLocal: 0,
  }
}

function emptyRepairabilityCounts(): RepairabilityCounts {
  return {
    none: 0,
    currentSnapshotFetchable: 0,
    historicalEventUnrecoverable: 0,
    manualInvestigation: 0,
    preObservation: 0,
    coverageUnavailable: 0,
    sourceLocal: 0,
  }
}

function incrementStatus(
  counts: CoverageStatusCounts,
  status: TelegramShadowCoverageStatus,
): void {
  switch (status) {
    case 'matched':
      counts.matched += 1
      return
    case 'mismatched':
      counts.mismatched += 1
      return
    case 'tdlib_only':
      counts.tdlibOnly += 1
      return
    case 'telegram_tt_only':
      counts.telegramTtOnly += 1
      return
    case 'missing':
      counts.missing += 1
      return
    case 'pre_observation':
      counts.preObservation += 1
      return
    case 'coverage_unavailable':
      counts.coverageUnavailable += 1
      return
    case 'source_local':
      counts.sourceLocal += 1
  }
}

function incrementRepairability(
  counts: RepairabilityCounts,
  repairability: TelegramShadowRepairability,
): void {
  switch (repairability) {
    case 'none':
      counts.none += 1
      return
    case 'current_snapshot_fetchable':
      counts.currentSnapshotFetchable += 1
      return
    case 'historical_event_unrecoverable':
      counts.historicalEventUnrecoverable += 1
      return
    case 'manual_investigation':
      counts.manualInvestigation += 1
      return
    case 'pre_observation':
      counts.preObservation += 1
      return
    case 'coverage_unavailable':
      counts.coverageUnavailable += 1
      return
    case 'source_local':
      counts.sourceLocal += 1
  }
}

function addSample(samples: string[], factKey: string, limit: number): void {
  if (samples.length < limit) samples.push(factKey)
}
