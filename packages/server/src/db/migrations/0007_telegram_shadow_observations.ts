import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('telegram_shadow_observations')
    .addColumn('account_id', 'uuid', column => column.notNull()
      .references('accounts.id').onDelete('cascade'))
    .addColumn('source', 'text', column => column.notNull())
    .addColumn('event_type', 'text', column => column.notNull())
    .addColumn('fact_key', 'text', column => column.notNull())
    .addColumn('semantic_hash', 'text', column => column.notNull())
    .addColumn('has_conflict', 'boolean', column => column.notNull().defaultTo(false))
    .addColumn('observation_count', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('first_observed_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('last_observed_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('telegram_shadow_observations_pkey', [
      'account_id', 'source', 'fact_key',
    ])
    .execute()

  await sql`
    alter table telegram_shadow_observations
      add constraint telegram_shadow_observations_source_check
        check (source in ('tdlib', 'telegram-tt')),
      add constraint telegram_shadow_observations_event_type_check
        check (event_type in ('upsert', 'delete', 'remap')),
      add constraint telegram_shadow_observations_fact_key_nonempty
        check (length(fact_key) > 0),
      add constraint telegram_shadow_observations_semantic_hash_check
        check (semantic_hash ~ '^[0-9a-f]{64}$'),
      add constraint telegram_shadow_observations_count_positive
        check (observation_count > 0),
      add constraint telegram_shadow_observations_time_order
        check (last_observed_at >= first_observed_at)
  `.execute(db)

  await db.schema.createIndex('telegram_shadow_observations_account_fact_idx')
    .on('telegram_shadow_observations')
    .columns(['account_id', 'fact_key'])
    .execute()
  await db.schema.createIndex('telegram_shadow_observations_account_first_idx')
    .on('telegram_shadow_observations')
    .columns(['account_id', 'first_observed_at'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('telegram_shadow_observations').execute()
}
