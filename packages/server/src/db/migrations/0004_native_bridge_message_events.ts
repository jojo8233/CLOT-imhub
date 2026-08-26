import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('messages')
    .addColumn('reply_to_platform_message_id', 'text')
    .addColumn('edited_at', 'timestamptz')
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  // 平台把本地临时 id 换成最终 id 后，迟到的旧事件仍可能继续带临时 id。
  // alias 把两种 id 收敛到同一 messages.id，避免重新插出第二行。
  await db.schema.createTable('message_id_aliases')
    .addColumn('account_id', 'uuid', c => c.notNull().references('accounts.id').onDelete('cascade'))
    .addColumn('platform_message_id', 'text', c => c.notNull())
    .addColumn('message_id', 'uuid', c => c.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', c => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('message_id_aliases_pk', ['account_id', 'platform_message_id'])
    .execute()

  await db.schema.createIndex('message_id_aliases_message_idx')
    .on('message_id_aliases').column('message_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('message_id_aliases').ifExists().execute()
  await db.schema.alterTable('messages')
    .dropColumn('deleted_at')
    .dropColumn('edited_at')
    .dropColumn('reply_to_platform_message_id')
    .execute()
}
