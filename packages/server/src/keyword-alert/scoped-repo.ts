import {
  KEYWORD_ALERT_PAGE_DEFAULT_LIMIT,
  KEYWORD_ALERT_PAGE_MAX_LIMIT,
  type KeywordAlertListItem,
  type KeywordAlertListPage,
  type KeywordAlertSearchRequest,
  type ScopeFilter,
} from '@im-hub/shared'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import { messageRevision } from '../ingest/ingestor.js'
import { applyAccountScope } from '../rbac/apply.js'
import { keywordAlertExcerpt } from './matcher.js'
import {
  decodeKeywordAlertCursor,
  encodeKeywordAlertCursor,
  keywordAlertFilterFingerprint,
} from './query.js'

function preciseUtcTimestampFor(reference: string) {
  return sql<string>`
    to_char(
      ${sql.ref(reference)} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  `
}

function timestampParameter(value: string) {
  return sql<Date>`cast(${value} as timestamptz)`
}

export class ScopedKeywordAlertRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scope: ScopeFilter,
    private readonly actorUserId: string,
  ) {}

  async list(request: KeywordAlertSearchRequest): Promise<KeywordAlertListPage> {
    const limit = normalizedLimit(request.limit)
    const fingerprint = keywordAlertFilterFingerprint({
      actorUserId: this.actorUserId,
      scope: this.scope,
      status: request.status,
      severity: request.severity ?? null,
      platform: request.platform ?? null,
      accountId: request.accountId ?? null,
    })
    const cursor = request.cursor === undefined
      ? undefined
      : decodeKeywordAlertCursor(request.cursor, fingerprint)

    let query = this.visibleRecipients()
      .select([
        'keyword_alerts.id as alert_id',
        'keyword_alerts.pattern_snapshot as pattern',
        'keyword_alerts.severity_snapshot as severity',
        'keyword_alerts.matched_message_revision as matched_message_revision',
        'keyword_alerts.created_at as matched_at',
        'keyword_alert_recipients.requires_ack as requires_ack',
        'keyword_alert_recipients.acknowledged_at as acknowledged_at',
        'accounts.id as account_id',
        'accounts.platform as platform',
        'accounts.display_name as account_display_name',
        'conversations.id as conversation_id',
        'conversations.contact_display_name as conversation_display_name',
        'messages.id as message_id',
        'messages.body as current_body',
        'messages.edit_version as current_edit_version',
        'messages.edited_at as current_edited_at',
        'messages.deleted_at as message_deleted_at',
        preciseUtcTimestampFor('keyword_alerts.created_at').as('cursor_created_at'),
      ])

    switch (request.status) {
      case 'pending':
        query = query
          .where('keyword_alert_recipients.requires_ack', '=', true)
          .where('keyword_alert_recipients.acknowledged_at', 'is', null)
        break
      case 'acknowledged':
        query = query
          .where('keyword_alert_recipients.requires_ack', '=', true)
          .where('keyword_alert_recipients.acknowledged_at', 'is not', null)
        break
      case 'all':
        break
    }
    if (request.severity !== undefined) {
      query = query.where('keyword_alerts.severity_snapshot', '=', request.severity)
    }
    if (request.platform !== undefined) {
      query = query.where('accounts.platform', '=', request.platform)
    }
    if (request.accountId !== undefined) {
      query = query.where('accounts.id', '=', request.accountId)
    }
    if (cursor !== undefined) {
      query = query.where(eb => eb.or([
        eb('keyword_alerts.created_at', '<', timestampParameter(cursor.createdAt)),
        eb.and([
          eb('keyword_alerts.created_at', '=', timestampParameter(cursor.createdAt)),
          eb('keyword_alerts.id', '<', cursor.alertId),
        ]),
      ]))
    }

    const rows = await query
      .orderBy('keyword_alerts.created_at', 'desc')
      .orderBy('keyword_alerts.id', 'desc')
      .limit(limit + 1)
      .execute()
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map(row => this.toListItem(row))
    const lastRow = pageRows.at(-1)
    const nextCursor = rows.length > limit && lastRow !== undefined
      ? encodeKeywordAlertCursor({
        createdAt: lastRow.cursor_created_at,
        alertId: lastRow.alert_id,
        fingerprint,
      })
      : null
    return { items, nextCursor }
  }

  async unacknowledgedCount(): Promise<number> {
    const row = await this.visibleRecipients()
      .select(eb => eb.fn.countAll().as('count'))
      .where('keyword_alert_recipients.requires_ack', '=', true)
      .where('keyword_alert_recipients.acknowledged_at', 'is', null)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async acknowledge(
    alertId: string,
    at: Date,
  ): Promise<{ acknowledgedAt: string } | null> {
    const visibleRecipient = this.visibleRecipients()
      .select('keyword_alerts.id')
      .where('keyword_alerts.id', '=', alertId)
      .where('keyword_alert_recipients.requires_ack', '=', true)

    const updated = await this.db.updateTable('keyword_alert_recipients')
      .set({
        acknowledged_at: sql<Date>`coalesce(acknowledged_at, ${at})`,
      })
      .where('alert_id', '=', alertId)
      .where('user_id', '=', this.actorUserId)
      .where('requires_ack', '=', true)
      .where(({ exists }) => exists(visibleRecipient))
      .returning('acknowledged_at')
      .executeTakeFirst()
    if (updated?.acknowledged_at === null || updated === undefined) return null
    return { acknowledgedAt: updated.acknowledged_at.toISOString() }
  }

  private visibleRecipients() {
    return applyAccountScope(this.db.selectFrom('accounts'), this.scope)
      .innerJoin('conversations', 'conversations.account_id', 'accounts.id')
      .innerJoin('messages', join => join
        .onRef('messages.account_id', '=', 'accounts.id')
        .onRef('messages.conversation_id', '=', 'conversations.id'))
      .innerJoin('keyword_alerts', 'keyword_alerts.message_id', 'messages.id')
      .innerJoin('keyword_alert_recipients', join => join
        .onRef('keyword_alert_recipients.alert_id', '=', 'keyword_alerts.id')
        .on('keyword_alert_recipients.user_id', '=', this.actorUserId))
  }

  private toListItem(row: {
    alert_id: string
    pattern: string
    severity: KeywordAlertListItem['severity']
    matched_message_revision: string
    matched_at: Date
    requires_ack: boolean
    acknowledged_at: Date | null
    account_id: string
    platform: KeywordAlertListItem['platform']
    account_display_name: string
    conversation_id: string
    conversation_display_name: string | null
    message_id: string
    current_body: string
    current_edit_version: number | null
    current_edited_at: Date | null
    message_deleted_at: Date | null
  }): KeywordAlertListItem {
    const messageDeleted = row.message_deleted_at !== null
    return {
      alertId: row.alert_id,
      messageId: row.message_id,
      conversationId: row.conversation_id,
      accountId: row.account_id,
      platform: row.platform,
      severity: row.severity,
      pattern: row.pattern,
      accountDisplayName: row.account_display_name,
      conversationDisplayName: row.conversation_display_name,
      excerpt: keywordAlertExcerpt(row.current_body, row.pattern, messageDeleted),
      matchedAt: row.matched_at.toISOString(),
      messageChangedAfterMatch: row.matched_message_revision
        !== messageRevision(row.current_edit_version, row.current_edited_at),
      messageDeleted,
      requiresAcknowledgement: row.requires_ack,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    }
  }
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return KEYWORD_ALERT_PAGE_DEFAULT_LIMIT
  }
  return Math.min(limit, KEYWORD_ALERT_PAGE_MAX_LIMIT)
}
