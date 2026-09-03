import type { KeywordAlertSeverity, WsKeywordAlertEvent } from '@im-hub/shared'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../db/types.js'

const CLAIM_BATCH_SIZE = 20
const LEASE_DURATION_MS = 60_000
const MAX_AUTOMATIC_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 300_000

export interface KeywordAlertScanJob {
  id: string
  messageId: string
  messageRevision: string
  bodySnapshot: string
  createdAt: Date
  attemptCount: number
}

export interface ActiveKeywordRule {
  id: string
  pattern: string
  normalizedPattern: string
  severity: KeywordAlertSeverity
  revision: number
  effectiveAt: Date
}

export interface KeywordAlertDelivery {
  userId: string
  event: WsKeywordAlertEvent
}

interface AlertRecipient {
  userId: string
  requiresAcknowledgement: boolean
}

export function keywordAlertRetryDelayMs(attemptCount: number): number {
  return Math.min(1_000 * (2 ** (attemptCount - 1)), MAX_RETRY_DELAY_MS)
}

export class KyselyKeywordAlertScanRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async claimBatch(workerId: string, now: Date): Promise<KeywordAlertScanJob[]> {
    return this.db.transaction().execute(async trx => {
      const rows = await trx.selectFrom('keyword_alert_scan_jobs')
        .select([
          'id', 'message_id', 'message_revision', 'body_snapshot', 'created_at', 'attempt_count',
        ])
        .where('attempt_count', '<', MAX_AUTOMATIC_ATTEMPTS)
        .where('available_at', '<=', now)
        .where(eb => eb.or([
          eb('lease_owner', 'is', null),
          eb('lease_expires_at', '<=', now),
        ]))
        .orderBy('created_at')
        .orderBy('id')
        .limit(CLAIM_BATCH_SIZE)
        .forUpdate()
        .skipLocked()
        .execute()

      if (rows.length === 0) return []

      await trx.updateTable('keyword_alert_scan_jobs')
        .set({
          lease_owner: workerId,
          lease_expires_at: new Date(now.getTime() + LEASE_DURATION_MS),
        })
        .where('id', 'in', rows.map(row => row.id))
        .execute()

      return rows.map(row => ({
        id: row.id,
        messageId: row.message_id,
        messageRevision: row.message_revision,
        bodySnapshot: row.body_snapshot,
        createdAt: row.created_at,
        attemptCount: row.attempt_count,
      }))
    })
  }

  async loadActiveRules(): Promise<ActiveKeywordRule[]> {
    const rows = await this.db.selectFrom('keyword_rules')
      .select(['id', 'pattern', 'normalized_pattern', 'severity', 'revision', 'effective_at'])
      .where('enabled', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute()

    return rows.map(row => ({
      id: row.id,
      pattern: row.pattern,
      normalizedPattern: row.normalized_pattern,
      severity: row.severity,
      revision: row.revision,
      effectiveAt: row.effective_at,
    }))
  }

  async complete(
    workerId: string,
    job: KeywordAlertScanJob,
    matchedRules: readonly ActiveKeywordRule[],
  ): Promise<KeywordAlertDelivery[]> {
    return this.db.transaction().execute(async trx => {
      const lockedJob = await trx.selectFrom('keyword_alert_scan_jobs')
        .select(['id', 'message_id', 'message_revision', 'created_at'])
        .where('id', '=', job.id)
        .where('lease_owner', '=', workerId)
        .forUpdate()
        .executeTakeFirst()
      if (!lockedJob) return []

      const requestedRules = new Map<string, ActiveKeywordRule>()
      for (const rule of matchedRules) requestedRules.set(rule.id, rule)
      const requestedRuleIds = [...requestedRules.keys()].sort()
      const lockedRules = requestedRuleIds.length === 0
        ? []
        : await trx.selectFrom('keyword_rules')
          .select(['id', 'pattern', 'severity', 'revision', 'enabled', 'effective_at', 'deleted_at'])
          .where('id', 'in', requestedRuleIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      const validRules = lockedRules.filter(rule => {
        const requested = requestedRules.get(rule.id)
        return requested !== undefined
          && rule.revision === requested.revision
          && rule.enabled
          && rule.deleted_at === null
          && rule.effective_at <= lockedJob.created_at
      })

      const account = validRules.length === 0
        ? undefined
        : await trx.selectFrom('messages')
          .innerJoin('accounts', 'accounts.id', 'messages.account_id')
          .select(['accounts.owner_user_id', 'accounts.team_id'])
          .where('messages.id', '=', lockedJob.message_id)
          .executeTakeFirst()
      const recipients = account
        ? await this.loadRecipients(trx, account.owner_user_id, account.team_id)
        : []
      const deliveries: KeywordAlertDelivery[] = []

      for (const rule of validRules) {
        const alert = await trx.insertInto('keyword_alerts').values({
          message_id: lockedJob.message_id,
          rule_id: rule.id,
          pattern_snapshot: rule.pattern,
          severity_snapshot: rule.severity,
          matched_message_revision: lockedJob.message_revision,
        }).onConflict(oc => oc.columns(['message_id', 'rule_id']).doNothing())
          .returning(['id', 'severity_snapshot', 'created_at'])
          .executeTakeFirst()
        if (!alert) continue

        if (recipients.length > 0) {
          await trx.insertInto('keyword_alert_recipients').values(recipients.map(recipient => ({
            alert_id: alert.id,
            user_id: recipient.userId,
            requires_ack: recipient.requiresAcknowledgement,
            acknowledged_at: null,
          }))).onConflict(oc => oc.columns(['alert_id', 'user_id']).doNothing()).execute()
        }
        for (const recipient of recipients) {
          deliveries.push({
            userId: recipient.userId,
            event: {
              type: 'keyword_alert',
              alertId: alert.id,
              severity: alert.severity_snapshot,
              requiresAcknowledgement: recipient.requiresAcknowledgement,
              createdAt: alert.created_at.toISOString(),
            },
          })
        }
      }

      await trx.deleteFrom('keyword_alert_scan_jobs')
        .where('id', '=', lockedJob.id)
        .where('lease_owner', '=', workerId)
        .execute()
      return deliveries
    })
  }

  async fail(
    workerId: string,
    job: KeywordAlertScanJob,
    now: Date,
    errorCode: 'scan_failed',
  ): Promise<void> {
    await this.db.transaction().execute(async trx => {
      const lockedJob = await trx.selectFrom('keyword_alert_scan_jobs')
        .select('attempt_count')
        .where('id', '=', job.id)
        .where('lease_owner', '=', workerId)
        .forUpdate()
        .executeTakeFirst()
      if (!lockedJob) return

      const nextAttemptCount = lockedJob.attempt_count + 1
      await trx.updateTable('keyword_alert_scan_jobs').set({
        attempt_count: nextAttemptCount,
        available_at: new Date(now.getTime() + keywordAlertRetryDelayMs(nextAttemptCount)),
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
      }).where('id', '=', job.id)
        .where('lease_owner', '=', workerId)
        .execute()
    })
  }

  async countDegraded(): Promise<number> {
    const row = await this.db.selectFrom('keyword_alert_scan_jobs')
      .select(eb => eb.fn.countAll().as('count'))
      .where('attempt_count', '>=', MAX_AUTOMATIC_ATTEMPTS)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async retryDegraded(now: Date): Promise<number> {
    const result = await this.db.updateTable('keyword_alert_scan_jobs').set({
      attempt_count: 0,
      available_at: now,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    }).where('attempt_count', '>=', MAX_AUTOMATIC_ATTEMPTS)
      .executeTakeFirst()
    return Number(result.numUpdatedRows ?? 0n)
  }

  private async loadRecipients(
    trx: Transaction<Database>,
    accountOwnerUserId: string,
    teamId: string | null,
  ): Promise<AlertRecipient[]> {
    const globalUsers = await trx.selectFrom('users')
      .select(['id', 'role'])
      .where('disabled_at', 'is', null)
      .where('role', 'in', ['owner', 'auditor'])
      .execute()
    const accountOwnerAgent = await trx.selectFrom('users')
      .select('id')
      .where('id', '=', accountOwnerUserId)
      .where('role', '=', 'agent')
      .where('disabled_at', 'is', null)
      .executeTakeFirst()
    const leadManagers = teamId === null
      ? []
      : await trx.selectFrom('team_members')
        .innerJoin('users', 'users.id', 'team_members.user_id')
        .select('users.id')
        .where('team_members.team_id', '=', teamId)
        .where('team_members.is_lead', '=', true)
        .where('users.role', '=', 'manager')
        .where('users.disabled_at', 'is', null)
        .execute()

    const recipients = new Map<string, boolean>()
    for (const user of globalUsers) recipients.set(user.id, user.role !== 'auditor')
    if (accountOwnerAgent) recipients.set(accountOwnerAgent.id, true)
    for (const manager of leadManagers) recipients.set(manager.id, true)

    return [...recipients]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([userId, requiresAcknowledgement]) => ({ userId, requiresAcknowledgement }))
  }
}
