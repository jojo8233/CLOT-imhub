import { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // 可空。null 表示自动跟随客户语言（见 translation/target-lang.ts），
  // 有值表示员工按会话锁定了目标语言。
  await db.schema.alterTable('conversations')
    .addColumn('target_lang', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('conversations')
    .dropColumn('target_lang')
    .execute()
}
