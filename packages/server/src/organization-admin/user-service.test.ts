import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { verifyPassword } from '../auth/password.js'
import { AdminAccessError } from './admin-guard.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import { AdminOperationTokenService } from './operation-token.js'
import { UserAdminService, UserAdminServiceError } from './user-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T00:00:00.000Z')
const temporaryPassword = 'synthetic-temporary-password-only-shown-once'
const deviceService = new DeviceService(new DeviceRepo(db), () => new Date(NOW))
const service = new UserAdminService(db, {
  now: () => new Date(NOW),
  generateTemporaryPassword: () => temporaryPassword,
  deviceService,
  operationTokens: new AdminOperationTokenService(
    'user-disable-operation-secret-32-chars',
    () => new Date(NOW),
  ),
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

describe('UserAdminService disable', () => {
  it('停用 agent 时账号原子转给 owner，保留团队并使旧控制权失效', async () => {
    const managerId = await createUser('manager', 'disable-agent-manager')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic disable agent team' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values([
      { team_id: teamId, user_id: managerId, is_lead: true },
      { team_id: teamId, user_id: agent.userId, is_lead: false },
    ]).execute()
    const accountId = (await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: agent.userId, team_id: teamId,
      display_name: 'Synthetic Signal disable', status: 'connected',
      connection_mode: 'native_desktop',
    }).returning('id').executeTakeFirstOrThrow()).id

    const preview = await service.previewDisable(owner, agent.userId, {
      baseRevision: 1, teamResolutions: [], allowManualCleanup: false,
    })
    expect(preview).toMatchObject({
      kind: 'preview',
      preview: { summary: { accountsTransferred: 1, manualCleanupTasks: 1 } },
    })
    if (preview.kind !== 'preview') throw new Error('expected disable preview')
    const disabled = await service.disable(owner, agent.userId, {
      operationToken: preview.preview.operationToken,
    })
    expect(disabled).toMatchObject({
      kind: 'disabled',
      user: { id: agent.userId, disabledAt: NOW.toISOString(), revision: 2 },
      effects: {
        cleanupRequestedUserIds: [agent.userId],
        revokedUserIds: [agent.userId],
      },
    })
    expect(await db.selectFrom('accounts').select([
      'owner_user_id', 'team_id', 'revision', 'native_control_version',
    ]).where('id', '=', accountId).executeTakeFirstOrThrow()).toEqual({
      owner_user_id: owner.userId,
      team_id: teamId,
      revision: 2,
      native_control_version: 1,
    })
    expect(await db.selectFrom('users').select(['disabled_at', 'session_version'])
      .where('id', '=', agent.userId).executeTakeFirstOrThrow()).toEqual({
      disabled_at: NOW,
      session_version: 2,
    })
  })

  it('停用 manager 必须为每个启用团队替换主管或归档', async () => {
    const targetId = await createUser('manager', 'disable-manager')
    const replacementId = await createUser('manager', 'replacement-manager')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic managed team' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: targetId, is_lead: true,
    }).execute()
    expect(await service.previewDisable(owner, targetId, {
      baseRevision: 1, teamResolutions: [], allowManualCleanup: false,
    })).toMatchObject({ kind: 'blocked' })

    const preview = await service.previewDisable(owner, targetId, {
      baseRevision: 1,
      teamResolutions: [{
        teamId, action: 'replace_manager', replacementManagerUserId: replacementId,
        baseRevision: 1,
      }],
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected manager disable preview')
    expect(await service.disable(owner, targetId, {
      operationToken: preview.preview.operationToken,
    })).toMatchObject({ kind: 'disabled' })
    expect(await db.selectFrom('team_members').select(['user_id', 'is_lead'])
      .where('team_id', '=', teamId).execute()).toEqual([
      { user_id: replacementId, is_lead: true },
    ])
  })

  it('归档 resolution 会把团队账号变为未分组，但保留非停用员工的负责关系', async () => {
    const targetId = await createUser('manager', 'archive-manager')
    const memberId = await createUser('agent', 'archive-member')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic archive resolution' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values([
      { team_id: teamId, user_id: targetId, is_lead: true },
      { team_id: teamId, user_id: memberId, is_lead: false },
    ]).execute()
    const targetAccountId = (await db.insertInto('accounts').values({
      platform: 'telegram', owner_user_id: targetId, team_id: teamId,
      display_name: 'Manager adapter', status: 'connected', connection_mode: 'adapter',
    }).returning('id').executeTakeFirstOrThrow()).id
    const memberAccountId = (await db.insertInto('accounts').values({
      platform: 'telegram', owner_user_id: memberId, team_id: teamId,
      display_name: 'Member adapter', status: 'connected', connection_mode: 'adapter',
    }).returning('id').executeTakeFirstOrThrow()).id
    const preview = await service.previewDisable(owner, targetId, {
      baseRevision: 1,
      teamResolutions: [{ teamId, action: 'archive', baseRevision: 1 }],
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected archive disable preview')
    await service.disable(owner, targetId, { operationToken: preview.preview.operationToken })

    const accounts = await db.selectFrom('accounts').select(['id', 'owner_user_id', 'team_id'])
      .where('id', 'in', [targetAccountId, memberAccountId]).orderBy('id').execute()
    expect(accounts.find(row => row.id === targetAccountId)).toMatchObject({
      owner_user_id: owner.userId, team_id: null,
    })
    expect(accounts.find(row => row.id === memberAccountId)).toMatchObject({
      owner_user_id: memberId, team_id: null,
    })
    expect((await db.selectFrom('teams').select('disabled_at')
      .where('id', '=', teamId).executeTakeFirstOrThrow()).disabled_at).toEqual(NOW)
  })

  it('任一 resolution 失效都不留半停用状态', async () => {
    const targetId = await createUser('manager', 'rollback-manager')
    const teamId = (await db.insertInto('teams').values({ name: 'Synthetic rollback team' })
      .returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: targetId, is_lead: true,
    }).execute()
    const preview = await service.previewDisable(owner, targetId, {
      baseRevision: 1,
      teamResolutions: [{ teamId, action: 'archive', baseRevision: 1 }],
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected rollback preview')
    await db.updateTable('teams').set(expression => ({
      revision: expression('revision', '+', 1),
    })).where('id', '=', teamId).execute()

    await expect(service.disable(owner, targetId, {
      operationToken: preview.preview.operationToken,
    })).rejects.toMatchObject({ code: 'OPERATION_PREVIEW_EXPIRED' })
    expect((await db.selectFrom('users').select('disabled_at')
      .where('id', '=', targetId).executeTakeFirstOrThrow()).disabled_at).toBeNull()
    expect(await db.selectFrom('team_members').select('user_id')
      .where('team_id', '=', teamId).execute()).toEqual([{ user_id: targetId }])
  })
})
