import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from './types.js'
import { testDatabaseUrl } from './test-db.js'
import { organizationPreflight } from './organization-preflight.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})

afterAll(async () => db.destroy())

interface Fixture {
  schema: string
  isolated: Kysely<Database>
  ownerId: string
  managerId: string
  agentId: string
  teamId: string
}

async function createFixture(includeTeamArchival = true): Promise<Fixture> {
  const schema = `m4_org_preflight_${randomUUID().replaceAll('-', '')}`
  await sql`create schema ${sql.id(schema)}`.execute(db)
  const isolated = db.withSchema(schema)
  await isolated.schema.createTable('users')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('role', 'text', column => column.notNull())
    .addColumn('disabled_at', 'timestamptz')
    .execute()
  let teamTable = isolated.schema.createTable('teams')
    .addColumn('id', 'uuid', column => column.primaryKey())
  if (includeTeamArchival) {
    teamTable = teamTable.addColumn('disabled_at', 'timestamptz')
  }
  await teamTable.execute()
  await isolated.schema.createTable('team_members')
    .addColumn('team_id', 'uuid', column => column.notNull().references('teams.id'))
    .addColumn('user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('is_lead', 'boolean', column => column.notNull())
    .addPrimaryKeyConstraint('team_members_pk', ['user_id', 'team_id'])
    .execute()
  await isolated.schema.createTable('accounts')
    .addColumn('id', 'uuid', column => column.primaryKey())
    .addColumn('owner_user_id', 'uuid', column => column.notNull().references('users.id'))
    .addColumn('team_id', 'uuid', column => column.references('teams.id'))
    .execute()

  const fixture = {
    schema,
    isolated,
    ownerId: randomUUID(),
    managerId: randomUUID(),
    agentId: randomUUID(),
    teamId: randomUUID(),
  }
  await sql`
    insert into ${sql.table(`${schema}.users`)} (id, role, disabled_at)
    values
      (${fixture.ownerId}, 'owner', null),
      (${fixture.managerId}, 'manager', null),
      (${fixture.agentId}, 'agent', null)
  `.execute(db)
  if (includeTeamArchival) {
    await sql`
      insert into ${sql.table(`${schema}.teams`)} (id, disabled_at)
      values (${fixture.teamId}, null)
    `.execute(db)
  } else {
    await sql`
      insert into ${sql.table(`${schema}.teams`)} (id)
      values (${fixture.teamId})
    `.execute(db)
  }
  await isolated.insertInto('team_members').values([
    { team_id: fixture.teamId, user_id: fixture.managerId, is_lead: true },
    { team_id: fixture.teamId, user_id: fixture.agentId, is_lead: false },
  ]).execute()
  await sql`
    insert into ${sql.table(`${schema}.accounts`)} (id, owner_user_id, team_id)
    values
      (${randomUUID()}, ${fixture.ownerId}, null),
      (${randomUUID()}, ${fixture.agentId}, ${fixture.teamId})
  `.execute(db)
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await sql`drop schema if exists ${sql.id(fixture.schema)} cascade`.execute(db)
}

describe('organizationPreflight', () => {
  it('有效组织返回无问题报告', async () => {
    const fixture = await createFixture()
    try {
      expect(await organizationPreflight(fixture.isolated)).toEqual({ ok: true, issues: [] })
    } finally {
      await dropFixture(fixture)
    }
  })

  it('在 migration 0016 前 teams 尚无 disabled_at 时也能体检', async () => {
    const fixture = await createFixture(false)
    try {
      expect(await organizationPreflight(fixture.isolated)).toEqual({ ok: true, issues: [] })
    } finally {
      await dropFixture(fixture)
    }
  })

  it('只用代码和数量报告缺失 owner', async () => {
    const fixture = await createFixture()
    try {
      await fixture.isolated.updateTable('users')
        .set({ role: 'auditor' })
        .where('id', '=', fixture.ownerId)
        .execute()

      const report = await organizationPreflight(fixture.isolated)
      expect(report.issues).toContainEqual({ code: 'enabled_owner_count', count: 0 })
      expect(JSON.stringify(report)).not.toContain(fixture.ownerId)
    } finally {
      await dropFixture(fixture)
    }
  })

  it('报告没有主管的启用团队', async () => {
    const fixture = await createFixture()
    try {
      await fixture.isolated.deleteFrom('team_members')
        .where('user_id', '=', fixture.managerId)
        .execute()

      expect((await organizationPreflight(fixture.isolated)).issues).toContainEqual({
        code: 'team_lead_count',
        count: 1,
      })
    } finally {
      await dropFixture(fixture)
    }
  })

  it('报告跨两个团队的 agent', async () => {
    const fixture = await createFixture()
    try {
      const secondTeamId = randomUUID()
      await sql`
        insert into ${sql.table(`${fixture.schema}.teams`)} (id, disabled_at)
        values (${secondTeamId}, null)
      `.execute(db)
      await fixture.isolated.insertInto('team_members').values([
        { team_id: secondTeamId, user_id: fixture.managerId, is_lead: true },
        { team_id: secondTeamId, user_id: fixture.agentId, is_lead: false },
      ]).execute()

      expect((await organizationPreflight(fixture.isolated)).issues).toContainEqual({
        code: 'multi_team_agent',
        count: 1,
      })
    } finally {
      await dropFixture(fixture)
    }
  })

  it('归档团队不要求主管，但其中残留 membership 会单独报错', async () => {
    const fixture = await createFixture()
    try {
      await fixture.isolated.updateTable('teams')
        .set({ disabled_at: new Date('2026-09-05T00:00:00.000Z') })
        .where('id', '=', fixture.teamId)
        .execute()

      const report = await organizationPreflight(fixture.isolated)
      expect(report.issues).not.toContainEqual({ code: 'team_lead_count', count: 1 })
      expect(report.issues).toContainEqual({ code: 'invalid_membership', count: 2 })
    } finally {
      await dropFixture(fixture)
    }
  })
})
