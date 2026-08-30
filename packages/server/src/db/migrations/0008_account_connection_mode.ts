import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('accounts')
    .addColumn('connection_mode', 'text', column => column.notNull().defaultTo('adapter'))
    .execute()
  await sql`
    alter table accounts
      add constraint accounts_connection_mode_check
        check (connection_mode in ('adapter', 'native_desktop'))
  `.execute(db)
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table accounts
      drop constraint if exists accounts_connection_mode_check
  `.execute(db)
  await db.schema.alterTable('accounts')
    .dropColumn('connection_mode')
    .execute()
}
