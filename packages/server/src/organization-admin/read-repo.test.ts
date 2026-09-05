import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { AdminAccessError } from './admin-guard.js'
import { AdminCursorError, OrganizationReadRepo } from './read-repo.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const repo = new OrganizationReadRepo(db)
const owner: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
const manager: Actor = { userId: '', role: 'manager', leadTeamIds: [] }

async function createUser(role: Role, label: string, disabled = false): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: 'x',
    disabled_at: disabled ? new Date('2026-09-01T00:00:00.000Z') : null,
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
  manager.userId = await createUser('manager', 'manager')
})

afterAll(async () => db.destroy())

describe('OrganizationReadRepo.searchUsers', () => {
  it('只允许 owner 查询，并返回团队与账号聚合', async () => {
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic sales' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: manager.userId, is_lead: true,
    }).execute()
    const agentId = await createUser('agent', 'search-marker')
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: agentId, is_lead: false,
    }).execute()
    await db.insertInto('accounts').values({
      platform: 'telegram', owner_user_id: agentId, team_id: teamId,
      display_name: 'Synthetic account', status: 'connected',
    }).execute()

    await expect(repo.searchUsers(manager, {})).rejects.toBeInstanceOf(AdminAccessError)
    const page = await repo.searchUsers(owner, { q: 'SEARCH-MARKER' })
    expect(page.items).toEqual([expect.objectContaining({
      id: agentId,
      role: 'agent',
      teamIds: [teamId],
      ownedAccountCount: 1,
      revision: 1,
    })])
  })

  it('使用绑定筛选条件的稳定 cursor 分页', async () => {
    const createdIds = [
      await createUser('agent', 'page-a'),
      await createUser('agent', 'page-b'),
      await createUser('agent', 'page-c'),
    ].sort()

    const first = await repo.searchUsers(owner, { roles: ['agent'], limit: 1 })
    expect(first.items.map(item => item.id)).toEqual([createdIds[0]])
    expect(first.nextCursor).not.toBeNull()
    const second = await repo.searchUsers(owner, {
      roles: ['agent'], limit: 1, cursor: first.nextCursor ?? undefined,
    })
    expect(second.items.map(item => item.id)).toEqual([createdIds[1]])
    expect(second.nextCursor).not.toBeNull()
    const third = await repo.searchUsers(owner, {
      roles: ['agent'], limit: 1, cursor: second.nextCursor ?? undefined,
    })
    expect(third.items.map(item => item.id)).toEqual([createdIds[2]])
    expect(third.nextCursor).toBeNull()

    await expect(repo.searchUsers(owner, {
      roles: ['manager'], limit: 1, cursor: first.nextCursor ?? undefined,
    })).rejects.toBeInstanceOf(AdminCursorError)
  })

  it('支持启用状态和未分组筛选', async () => {
    const disabledId = await createUser('agent', 'disabled-filter', true)
    const page = await repo.searchUsers(owner, { status: 'disabled', teamId: null })
    expect(page.items.map(item => item.id)).toEqual([disabledId])
  })
})
