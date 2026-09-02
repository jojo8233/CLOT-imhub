import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

/**
 * WhatsApp Cloud API 的身份、加密 token、发送 attempt 与状态账本。
 *
 * 平台正文仍只进入 messages；attempt 只保存 SHA-256 fingerprint，既能挡住同
 * attempt 改稿，又不会复制一份客户正文。Graph 结果未知时保持 unknown，不重发。
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('platform_secrets')
    .addColumn('id', 'uuid', c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('purpose', 'text', c => c.notNull())
    .addColumn('ciphertext', 'text', c => c.notNull())
    .addColumn('iv', 'text', c => c.notNull())
    .addColumn('auth_tag', 'text', c => c.notNull())
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('rotated_at', 'timestamptz')
    .addUniqueConstraint('platform_secrets_account_purpose_uq', ['account_id', 'purpose'])
    .execute()

  await db.schema.createTable('whatsapp_cloud_accounts')
    .addColumn('account_id', 'uuid', c => c.primaryKey().references('accounts.id').onDelete('cascade'))
    .addColumn('waba_id', 'text', c => c.notNull())
    .addColumn('phone_number_id', 'text', c => c.notNull().unique())
    .addColumn('graph_api_version', 'text', c => c.notNull())
    .addColumn('authorization_revision', 'integer', c => c.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'whatsapp_cloud_accounts_authorization_revision_positive',
      sql`authorization_revision > 0`,
    )
    .addCheckConstraint(
      'whatsapp_cloud_accounts_graph_version_check',
      sql`graph_api_version ~ '^v[0-9]+\\.[0-9]+$'`,
    )
    .execute()

  await db.schema.createTable('whatsapp_send_attempts')
    .addColumn('attempt_id', 'uuid', c => c.primaryKey())
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('conversation_id', 'uuid', c => c.notNull().references('conversations.id').onDelete('cascade'))
    .addColumn('actor_user_id', 'uuid', c => c.notNull().references('users.id'))
    .addColumn('target_external_id', 'text', c => c.notNull())
    .addColumn('body_sha256', 'text', c => c.notNull())
    .addColumn('authorization_revision', 'integer', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull())
    .addColumn('platform_message_id', 'text')
    .addColumn('error_code', 'text')
    .addColumn('started_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .addCheckConstraint(
      'whatsapp_send_attempts_state_check',
      sql`state in ('sending','accepted','unknown','failed')`,
    )
    .addCheckConstraint(
      'whatsapp_send_attempts_fingerprint_check',
      sql`body_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .addCheckConstraint(
      'whatsapp_send_attempts_final_id_check',
      sql`(state = 'accepted' and platform_message_id is not null)
          or (state <> 'accepted' and platform_message_id is null)`,
    )
    .execute()

  await db.schema.createIndex('whatsapp_send_attempts_account_started_idx')
    .on('whatsapp_send_attempts')
    .columns(['account_id', 'started_at'])
    .execute()

  await db.schema.createTable('whatsapp_message_statuses')
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('platform_message_id', 'text', c => c.notNull())
    .addColumn('status', 'text', c => c.notNull())
    .addColumn('status_at', 'timestamptz', c => c.notNull())
    .addColumn('error_code', 'text')
    .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('whatsapp_message_statuses_pk', ['account_id', 'platform_message_id'])
    .addCheckConstraint(
      'whatsapp_message_statuses_status_check',
      sql`status in ('accepted','sent','delivered','read','failed','deleted')`,
    )
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('whatsapp_message_statuses').ifExists().execute()
  await db.schema.dropTable('whatsapp_send_attempts').ifExists().execute()
  await db.schema.dropTable('whatsapp_cloud_accounts').ifExists().execute()
  await db.schema.dropTable('platform_secrets').ifExists().execute()
}
