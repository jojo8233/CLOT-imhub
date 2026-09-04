import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { verifyPassword } from '../auth/password.js'
import { AdminAccessError } from './admin-guard.js'
import { UserAdminService, UserAdminServiceError } from './user-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T00:00:00.000Z')
const temporaryPassword = 'synthetic-temporary-password-only-shown-once'
const service = new UserAdminService(db, {
  now: () => new Date(NOW),
  generateTemporaryPassword: () => temporaryPassword,
})
const owner: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
const agent: Actor = { userId: '', role: 'agent', leadTeamIds: [] }

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
  agent.userId = await createUser('agent', 'existing-agent')
})

afterAll(async () => db.destroy())

describe('UserAdminService.create', () => {
  it('创建员工时只存 Argon2 哈希，临时密码 24 小时有效并可加入一个团队', async () => {
    const managerId = await createUser('manager', 'team-manager')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic create team' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: managerId, is_lead: true,
    }).execute()

    const result = await service.create(owner, {
      email: ' NEW.Agent@Example.Test ',
      displayName: ' New Agent ',
      role: 'agent',
      teamId,
    })

    expect(result).toMatchObject({
      user: { email: 'new.agent@example.test', displayName: 'New Agent', role: 'agent', revision: 1 },
      temporaryPassword,
      temporaryPasswordExpiresAt: '2026-09-06T00:00:00.000Z',
    })
    const stored = await db.selectFrom('users').select([
      'password_hash', 'must_change_password', 'temporary_password_expires_at',
    ]).where('id', '=', result.user.id).executeTakeFirstOrThrow()
    expect(stored.password_hash).not.toContain(temporaryPassword)
    expect(await verifyPassword(stored.password_hash, temporaryPassword)).toBe(true)
    expect(stored.must_change_password).toBe(true)
    expect(stored.temporary_password_expires_at?.toISOString())
      .toBe('2026-09-06T00:00:00.000Z')
    expect(await db.selectFrom('team_members').select('team_id')
      .where('user_id', '=', result.user.id).execute()).toEqual([{ team_id: teamId }])
  })

  it('拒绝非 owner、普通创建 owner 和重复邮箱', async () => {
    await expect(service.create(agent, {
      email: 'blocked@example.test', displayName: 'Blocked', role: 'agent', teamId: null,
    })).rejects.toBeInstanceOf(AdminAccessError)
    await expect(service.create(owner, {
      email: 'owner2@example.test', displayName: 'Owner 2', role: 'owner', teamId: null,
    } as never)).rejects.toMatchObject({ code: 'OWNER_IMMUTABLE' })

    await service.create(owner, {
      email: 'duplicate@example.test', displayName: 'First', role: 'auditor', teamId: null,
    })
    await expect(service.create(owner, {
      email: ' DUPLICATE@example.test ', displayName: 'Second', role: 'auditor', teamId: null,
    })).rejects.toBeInstanceOf(UserAdminServiceError)
    await expect(service.create(owner, {
      email: ' DUPLICATE@example.test ', displayName: 'Second', role: 'auditor', teamId: null,
    })).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' })
  })
})

describe('UserAdminService update/reset/enable', () => {
  it('revision 过期返回最新非敏感快照', async () => {
    const result = await service.update(owner, agent.userId, {
      displayName: 'Changed', baseRevision: 2,
    })
    expect(result).toEqual({
      kind: 'conflict',
      current: expect.objectContaining({ id: agent.userId, revision: 1 }),
    })
    expect(result).not.toHaveProperty('password_hash')
  })

  it('有 membership 或名下账号时拒绝角色变更', async () => {
    const managerId = await createUser('manager', 'blocker-manager')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic blocker team' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values([
      { team_id: teamId, user_id: managerId, is_lead: true },
      { team_id: teamId, user_id: agent.userId, is_lead: false },
    ]).execute()
    await db.insertInto('accounts').values({
      platform: 'telegram', owner_user_id: agent.userId, team_id: teamId,
      display_name: 'Synthetic blocker account', status: 'connected',
    }).execute()

    expect(await service.update(owner, agent.userId, {
      role: 'auditor', baseRevision: 1,
    })).toEqual({
      kind: 'blocked',
      blockers: [
        { code: 'TEAM_MEMBERSHIPS_EXIST', count: 1 },
        { code: 'OWNED_ACCOUNTS_EXIST', count: 1 },
      ],
    })
  })

  it('无依赖角色变更递增 revision 与会话版本并要求撤权', async () => {
    const result = await service.update(owner, agent.userId, {
      role: 'auditor', baseRevision: 1,
    })
    expect(result).toEqual({
      kind: 'updated',
      user: expect.objectContaining({ id: agent.userId, role: 'auditor', revision: 2 }),
      revokeSession: true,
    })
    expect((await db.selectFrom('users').select('session_version')
      .where('id', '=', agent.userId).executeTakeFirstOrThrow()).session_version).toBe(2)
  })

  it('重置密码使旧会话失效并签发新的 24 小时临时密码', async () => {
    const result = await service.resetPassword(owner, agent.userId, { baseRevision: 1 })
    expect(result).toMatchObject({
      kind: 'updated',
      temporaryPassword,
      temporaryPasswordExpiresAt: '2026-09-06T00:00:00.000Z',
      revokeSession: true,
      user: { revision: 2 },
    })
    const stored = await db.selectFrom('users').select([
      'session_version', 'must_change_password', 'password_hash',
    ]).where('id', '=', agent.userId).executeTakeFirstOrThrow()
    expect(stored.session_version).toBe(2)
    expect(stored.must_change_password).toBe(true)
    expect(await verifyPassword(stored.password_hash, temporaryPassword)).toBe(true)
  })

  it('重新启用生成新临时密码，且普通服务永不修改 owner', async () => {
    const disabledId = await createUser('agent', 'disabled', true)
    const enabled = await service.enable(owner, disabledId, { baseRevision: 1 })
    expect(enabled).toMatchObject({
      kind: 'updated', temporaryPassword, revokeSession: true,
      user: { id: disabledId, disabledAt: null, revision: 2 },
    })
    expect(await service.update(owner, owner.userId, {
      displayName: 'Should not change', baseRevision: 1,
    })).toEqual({
      kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }],
    })
  })
})
