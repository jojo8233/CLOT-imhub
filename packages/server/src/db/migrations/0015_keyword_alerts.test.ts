import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../types.js'
import { testDatabaseUrl } from '../test-db.js'
import { down, up } from './0015_keyword_alerts.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

afterAll(async () => db.destroy())

describe('0015_keyword_alerts', () => {
  it('创建告警表而不回扫已有消息，并在 down 时移除全部结构', async () => {
    const schema = `m4_keyword_alerts_${randomUUID().replaceAll('-', '')}`
    const userId = randomUUID()
    const messageId = randomUUID()
    await sql`create schema ${sql.id(schema)}`.execute(db)
    const isolated = db.withSchema(schema)

    try {
      await isolated.schema.createTable('users')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()
      await isolated.schema.createTable('messages')
        .addColumn('id', 'uuid', column => column.primaryKey())
        .execute()
      await sql`
        insert into ${sql.table(`${schema}.users`)} (id)
        values (${userId})
      `.execute(db)
      await sql`
        insert into ${sql.table(`${schema}.messages`)} (id)
        values (${messageId})
      `.execute(db)

      await up(isolated)
      const afterUp = await sql<{
        rules: string | null
        jobs: string | null
        alerts: string | null
        recipients: string | null
      }>`
        select
          to_regclass(${`${schema}.keyword_rules`})::text as rules,
          to_regclass(${`${schema}.keyword_alert_scan_jobs`})::text as jobs,
          to_regclass(${`${schema}.keyword_alerts`})::text as alerts,
          to_regclass(${`${schema}.keyword_alert_recipients`})::text as recipients
      `.execute(db)
      expect(afterUp.rows[0]).toEqual({
        rules: `${schema}.keyword_rules`,
        jobs: `${schema}.keyword_alert_scan_jobs`,
        alerts: `${schema}.keyword_alerts`,
        recipients: `${schema}.keyword_alert_recipients`,
      })
      expect((await isolated.selectFrom('keyword_alert_scan_jobs').selectAll().execute())).toEqual([])

      await down(isolated)
      const afterDown = await sql<{
        rules: string | null
        jobs: string | null
        alerts: string | null
        recipients: string | null
      }>`
        select
          to_regclass(${`${schema}.keyword_rules`})::text as rules,
          to_regclass(${`${schema}.keyword_alert_scan_jobs`})::text as jobs,
          to_regclass(${`${schema}.keyword_alerts`})::text as alerts,
          to_regclass(${`${schema}.keyword_alert_recipients`})::text as recipients
      `.execute(db)
      expect(afterDown.rows[0]).toEqual({
        rules: null,
        jobs: null,
        alerts: null,
        recipients: null,
      })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })
})
