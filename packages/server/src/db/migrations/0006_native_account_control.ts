import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('accounts')
    .addColumn('platform_account_external_id', 'text')
    .execute()
  await db.schema.alterTable('accounts')
    .addColumn('native_control_version', 'integer', column => column.notNull().defaultTo(0))
    .execute()
  await sql`
    alter table accounts
      add constraint accounts_platform_external_id_nonempty
        check (platform_account_external_id is null or length(btrim(platform_account_external_id)) > 0),
      add constraint accounts_native_control_version_nonnegative
        check (native_control_version >= 0)
  `.execute(db)
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table accounts
      drop constraint if exists accounts_native_control_version_nonnegative,
      drop constraint if exists accounts_platform_external_id_nonempty
  `.execute(db)
  await db.schema.alterTable('accounts')
    .dropColumn('native_control_version')
    .execute()
  await db.schema.alterTable('accounts')
    .dropColumn('platform_account_external_id')
    .execute()
}
