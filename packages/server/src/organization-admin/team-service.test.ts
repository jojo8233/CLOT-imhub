import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import { AdminOperationTokenService } from './operation-token.js'
import { TeamAdminService } from './team-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T00:00:00.000Z')
const teamService = new TeamAdminService(
  db,
  new DeviceService(new DeviceRepo(db), () => new Date(NOW)),
  new AdminOperationTokenService('team-service-operation-secret-32-chars', () => new Date(NOW)),
  () => new Date(NOW),
)
const owner: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
let firstManagerId: string
let secondManagerId: string
let agentId: string
let firstTeamId: string

async function createUser(role: Role, label: string): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`, display_name: `Synthetic ${label}`,
    role, password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function createAccount(userId: string, teamId: string | null, label: string): Promise<string> {
  return (await db.insertInto('accounts').values({
    platform: 'whatsapp', owner_user_id: userId, team_id: teamId,
    display_name: label, status: 'connected', connection_mode: 'web_shell',
  }).returning('id').executeTakeFirstOrThrow()).id
}

beforeEach(async () => {
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()
  owner.userId = await createUser('owner', 'owner')
  firstManagerId = await createUser('manager', 'first-manager')
  secondManagerId = await createUser('manager', 'second-manager')
  agentId = await createUser('agent', 'agent')
  firstTeamId = (await db.insertInto('teams').values({ name: 'Synthetic first team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: firstTeamId, user_id: firstManagerId, is_lead: true },
    { team_id: firstTeamId, user_id: agentId, is_lead: false },
  ]).execute()
})

afterAll(async () => db.destroy())

describe('TeamAdminService create and membership', () => {
  it('创建启用团队必须指定启用 manager，且同一 manager 可负责多个团队', async () => {
    const result = await teamService.create(owner, {
      name: 'Synthetic second team', managerUserId: firstManagerId,
    })
    expect(result).toMatchObject({
      kind: 'changed', team: { name: 'Synthetic second team', managerUserId: firstManagerId },
    })
    expect(await db.selectFrom('team_members').select('team_id')
      .where('user_id', '=', firstManagerId).where('is_lead', '=', true).execute())
      .toHaveLength(2)

    expect(await teamService.create(owner, {
      name: 'Invalid team', managerUserId: agentId,
    })).toEqual({
      kind: 'blocked', blockers: [{ code: 'MANAGER_INVALID', count: 1 }],
    })
  })

  it('agent 调组时成员关系和名下全部账号原子迁移，允许移到未分组', async () => {
    const next = await teamService.create(owner, {
      name: 'Synthetic next team', managerUserId: secondManagerId,
    })
    if (next.kind !== 'changed') throw new Error('expected created team')
    await createAccount(agentId, firstTeamId, 'Agent A')
    await createAccount(agentId, firstTeamId, 'Agent B')

    expect(await teamService.changeAgentTeam(owner, agentId, {
      teamId: next.team.id, baseRevision: 1,
    })).toMatchObject({ kind: 'changed', user: { teamIds: [next.team.id], revision: 2 } })
    expect((await db.selectFrom('accounts').select('team_id')
      .where('owner_user_id', '=', agentId).orderBy('id').execute()).map(row => row.team_id))
      .toEqual([next.team.id, next.team.id])

    expect(await teamService.changeAgentTeam(owner, agentId, {
      teamId: null, baseRevision: 2,
    })).toMatchObject({ kind: 'changed', user: { teamIds: [], revision: 3 } })
  })
})

describe('TeamAdminService manager change and archive', () => {
  it('换主管使用 preview token，并把旧主管在该组的账号转给唯一 owner', async () => {
    const accountId = await createAccount(firstManagerId, firstTeamId, 'Manager account')
    const preview = await teamService.previewManagerChange(owner, firstTeamId, {
      managerUserId: secondManagerId, baseRevision: 1,
    })
    expect(preview).toMatchObject({ kind: 'preview', preview: { summary: { accountsTransferred: 1 } } })
    if (preview.kind !== 'preview') throw new Error('expected preview')

    const changed = await teamService.executeManagerChange(owner, firstTeamId, {
      operationToken: preview.preview.operationToken,
    })
    expect(changed).toMatchObject({
      kind: 'changed', team: { managerUserId: secondManagerId, revision: 2 },
    })
    expect(await db.selectFrom('accounts').select(['owner_user_id', 'team_id'])
      .where('id', '=', accountId).executeTakeFirstOrThrow()).toEqual({
      owner_user_id: owner.userId, team_id: firstTeamId,
    })
  })

  it('换主管遇到在线旧版客户端时明确阻断并回滚清理待办', async () => {
    const accountId = await createAccount(firstManagerId, firstTeamId, 'Legacy client account')
    const installationId = randomUUID()
    await db.insertInto('desktop_installations').values({
      id: installationId,
      credential_sha256: '0'.repeat(64),
      client_version: 'legacy-test-client',
      capabilities: JSON.stringify([]),
      last_seen_at: NOW,
      revoked_at: null,
    }).execute()
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId,
      account_id: accountId,
      owner_user_id: firstManagerId,
      last_seen_at: NOW,
    }).execute()
    const preview = await teamService.previewManagerChange(owner, firstTeamId, {
      managerUserId: secondManagerId, baseRevision: 1,
    })
    if (preview.kind !== 'preview') throw new Error('expected preview')

    await expect(teamService.executeManagerChange(owner, firstTeamId, {
      operationToken: preview.preview.operationToken,
    })).rejects.toMatchObject({ code: 'CLIENT_UPDATE_REQUIRED' })
    expect(await db.selectFrom('accounts').select('owner_user_id')
      .where('id', '=', accountId).executeTakeFirstOrThrow())
      .toEqual({ owner_user_id: firstManagerId })
    expect(await db.selectFrom('desktop_cleanup_tasks').select('id').execute()).toEqual([])
  })

  it('归档会转移主管账号、移除成员并把所有账号变为未分组，恢复必须指定 manager', async () => {
    const managerAccountId = await createAccount(firstManagerId, firstTeamId, 'Manager archive')
    const agentAccountId = await createAccount(agentId, firstTeamId, 'Agent archive')
    const preview = await teamService.previewArchive(owner, firstTeamId, { baseRevision: 1 })
    if (preview.kind !== 'preview') throw new Error('expected archive preview')
    expect(await teamService.executeArchive(owner, firstTeamId, {
      operationToken: preview.preview.operationToken,
    })).toMatchObject({ kind: 'changed', team: { disabledAt: NOW.toISOString(), revision: 2 } })

    expect(await db.selectFrom('team_members').select('user_id')
      .where('team_id', '=', firstTeamId).execute()).toEqual([])
    expect(await db.selectFrom('accounts').select(['id', 'owner_user_id', 'team_id'])
      .where('id', 'in', [managerAccountId, agentAccountId]).orderBy('id').execute())
      .toEqual([
        { id: [managerAccountId, agentAccountId].sort()[0], owner_user_id: managerAccountId < agentAccountId ? owner.userId : agentId, team_id: null },
        { id: [managerAccountId, agentAccountId].sort()[1], owner_user_id: managerAccountId < agentAccountId ? agentId : owner.userId, team_id: null },
      ])

    expect(await teamService.restore(owner, firstTeamId, {
      managerUserId: secondManagerId, baseRevision: 2,
    })).toMatchObject({
      kind: 'changed', team: { disabledAt: null, managerUserId: secondManagerId, revision: 3 },
    })
  })

  it('stale revision 冲突且无任何部分修改', async () => {
    const result = await teamService.changeAgentTeam(owner, agentId, {
      teamId: null, baseRevision: 9,
    })
    expect(result).toMatchObject({ kind: 'conflict', current: { id: agentId, revision: 1 } })
    expect(await db.selectFrom('team_members').select('team_id')
      .where('user_id', '=', agentId).execute()).toEqual([{ team_id: firstTeamId }])
  })
})
