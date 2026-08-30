import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.createTable('message_reactions')
    .addColumn('account_id', 'uuid', column => column.notNull()
      .references('accounts.id').onDelete('cascade'))
    .addColumn('platform_message_id', 'text', column => column.notNull())
    .addColumn('reactor_external_id', 'text', column => column.notNull())
    .addColumn('emoji', 'text')
    .addColumn('reacted_at', 'timestamptz', column => column.notNull())
    .addPrimaryKeyConstraint('message_reactions_pkey', [
      'account_id', 'platform_message_id', 'reactor_external_id',
    ])
    .execute()

  // 不建立 messages 外键：Signal 回应可能先于目标消息抵达，必须允许保存孤儿事实，
  // 等后续 message.upsert 用同一个规范键自然汇合。
  await sql`
    alter table message_reactions
      add constraint message_reactions_platform_message_id_nonempty
        check (length(platform_message_id) > 0),
      add constraint message_reactions_reactor_external_id_nonempty
        check (length(reactor_external_id) > 0),
      add constraint message_reactions_emoji_length
        check (emoji is null or (length(emoji) > 0 and length(emoji) <= 64))
  `.execute(db)

  await db.schema.createIndex('message_reactions_target_idx')
    .on('message_reactions')
    .columns(['account_id', 'platform_message_id'])
    .execute()
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('message_reactions').execute()
}
