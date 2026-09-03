import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('audit_logs').ifExists().execute()
  await db.schema.createIndex('customer_profiles_updated_conversation_idx')
    .on('customer_profiles')
    .columns(['updated_at', 'conversation_id'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex('customer_profiles_updated_conversation_idx')
    .ifExists()
    .execute()
  await db.schema.createTable('audit_logs')
    .addColumn('id', 'uuid', column => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('actor_user_id', 'uuid', column => column.references('users.id').onDelete('set null'))
    .addColumn(
      'account_id',
      'uuid',
      column => column.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn(
      'conversation_id',
      'uuid',
      column => column.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('action', 'text', column => column.notNull())
    .addColumn('changed_fields', 'jsonb', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('audit_logs_action_check', sql`action = 'customer_profile.updated'`)
    .addCheckConstraint(
      'audit_logs_changed_fields_check',
      sql`jsonb_typeof(changed_fields) = 'array' and jsonb_array_length(changed_fields) > 0`,
    )
    .execute()
  await db.schema.createIndex('audit_logs_account_created_idx')
    .on('audit_logs')
    .columns(['account_id', 'created_at'])
    .execute()
}
