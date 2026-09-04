import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('users')
    .addColumn('session_version', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('must_change_password', 'boolean', column => column.notNull().defaultTo(false))
    .addColumn('temporary_password_expires_at', 'timestamptz')
    .addColumn('revision', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('updated_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.alterTable('teams')
    .addColumn('disabled_at', 'timestamptz')
    .addColumn('revision', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('updated_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.alterTable('accounts')
    .addColumn('revision', 'integer', column => column.notNull().defaultTo(1))
    .execute()

  await db.schema.createIndex('users_single_enabled_owner_uq')
    .unique()
    .on('users')
    .expression(sql`(true)`)
    .where(sql<boolean>`role = 'owner' and disabled_at is null`)
    .execute()

  await db.schema.createIndex('team_members_single_lead_uq')
    .unique()
    .on('team_members')
    .column('team_id')
    .where(sql<boolean>`is_lead = true`)
    .execute()

  await db.schema.createTable('desktop_installations')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('credential_sha256', 'text', column => column.notNull())
    .addColumn('client_version', 'text', column => column.notNull())
    .addColumn('capabilities', 'jsonb', column => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('last_seen_at', 'timestamptz', column => column.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'desktop_installations_credential_sha256_length_check',
      sql`length(credential_sha256) = 64`,
    )
    .execute()

  await db.schema.createTable('account_device_mounts')
    .addColumn(
      'installation_id',
      'uuid',
      column => column.notNull().references('desktop_installations.id').onDelete('cascade'),
    )
    .addColumn(
      'account_id',
      'uuid',
      column => column.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn(
      'owner_user_id',
      'uuid',
      column => column.notNull().references('users.id'),
    )
    .addColumn('last_seen_at', 'timestamptz', column => column.notNull())
    .addPrimaryKeyConstraint('account_device_mounts_pk', ['installation_id', 'account_id'])
    .execute()

  await db.schema.createTable('desktop_cleanup_tasks')
    .addColumn('id', 'uuid', column => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn(
      'installation_id',
      'uuid',
      column => column.references('desktop_installations.id').onDelete('cascade'),
    )
    .addColumn(
      'account_id',
      'uuid',
      column => column.notNull().references('accounts.id').onDelete('cascade'),
    )
    .addColumn('mode', 'text', column => column.notNull())
    .addColumn('reason', 'text', column => column.notNull())
    .addColumn('state', 'text', column => column.notNull().defaultTo('pending'))
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .addCheckConstraint(
      'desktop_cleanup_tasks_mode_check',
      sql`mode in ('automatic', 'manual_required')`,
    )
    .addCheckConstraint(
      'desktop_cleanup_tasks_reason_check',
      sql`reason in ('ownership_changed', 'unsupported_client_override', 'signal_official_unlink')`,
    )
    .addCheckConstraint(
      'desktop_cleanup_tasks_state_check',
      sql`state in ('pending', 'completed')`,
    )
    .addCheckConstraint(
      'desktop_cleanup_tasks_completion_check',
      sql`(state = 'pending' and completed_at is null)
        or (state = 'completed' and completed_at is not null)`,
    )
    .addCheckConstraint(
      'desktop_cleanup_tasks_automatic_installation_check',
      sql`mode <> 'automatic' or installation_id is not null`,
    )
    .execute()

  await db.schema.createIndex('desktop_cleanup_tasks_installation_pending_idx')
    .on('desktop_cleanup_tasks')
    .columns(['installation_id', 'state', 'created_at'])
    .where('state', '=', 'pending')
    .execute()
  await db.schema.createIndex('desktop_cleanup_tasks_account_state_idx')
    .on('desktop_cleanup_tasks')
    .columns(['account_id', 'state'])
    .execute()
}

/** Development-only rollback; production organization state is not reversible. */
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('desktop_cleanup_tasks').ifExists().execute()
  await db.schema.dropTable('account_device_mounts').ifExists().execute()
  await db.schema.dropTable('desktop_installations').ifExists().execute()
  await db.schema.dropIndex('team_members_single_lead_uq').ifExists().execute()
  await db.schema.dropIndex('users_single_enabled_owner_uq').ifExists().execute()
  await db.schema.alterTable('accounts').dropColumn('revision').execute()
  await db.schema.alterTable('teams')
    .dropColumn('updated_at')
    .dropColumn('revision')
    .dropColumn('disabled_at')
    .execute()
  await db.schema.alterTable('users')
    .dropColumn('updated_at')
    .dropColumn('revision')
    .dropColumn('temporary_password_expires_at')
    .dropColumn('must_change_password')
    .dropColumn('session_version')
    .execute()
}
