import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../types.js'
import { testDatabaseUrl } from '../test-db.js'
import { down, up } from './0014_customer_profile_library.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

afterAll(async () => db.destroy())

describe('0014_customer_profile_library', () => {
  it('删除审计表、增加分页索引，并提供只恢复结构的 down 路径', async () => {
    const schema = `m4_library_${randomUUID().replaceAll('-', '')}`
    await sql`create schema ${sql.id(schema)}`.execute(db)
    const isolated = db.withSchema(schema)

    try {
      await isolated.schema.createTable('users')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()
      await isolated.schema.createTable('accounts')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()
      await isolated.schema.createTable('conversations')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()
      await isolated.schema.createTable('customer_profiles')
        .addColumn('conversation_id', 'uuid', column => column.primaryKey())
        .addColumn('updated_at', 'timestamptz', column => column.notNull())
        .execute()
      await isolated.schema.createTable('audit_logs')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()

      await up(isolated)
      const afterUp = await sql<{
        auditTable: string | null
        profileIndex: string | null
      }>`
        select
          to_regclass(${`${schema}.audit_logs`})::text as "auditTable",
          to_regclass(${`${schema}.customer_profiles_updated_conversation_idx`})::text
            as "profileIndex"
      `.execute(db)
      expect(afterUp.rows[0]).toEqual({
        auditTable: null,
        profileIndex: `${schema}.customer_profiles_updated_conversation_idx`,
      })

      await down(isolated)
      const afterDown = await sql<{
        auditTable: string | null
        profileIndex: string | null
      }>`
        select
          to_regclass(${`${schema}.audit_logs`})::text as "auditTable",
          to_regclass(${`${schema}.customer_profiles_updated_conversation_idx`})::text
            as "profileIndex"
      `.execute(db)
      expect(afterDown.rows[0]).toEqual({
        auditTable: `${schema}.audit_logs`,
        profileIndex: null,
      })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })
})
