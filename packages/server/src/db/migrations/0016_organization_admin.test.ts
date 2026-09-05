import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../types.js'
import { testDatabaseUrl } from '../test-db.js'
import { down, up } from './0016_organization_admin.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

afterAll(async () => db.destroy())

interface BaseRows {
  ownerId: string
  managerId: string
  teamId: string
  accountId: string
}

async function createBaseSchema(schema: string): Promise<BaseRows> {
  await sql`create schema ${sql.id(schema)}`.execute(db)
  const isolated = db.withSchema(schema)
  await isolated.schema.createTable('users')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('email', 'text', column => column.notNull().unique())
    .addColumn('display_name', 'text', column => column.notNull())
    .addColumn('role', 'text', column => column.notNull())
    .addColumn('password_hash', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .addColumn('disabled_at', 'timestamptz')
    .execute()
  await isolated.schema.createTable('teams')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('name', 'text', column => column.notNull())
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .execute()
  await isolated.schema.createTable('team_members')
    .addColumn('team_id', 'uuid', column => column.notNull().references('teams.id'))
    .addColumn('user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('is_lead', 'boolean', column => column.notNull().defaultTo(false))
    .addPrimaryKeyConstraint('team_members_pk', ['user_id', 'team_id'])
    .execute()
  await isolated.schema.createTable('accounts')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('platform', 'text', column => column.notNull())
    .addColumn('owner_user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('team_id', 'uuid', column => column.references('teams.id'))
    .addColumn('display_name', 'text', column => column.notNull())
    .addColumn('status', 'text', column => column.notNull())
    .addColumn('native_control_version', 'integer', column => column.notNull().defaultTo(1))
    .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
    .execute()

  const rows = {
    ownerId: randomUUID(),
    managerId: randomUUID(),
    teamId: randomUUID(),
    accountId: randomUUID(),
  }
  await sql`
    insert into ${sql.table(`${schema}.users`)}
      (id, email, display_name, role, password_hash)
    values
      (${rows.ownerId}, 'owner@example.test', 'Owner', 'owner', 'test-only'),
      (${rows.managerId}, 'manager@example.test', 'Manager', 'manager', 'test-only')
  `.execute(db)
  await sql`
    insert into ${sql.table(`${schema}.teams`)} (id, name)
    values (${rows.teamId}, 'Synthetic team')
  `.execute(db)
  await sql`
    insert into ${sql.table(`${schema}.team_members`)} (team_id, user_id, is_lead)
    values (${rows.teamId}, ${rows.managerId}, true)
  `.execute(db)
  await sql`
    insert into ${sql.table(`${schema}.accounts`)}
      (id, platform, owner_user_id, team_id, display_name, status)
    values
      (${rows.accountId}, 'telegram', ${rows.ownerId}, ${rows.teamId}, 'Synthetic account', 'connected')
  `.execute(db)
  return rows
}

async function columnNames(schema: string, table: string): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = ${schema} and table_name = ${table}
    order by ordinal_position
  `.execute(db)
  return result.rows.map(row => row.column_name)
}

describe('0016_organization_admin', () => {
  it('增加版本字段与设备清理表，并允许无安装实例的人工 Signal 待办', async () => {
    const schema = `m4_org_${randomUUID().replaceAll('-', '')}`
    const rows = await createBaseSchema(schema)
    const isolated = db.withSchema(schema)

    try {
      await up(isolated)

      expect(await columnNames(schema, 'users')).toEqual(expect.arrayContaining([
        'session_version',
        'must_change_password',
        'temporary_password_expires_at',
        'revision',
        'updated_at',
      ]))
      expect(await columnNames(schema, 'teams')).toEqual(expect.arrayContaining([
        'disabled_at',
        'revision',
        'updated_at',
      ]))
      expect(await columnNames(schema, 'accounts')).toContain('revision')

      const tables = await sql<{
        installations: string | null
        mounts: string | null
        tasks: string | null
      }>`
        select
          to_regclass(${`${schema}.desktop_installations`})::text as installations,
          to_regclass(${`${schema}.account_device_mounts`})::text as mounts,
          to_regclass(${`${schema}.desktop_cleanup_tasks`})::text as tasks
      `.execute(db)
      expect(tables.rows[0]).toEqual({
        installations: `${schema}.desktop_installations`,
        mounts: `${schema}.account_device_mounts`,
        tasks: `${schema}.desktop_cleanup_tasks`,
      })

      await sql`
        insert into ${sql.table(`${schema}.desktop_cleanup_tasks`)}
          (account_id, mode, reason, state)
        values
          (${rows.accountId}, 'manual_required', 'signal_official_unlink', 'pending')
      `.execute(db)

      await down(isolated)
      expect(await columnNames(schema, 'users')).not.toContain('session_version')
      const afterDown = await sql<{ tasks: string | null }>`
        select to_regclass(${`${schema}.desktop_cleanup_tasks`})::text as tasks
      `.execute(db)
      expect(afterDown.rows[0]).toEqual({ tasks: null })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })

  it('数据库约束拒绝第二个启用 owner', async () => {
    const schema = `m4_org_owner_${randomUUID().replaceAll('-', '')}`
    await createBaseSchema(schema)

    try {
      await up(db.withSchema(schema))

      await expect(sql`
        insert into ${sql.table(`${schema}.users`)}
          (id, email, display_name, role, password_hash)
        values
          (${randomUUID()}, 'owner-2@example.test', 'Owner 2', 'owner', 'test-only')
      `.execute(db)).rejects.toMatchObject({ constraint: 'users_single_enabled_owner_uq' })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })

  it('数据库约束拒绝同一团队的第二个主管', async () => {
    const schema = `m4_org_lead_${randomUUID().replaceAll('-', '')}`
    const rows = await createBaseSchema(schema)

    try {
      await up(db.withSchema(schema))
      const managerId = randomUUID()
      await sql`
        insert into ${sql.table(`${schema}.users`)}
          (id, email, display_name, role, password_hash)
        values
          (${managerId}, 'manager-2@example.test', 'Manager 2', 'manager', 'test-only')
      `.execute(db)

      await expect(sql`
        insert into ${sql.table(`${schema}.team_members`)} (team_id, user_id, is_lead)
        values (${rows.teamId}, ${managerId}, true)
      `.execute(db)).rejects.toMatchObject({ constraint: 'team_members_single_lead_uq' })
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    }
  })
})
