import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../types.js'
import { testDatabaseUrl } from '../test-db.js'
import { down, up } from './0017_translation_provider_preferences.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

afterAll(async () => db.destroy())

interface BaseRows {
  userId: string
  messageId: string
}

async function createBaseSchema(schema: string): Promise<BaseRows> {
  await sql`create schema ${sql.id(schema)}`.execute(db)
  const isolated = db.withSchema(schema)
  await isolated.schema.createTable('users')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .execute()
  await isolated.schema.createTable('messages')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .execute()
  await isolated.schema.createTable('message_translations')
    .addColumn(
      'message_id',
      'uuid',
      column => column.notNull().references('messages.id').onDelete('cascade'),
    )
    .addColumn('target_lang', 'text', column => column.notNull())
    .addColumn('provider', 'text', column => column.notNull())
    .addColumn('translated_text', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('message_translations_pk', ['message_id', 'target_lang'])
    .execute()

  const rows = { userId: randomUUID(), messageId: randomUUID() }
  await sql`insert into ${sql.table(`${schema}.users`)} (id) values (${rows.userId})`.execute(db)
  await sql`insert into ${sql.table(`${schema}.messages`)} (id) values (${rows.messageId})`.execute(db)
  await sql`
    insert into ${sql.table(`${schema}.message_translations`)}
      (message_id, target_lang, provider, translated_text, created_at)
    values (${rows.messageId}, 'zh', 'deepl', 'legacy', '2026-01-01T00:00:00Z')
  `.execute(db)
  return rows
}

describe('0017_translation_provider_preferences', () => {
  it('adds a constrained user preference and permits provider-specific translations', async () => {
    const schema = `translation_provider_${randomUUID().replaceAll('-', '')}`
    const rows = await createBaseSchema(schema)
    const isolated = db.withSchema(schema)

    try {
      await up(isolated)

      const initial = await isolated.selectFrom('users')
        .select('preferred_translation_provider')
        .where('id', '=', rows.userId)
        .executeTakeFirstOrThrow()
      expect(initial.preferred_translation_provider).toBe('deepl')

      await isolated.updateTable('users')
        .set({ preferred_translation_provider: 'claude' })
        .where('id', '=', rows.userId)
        .execute()
      await isolated.insertInto('message_translations').values({
        message_id: rows.messageId,
        target_lang: 'zh',
        provider: 'openai',
        translated_text: 'provider-specific',
      }).execute()

      const translations = await isolated.selectFrom('message_translations')
        .select(['provider', 'translated_text'])
        .where('message_id', '=', rows.messageId)
        .where('target_lang', '=', 'zh')
        .orderBy('provider')
        .execute()
      expect(translations).toEqual([
        { provider: 'deepl', translated_text: 'legacy' },
        { provider: 'openai', translated_text: 'provider-specific' },
      ])

      await expect(sql`
        update ${sql.table(`${schema}.users`)}
        set preferred_translation_provider = 'invalid'
        where id = ${rows.userId}
      `.execute(db)).rejects.toMatchObject({ constraint: 'users_translation_provider_check' })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })

  it('development rollback keeps the newest translation per message and language', async () => {
    const schema = `translation_provider_down_${randomUUID().replaceAll('-', '')}`
    const rows = await createBaseSchema(schema)
    const isolated = db.withSchema(schema)

    try {
      await up(isolated)
      await sql`
        insert into ${sql.table(`${schema}.message_translations`)}
          (message_id, target_lang, provider, translated_text, created_at)
        values (${rows.messageId}, 'zh', 'openai', 'newest', '2026-02-01T00:00:00Z')
      `.execute(db)

      await down(isolated)

      const translations = await isolated.selectFrom('message_translations')
        .select(['provider', 'translated_text'])
        .where('message_id', '=', rows.messageId)
        .where('target_lang', '=', 'zh')
        .execute()
      expect(translations).toEqual([{ provider: 'openai', translated_text: 'newest' }])
      await expect(isolated.selectFrom('users')
        .select('preferred_translation_provider')
        .execute()).rejects.toMatchObject({ code: '42703' })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })
})
