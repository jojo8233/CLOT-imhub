import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('keyword_rules')
    .addColumn('id', 'uuid', column => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('pattern', 'text', column => column.notNull())
    .addColumn('normalized_pattern', 'text', column => column.notNull())
    .addColumn('severity', 'text', column => column.notNull())
    .addColumn('enabled', 'boolean', column => column.notNull().defaultTo(true))
    .addColumn('revision', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('effective_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('created_by_user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('updated_by_user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint(
      'keyword_rules_severity_check',
      sql`severity in ('normal', 'important', 'urgent')`,
    )
    .addCheckConstraint('keyword_rules_revision_positive', sql`revision > 0`)
    .execute()

  await db.schema.createIndex('keyword_rules_normalized_active_uq')
    .unique()
    .on('keyword_rules')
    .column('normalized_pattern')
    .where(sql.ref('deleted_at'), 'is', null)
    .execute()
  await db.schema.createIndex('keyword_rules_enabled_effective_idx')
    .on('keyword_rules')
    .columns(['enabled', 'effective_at'])
    .execute()

  await db.schema.createTable('keyword_alert_scan_jobs')
    .addColumn('id', 'uuid', column => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn(
      'message_id',
      'uuid',
      column => column.notNull().references('messages.id').onDelete('cascade'),
    )
    .addColumn('message_revision', 'text', column => column.notNull())
    .addColumn('body_snapshot', 'text', column => column.notNull())
    .addColumn('available_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('attempt_count', 'integer', column => column.notNull().defaultTo(0))
    .addColumn('lease_owner', 'text')
    .addColumn('lease_expires_at', 'timestamptz')
    .addColumn('last_error_code', 'text')
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('keyword_alert_scan_jobs_message_revision_uq', [
      'message_id',
      'message_revision',
    ])
    .addCheckConstraint('keyword_alert_scan_jobs_attempt_count_nonnegative', sql`attempt_count >= 0`)
    .execute()
  await db.schema.createIndex('keyword_alert_scan_jobs_claim_idx')
    .on('keyword_alert_scan_jobs')
    .columns(['available_at', 'created_at', 'id'])
    .execute()

  await db.schema.createTable('keyword_alerts')
    .addColumn('id', 'uuid', column => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn(
      'message_id',
      'uuid',
      column => column.notNull().references('messages.id').onDelete('cascade'),
    )
    .addColumn('rule_id', 'uuid', column => column.notNull().references('keyword_rules.id'))
    .addColumn('pattern_snapshot', 'text', column => column.notNull())
    .addColumn('severity_snapshot', 'text', column => column.notNull())
    .addColumn('matched_message_revision', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('keyword_alerts_message_rule_uq', ['message_id', 'rule_id'])
    .addCheckConstraint(
      'keyword_alerts_severity_snapshot_check',
      sql`severity_snapshot in ('normal', 'important', 'urgent')`,
    )
    .execute()
  await db.schema.createIndex('keyword_alerts_created_id_idx')
    .on('keyword_alerts')
    .columns(['created_at', 'id'])
    .execute()

  await db.schema.createTable('keyword_alert_recipients')
    .addColumn(
      'alert_id',
      'uuid',
      column => column.notNull().references('keyword_alerts.id').onDelete('cascade'),
    )
    .addColumn(
      'user_id',
      'uuid',
      column => column.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('requires_ack', 'boolean', column => column.notNull())
    .addColumn('acknowledged_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('keyword_alert_recipients_pk', ['alert_id', 'user_id'])
    .addCheckConstraint(
      'keyword_alert_recipients_acknowledged_requires_ack',
      sql`acknowledged_at is null or requires_ack`,
    )
    .execute()
  await db.schema.createIndex('keyword_alert_recipients_user_status_idx')
    .on('keyword_alert_recipients')
    .columns(['user_id', 'requires_ack', 'acknowledged_at', 'alert_id'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('keyword_alert_recipients').ifExists().execute()
  await db.schema.dropTable('keyword_alerts').ifExists().execute()
  await db.schema.dropTable('keyword_alert_scan_jobs').ifExists().execute()
  await db.schema.dropTable('keyword_rules').ifExists().execute()
}
