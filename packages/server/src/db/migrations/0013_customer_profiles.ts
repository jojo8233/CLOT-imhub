import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('customer_profiles')
    .addColumn('conversation_id', 'uuid', c => c.primaryKey()
      .references('conversations.id').onDelete('cascade'))
    .addColumn('name', 'text')
    .addColumn('age_location', 'text')
    .addColumn('occupation', 'text')
    .addColumn('family', 'text')
    .addColumn('interests', 'text')
    .addColumn('other', 'text')
    .addColumn('revision', 'integer', c => c.notNull())
    .addColumn('updated_by_user_id', 'uuid', c => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('customer_profiles_revision_check', sql`revision > 0`)
    .addCheckConstraint(
      'customer_profiles_name_length_check',
      sql`name is null or char_length(name) <= 200`,
    )
    .addCheckConstraint(
      'customer_profiles_age_location_length_check',
      sql`age_location is null or char_length(age_location) <= 2000`,
    )
    .addCheckConstraint(
      'customer_profiles_occupation_length_check',
      sql`occupation is null or char_length(occupation) <= 2000`,
    )
    .addCheckConstraint(
      'customer_profiles_family_length_check',
      sql`family is null or char_length(family) <= 2000`,
    )
    .addCheckConstraint(
      'customer_profiles_interests_length_check',
      sql`interests is null or char_length(interests) <= 2000`,
    )
    .addCheckConstraint(
      'customer_profiles_other_length_check',
      sql`other is null or char_length(other) <= 2000`,
    )
    .execute()

  await db.schema.createTable('audit_logs')
    .addColumn('id', 'uuid', c => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('actor_user_id', 'uuid', c => c.references('users.id').onDelete('set null'))
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn(
      'conversation_id',
      'uuid',
      c => c.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('action', 'text', c => c.notNull())
    .addColumn('changed_fields', 'jsonb', c => c.notNull())
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
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

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('audit_logs').ifExists().execute()
  await db.schema.dropTable('customer_profiles').ifExists().execute()
}
