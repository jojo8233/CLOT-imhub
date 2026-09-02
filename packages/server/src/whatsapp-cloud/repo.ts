import { sql, type Kysely } from 'kysely'
import type {
  Database,
  WhatsAppMessageStatus,
  WhatsAppOnboardingState,
  WhatsAppSendAttemptState,
} from '../db/types.js'
import type { EncryptedSecret } from './secret-cipher.js'

export const WHATSAPP_ACCESS_TOKEN_PURPOSE = 'whatsapp_access_token'

export interface CreateWhatsAppCloudAccountInput {
  accountId: string
  secretId: string
  ownerUserId: string
  teamId: string | null
  displayName: string
  wabaId: string
  phoneNumberId: string
  graphApiVersion: string
  encryptedToken: EncryptedSecret
  linkedAt: Date
}

export interface WhatsAppCloudAccountRecord {
  accountId: string
  ownerUserId: string
  wabaId: string
  phoneNumberId: string
  graphApiVersion: string
  authorizationRevision: number
  encryptedToken: EncryptedSecret
}

export interface WhatsAppSendAttemptInput {
  attemptId: string
  accountId: string
  conversationId: string
  actorUserId: string
  targetExternalId: string
  bodySha256: string
  authorizationRevision: number
}

export interface WhatsAppSendAttemptRecord extends WhatsAppSendAttemptInput {
  state: WhatsAppSendAttemptState
  platformMessageId: string | null
  errorCode: string | null
}

export interface AcceptedWhatsAppMessageInput {
  attemptId: string
  accountId: string
  conversationId: string
  platformMessageId: string
  senderExternalId: string
  targetExternalId: string
  body: string
  sentAt: Date
}

export interface WhatsAppStatusInput {
  accountId: string
  platformMessageId: string
  status: Exclude<WhatsAppMessageStatus, 'accepted'>
  statusAt: Date
  errorCode: string | null
}

export interface WhatsAppOnboardingSessionRecord {
  id: string
  ownerUserId: string
  teamId: string | null
  displayName: string
  state: WhatsAppOnboardingState
  accountId: string | null
  errorCode: string | null
  expiresAt: Date
}

export class KyselyWhatsAppCloudRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async createAccount(input: CreateWhatsAppCloudAccountInput): Promise<void> {
    await this.db.transaction().execute(async trx => {
      await trx.insertInto('accounts').values({
        id: input.accountId,
        platform: 'whatsapp',
        owner_user_id: input.ownerUserId,
        team_id: input.teamId,
        display_name: input.displayName,
        status: 'connected',
        connection_mode: 'cloud_api',
        credentials_ref: `db-secret:${input.secretId}`,
        platform_account_external_id: input.phoneNumberId,
        linked_at: input.linkedAt,
        history_available_from: input.linkedAt,
      }).execute()
      await trx.insertInto('platform_secrets').values({
        id: input.secretId,
        account_id: input.accountId,
        purpose: WHATSAPP_ACCESS_TOKEN_PURPOSE,
        ciphertext: input.encryptedToken.ciphertext,
        iv: input.encryptedToken.iv,
        auth_tag: input.encryptedToken.authTag,
      }).execute()
      await trx.insertInto('whatsapp_cloud_accounts').values({
        account_id: input.accountId,
        waba_id: input.wabaId,
        phone_number_id: input.phoneNumberId,
        graph_api_version: input.graphApiVersion,
      }).execute()
    })
  }

  async findByAccountId(accountId: string): Promise<WhatsAppCloudAccountRecord | null> {
    const row = await this.baseAccountQuery()
      .where('accounts.id', '=', accountId)
      .executeTakeFirst()
    return row ? this.accountRecord(row) : null
  }

  async findByWebhookIdentity(
    wabaId: string,
    phoneNumberId: string,
  ): Promise<WhatsAppCloudAccountRecord | null> {
    const row = await this.baseAccountQuery()
      .where('whatsapp_cloud_accounts.waba_id', '=', wabaId)
      .where('whatsapp_cloud_accounts.phone_number_id', '=', phoneNumberId)
      .executeTakeFirst()
    return row ? this.accountRecord(row) : null
  }

  async startAttempt(input: WhatsAppSendAttemptInput): Promise<{
    created: boolean
    attempt: WhatsAppSendAttemptRecord
  }> {
    return this.db.transaction().execute(async trx => {
      const inserted = await trx.insertInto('whatsapp_send_attempts').values({
        attempt_id: input.attemptId,
        account_id: input.accountId,
        conversation_id: input.conversationId,
        actor_user_id: input.actorUserId,
        target_external_id: input.targetExternalId,
        body_sha256: input.bodySha256,
        authorization_revision: input.authorizationRevision,
        state: 'sending',
      }).onConflict(oc => oc.column('attempt_id').doNothing())
        .returning('attempt_id')
        .executeTakeFirst()

      const attempt = await trx.selectFrom('whatsapp_send_attempts')
        .selectAll()
        .where('attempt_id', '=', input.attemptId)
        .executeTakeFirstOrThrow()
      return {
        created: inserted !== undefined,
        attempt: {
          attemptId: attempt.attempt_id,
          accountId: attempt.account_id,
          conversationId: attempt.conversation_id,
          actorUserId: attempt.actor_user_id,
          targetExternalId: attempt.target_external_id,
          bodySha256: attempt.body_sha256,
          authorizationRevision: attempt.authorization_revision,
          state: attempt.state,
          platformMessageId: attempt.platform_message_id,
          errorCode: attempt.error_code,
        },
      }
    })
  }

  async completeAccepted(input: AcceptedWhatsAppMessageInput): Promise<{ messageId: string }> {
    return this.db.transaction().execute(async trx => {
      const attempt = await trx.selectFrom('whatsapp_send_attempts')
        .select(['state', 'account_id', 'conversation_id', 'platform_message_id'])
        .where('attempt_id', '=', input.attemptId)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (attempt.account_id !== input.accountId || attempt.conversation_id !== input.conversationId) {
        throw new Error('attempt context mismatch')
      }
      if (attempt.state === 'accepted' && attempt.platform_message_id !== input.platformMessageId) {
        throw new Error('attempt final id mismatch')
      }

      const inserted = await trx.insertInto('messages').values({
        conversation_id: input.conversationId,
        account_id: input.accountId,
        platform: 'whatsapp',
        platform_message_id: input.platformMessageId,
        direction: 'out',
        sender_external_id: input.senderExternalId,
        body: input.body,
        body_lang: null,
        media_refs: JSON.stringify([]) as never,
        reply_to_platform_message_id: null,
        edited_at: null,
        edit_version: null,
        deleted_at: null,
        sent_at: input.sentAt,
        raw: JSON.stringify({ source: 'whatsapp_cloud_api', type: 'text' }) as never,
      }).onConflict(oc => oc.columns(['account_id', 'platform_message_id']).doNothing())
        .returning('id')
        .executeTakeFirst()
      const message = inserted ?? await trx.selectFrom('messages')
        .select('id')
        .where('account_id', '=', input.accountId)
        .where('platform_message_id', '=', input.platformMessageId)
        .executeTakeFirstOrThrow()

      await trx.updateTable('whatsapp_send_attempts').set({
        state: 'accepted',
        platform_message_id: input.platformMessageId,
        error_code: null,
        completed_at: input.sentAt,
      }).where('attempt_id', '=', input.attemptId).execute()
      await trx.insertInto('whatsapp_message_statuses').values({
        account_id: input.accountId,
        platform_message_id: input.platformMessageId,
        status: 'accepted',
        status_at: input.sentAt,
        error_code: null,
      }).onConflict(oc => oc.columns(['account_id', 'platform_message_id']).doNothing()).execute()
      await trx.updateTable('conversations')
        .set({ last_message_at: sql`greatest(coalesce(last_message_at, ${input.sentAt}), ${input.sentAt})` })
        .where('id', '=', input.conversationId)
        .execute()
      return { messageId: message.id }
    })
  }

  async finishAttempt(
    attemptId: string,
    state: Extract<WhatsAppSendAttemptState, 'unknown' | 'failed'>,
    errorCode: string,
  ): Promise<void> {
    await this.db.updateTable('whatsapp_send_attempts').set({
      state,
      error_code: errorCode,
      completed_at: new Date(),
    }).where('attempt_id', '=', attemptId)
      .where('state', '=', 'sending')
      .execute()
  }

  async saveStatus(input: WhatsAppStatusInput): Promise<boolean> {
    const nextRank = whatsappStatusRank(input.status)
    const row = await this.db.insertInto('whatsapp_message_statuses').values({
      account_id: input.accountId,
      platform_message_id: input.platformMessageId,
      status: input.status,
      status_at: input.statusAt,
      error_code: input.errorCode,
    }).onConflict(oc => oc
      .columns(['account_id', 'platform_message_id'])
      .doUpdateSet({
        status: input.status,
        status_at: input.statusAt,
        error_code: input.errorCode,
        updated_at: new Date(),
      })
      .where(eb => eb.or([
        eb('whatsapp_message_statuses.status_at', '<', input.statusAt),
        eb.and([
          eb('whatsapp_message_statuses.status_at', '=', input.statusAt),
          sql<boolean>`${statusRankSql()} < ${nextRank}`,
        ]),
      ])))
      .returning('status')
      .executeTakeFirst()
    return row !== undefined
  }

  async createOnboardingSession(input: {
    id: string
    ownerUserId: string
    teamId: string | null
    displayName: string
    ticketSha256: string
    expiresAt: Date
  }): Promise<void> {
    await this.db.insertInto('whatsapp_onboarding_sessions').values({
      id: input.id,
      owner_user_id: input.ownerUserId,
      team_id: input.teamId,
      display_name: input.displayName,
      ticket_sha256: input.ticketSha256,
      expires_at: input.expiresAt,
    }).execute()
  }

  async claimOnboardingSession(
    ticketSha256: string,
    now: Date,
  ): Promise<WhatsAppOnboardingSessionRecord | null> {
    const row = await this.db.updateTable('whatsapp_onboarding_sessions').set({
      state: 'processing',
      consumed_at: now,
    }).where('ticket_sha256', '=', ticketSha256)
      .where('state', '=', 'pending')
      .where('expires_at', '>', now)
      .returningAll()
      .executeTakeFirst()
    return row ? onboardingRecord(row) : null
  }

  async finishOnboardingSession(
    id: string,
    state: Extract<WhatsAppOnboardingState, 'completed' | 'failed'>,
    accountId: string | null,
    errorCode: string | null,
  ): Promise<void> {
    await this.db.updateTable('whatsapp_onboarding_sessions').set({
      state,
      account_id: accountId,
      error_code: errorCode,
    }).where('id', '=', id)
      .where('state', '=', 'processing')
      .execute()
  }

  async findOnboardingSessionForOwner(
    id: string,
    ownerUserId: string,
  ): Promise<WhatsAppOnboardingSessionRecord | null> {
    const row = await this.db.selectFrom('whatsapp_onboarding_sessions')
      .selectAll()
      .where('id', '=', id)
      .where('owner_user_id', '=', ownerUserId)
      .executeTakeFirst()
    return row ? onboardingRecord(row) : null
  }

  private baseAccountQuery() {
    return this.db.selectFrom('whatsapp_cloud_accounts')
      .innerJoin('accounts', 'accounts.id', 'whatsapp_cloud_accounts.account_id')
      .innerJoin('platform_secrets', join => join
        .onRef('platform_secrets.account_id', '=', 'accounts.id')
        .on('platform_secrets.purpose', '=', WHATSAPP_ACCESS_TOKEN_PURPOSE))
      .select([
        'accounts.id as account_id',
        'accounts.owner_user_id as owner_user_id',
        'whatsapp_cloud_accounts.waba_id as waba_id',
        'whatsapp_cloud_accounts.phone_number_id as phone_number_id',
        'whatsapp_cloud_accounts.graph_api_version as graph_api_version',
        'whatsapp_cloud_accounts.authorization_revision as authorization_revision',
        'platform_secrets.ciphertext as ciphertext',
        'platform_secrets.iv as iv',
        'platform_secrets.auth_tag as auth_tag',
      ])
      .where('accounts.platform', '=', 'whatsapp')
      .where('accounts.connection_mode', '=', 'cloud_api')
      .where('accounts.status', '=', 'connected')
  }

  private accountRecord(row: {
    account_id: string
    owner_user_id: string
    waba_id: string
    phone_number_id: string
    graph_api_version: string
    authorization_revision: number
    ciphertext: string
    iv: string
    auth_tag: string
  }): WhatsAppCloudAccountRecord {
    return {
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      wabaId: row.waba_id,
      phoneNumberId: row.phone_number_id,
      graphApiVersion: row.graph_api_version,
      authorizationRevision: row.authorization_revision,
      encryptedToken: {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
      },
    }
  }
}

function onboardingRecord(row: {
  id: string
  owner_user_id: string
  team_id: string | null
  display_name: string
  state: WhatsAppOnboardingState
  account_id: string | null
  error_code: string | null
  expires_at: Date
}): WhatsAppOnboardingSessionRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    teamId: row.team_id,
    displayName: row.display_name,
    state: row.state,
    accountId: row.account_id,
    errorCode: row.error_code,
    expiresAt: row.expires_at,
  }
}

function whatsappStatusRank(status: WhatsAppMessageStatus): number {
  switch (status) {
    case 'accepted': return 0
    case 'sent': return 1
    case 'delivered': return 2
    case 'read': return 3
    case 'failed': return 4
    case 'deleted': return 5
  }
}

function statusRankSql() {
  return sql<number>`case whatsapp_message_statuses.status
    when 'accepted' then 0
    when 'sent' then 1
    when 'delivered' then 2
    when 'read' then 3
    when 'failed' then 4
    when 'deleted' then 5
    else -1 end`
}
