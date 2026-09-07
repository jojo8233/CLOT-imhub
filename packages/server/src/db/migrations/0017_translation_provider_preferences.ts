import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('users')
    .addColumn(
      'preferred_translation_provider',
      'text',
      column => column.notNull().defaultTo('deepl'),
    )
    .execute()
  await db.schema.alterTable('users')
    .addCheckConstraint(
      'users_translation_provider_check',
      sql`preferred_translation_provider in ('deepl', 'claude', 'openai')`,
    )
    .execute()

  await db.schema.alterTable('message_translations')
    .dropConstraint('message_translations_pk')
    .execute()
  await db.schema.alterTable('message_translations')
    .addPrimaryKeyConstraint(
      'message_translations_pk',
      ['message_id', 'target_lang', 'provider'],
    )
    .execute()
}

/** Development-only rollback; production rollback restores a database backup. */
export async function down(db: Kysely<Database>): Promise<void> {
  const ranked = await db.selectFrom('message_translations')
    .select(['message_id', 'target_lang', 'provider'])
    .select(sql<number>`(row_number() over (
      partition by message_id, target_lang
      order by created_at desc, provider asc
    ))::integer`.as('provider_rank'))
    .execute()
  for (const row of ranked) {
    if (row.provider_rank === 1) continue
    await db.deleteFrom('message_translations')
      .where('message_id', '=', row.message_id)
      .where('target_lang', '=', row.target_lang)
      .where('provider', '=', row.provider)
      .execute()
  }

  await db.schema.alterTable('message_translations')
    .dropConstraint('message_translations_pk')
    .execute()
  await db.schema.alterTable('message_translations')
    .addPrimaryKeyConstraint('message_translations_pk', ['message_id', 'target_lang'])
    .execute()
  await db.schema.alterTable('users')
    .dropConstraint('users_translation_provider_check')
    .execute()
  await db.schema.alterTable('users')
    .dropColumn('preferred_translation_provider')
    .execute()
}
