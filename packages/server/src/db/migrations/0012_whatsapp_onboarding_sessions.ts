import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

/**
 * 短时 Embedded Signup 票据。只保存 SHA-256，不保存 bearer ticket；ticket 通过
 * URL fragment 交给 HTTPS 页面，因此不会进入 Fastify/代理访问日志。
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('whatsapp_onboarding_sessions')
    .addColumn('id', 'uuid', c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('owner_user_id', 'uuid', c => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('team_id', 'uuid', c => c.references('teams.id').onDelete('set null'))
    .addColumn('display_name', 'text', c => c.notNull())
    .addColumn('ticket_sha256', 'text', c => c.notNull().unique())
    .addColumn('state', 'text', c => c.notNull().defaultTo('pending'))
    .addColumn('account_id', 'uuid', c => c.references('accounts.id').onDelete('set null'))
    .addColumn('error_code', 'text')
    .addColumn('expires_at', 'timestamptz', c => c.notNull())
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('consumed_at', 'timestamptz')
    .addCheckConstraint(
      'whatsapp_onboarding_sessions_state_check',
      sql`state in ('pending','processing','completed','failed')`,
    )
    .addCheckConstraint(
      'whatsapp_onboarding_sessions_ticket_hash_check',
      sql`ticket_sha256 ~ '^[0-9a-f]{64}$'`,
    )
    .execute()
  await db.schema.createIndex('whatsapp_onboarding_owner_created_idx')
    .on('whatsapp_onboarding_sessions')
    .columns(['owner_user_id', 'created_at'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('whatsapp_onboarding_sessions').ifExists().execute()
}
