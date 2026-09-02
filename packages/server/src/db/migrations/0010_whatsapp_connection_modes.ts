import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

/**
 * 扩展连接模式，但不改写历史账号。
 *
 * 既有 WhatsApp adapter 账号继续保留原行为；新建官方网页壳显式使用 web_shell。
 * cloud_api 只预留结构，创建接口在官方授权接入前仍拒绝它。
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    alter table accounts
      drop constraint if exists accounts_connection_mode_check
  `.execute(db)
  await sql`
    alter table accounts
      add constraint accounts_connection_mode_check
        check (connection_mode in ('adapter', 'native_desktop', 'web_shell', 'cloud_api'))
  `.execute(db)
}

export async function down(db: Kysely<Database>): Promise<void> {
  const used = await db.selectFrom('accounts')
    .select(db.fn.countAll<string>().as('count'))
    .where('connection_mode', 'in', ['web_shell', 'cloud_api'])
    .executeTakeFirstOrThrow()
  if (Number(used.count) > 0) {
    throw new Error('cannot roll back WhatsApp connection modes while accounts still use them')
  }
  await sql`
    alter table accounts
      drop constraint if exists accounts_connection_mode_check
  `.execute(db)
  await sql`
    alter table accounts
      add constraint accounts_connection_mode_check
        check (connection_mode in ('adapter', 'native_desktop'))
  `.execute(db)
}
