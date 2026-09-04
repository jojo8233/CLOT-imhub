import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type {
  Actor,
  AdminOwnerTransferPreviewRequest,
  Role,
} from '@im-hub/shared'
import { hashPassword } from '../auth/password.js'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import { AdminOperationTokenService } from './operation-token.js'
import { OwnerTransferService } from './owner-transfer-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T12:00:00.000Z')
const CURRENT_PASSWORD = 'synthetic-current-owner-password'
const service = new OwnerTransferService(
  db,
  new DeviceService(new DeviceRepo(db), () => new Date(NOW)),
  new AdminOperationTokenService('owner-transfer-operation-secret-32-chars', () => new Date(NOW)),
  () => new Date(NOW),
)
const owner: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
let targetAgentId: string
let managerId: string
let auditorId: string
let teamId: string

async function createUser(role: Role, label: string, passwordHash = 'x'): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: passwordHash,
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function createAccount(ownerUserId: string, team: string | null): Promise<string> {
  return (await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: ownerUserId, team_id: team,
    display_name: `Synthetic transfer ${randomUUID()}`, status: 'connected',
    connection_mode: 'adapter',
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function previewAndExecute(input: AdminOwnerTransferPreviewRequest) {
  const preview = await service.preview(owner, input)
  if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`)
  return service.execute(owner, {
    operationToken: preview.preview.operationToken,
    currentPassword: CURRENT_PASSWORD,
  })
}

beforeEach(async () => {
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()
  owner.userId = await createUser('owner', 'owner', await hashPassword(CURRENT_PASSWORD))
  targetAgentId = await createUser('agent', 'target-agent')
  managerId = await createUser('manager', 'manager')
  auditorId = await createUser('auditor', 'auditor')
  teamId = (await db.insertInto('teams').values({ name: 'Synthetic owner-transfer team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: managerId, is_lead: true },
    { team_id: teamId, user_id: targetAgentId, is_lead: false },
  ]).execute()
})

afterAll(async () => db.destroy())

describe('OwnerTransferService', () => {
  it('目标 agent 变为 owner，旧 owner 变 agent，两人会话版本同时递增', async () => {
    const accountId = await createAccount(owner.userId, null)
    const result = await previewAndExecute({
      targetUserId: targetAgentId,
      currentOwnerNextRole: 'agent',
      currentOwnerTeamId: teamId,
      teamResolutions: [],
      accountResolutions: [{
        accountId, ownerUserId: owner.userId, teamId, baseRevision: 1,
      }],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    expect(result).toMatchObject({
      kind: 'transferred',
      currentOwner: { id: owner.userId, role: 'agent', teamIds: [teamId], revision: 2 },
      newOwner: { id: targetAgentId, role: 'owner', teamIds: [], revision: 2 },
      effects: { revokedUserIds: [owner.userId, targetAgentId].sort() },
    })
    expect(await db.selectFrom('users').select(['id', 'role', 'session_version'])
      .where('id', 'in', [owner.userId, targetAgentId]).orderBy('id').execute())
      .toEqual([
        { id: [owner.userId, targetAgentId].sort()[0], role: owner.userId < targetAgentId ? 'agent' : 'owner', session_version: 2 },
        { id: [owner.userId, targetAgentId].sort()[1], role: owner.userId < targetAgentId ? 'owner' : 'agent', session_version: 2 },
      ])
    expect(await db.selectFrom('users').select('id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null).execute())
      .toEqual([{ id: targetAgentId }])
    expect(await db.selectFrom('accounts').select(['owner_user_id', 'team_id'])
      .where('id', '=', accountId).executeTakeFirstOrThrow())
      .toEqual({ owner_user_id: owner.userId, team_id: teamId })
  })

  it('目标 manager 的每个团队必须替换主管或归档', async () => {
    await db.deleteFrom('team_members').where('user_id', '=', targetAgentId).execute()
    await db.deleteFrom('team_members').where('user_id', '=', managerId).execute()
    await db.updateTable('users').set({ role: 'manager' }).where('id', '=', targetAgentId).execute()
    await db.insertInto('team_members').values({
      team_id: teamId, user_id: targetAgentId, is_lead: true,
    }).execute()
    expect(await service.preview(owner, {
      targetUserId: targetAgentId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [],
      accountResolutions: [],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })).toMatchObject({ kind: 'blocked' })

    expect(await previewAndExecute({
      targetUserId: targetAgentId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [{
        teamId, action: 'replace_manager', replacementManagerUserId: managerId, baseRevision: 1,
      }],
      accountResolutions: [],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })).toMatchObject({ kind: 'transferred' })
    expect(await db.selectFrom('team_members').select(['user_id', 'is_lead'])
      .where('team_id', '=', teamId).execute())
      .toEqual([{ user_id: managerId, is_lead: true }])
  })

  it('旧 owner 变 manager 时必须明确选团队并处理被替换主管的账号', async () => {
    const managerAccountId = await createAccount(managerId, teamId)
    const result = await previewAndExecute({
      targetUserId: auditorId,
      currentOwnerNextRole: 'manager',
      currentOwnerTeamId: teamId,
      teamResolutions: [{
        teamId, action: 'replace_manager', replacementManagerUserId: owner.userId,
        baseRevision: 1,
      }],
      accountResolutions: [{
        accountId: managerAccountId, ownerUserId: auditorId, teamId, baseRevision: 1,
      }],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    expect(result).toMatchObject({
      kind: 'transferred',
      currentOwner: { role: 'manager', teamIds: [teamId] },
      newOwner: { id: auditorId, role: 'owner' },
    })
    expect(await db.selectFrom('accounts').select('owner_user_id')
      .where('id', '=', managerAccountId).executeTakeFirstOrThrow())
      .toEqual({ owner_user_id: auditorId })
  })

  it('当前密码错误时不更改任何角色或会话版本', async () => {
    const preview = await service.preview(owner, {
      targetUserId: auditorId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [],
      accountResolutions: [],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected password preview')
    expect(await service.execute(owner, {
      operationToken: preview.preview.operationToken,
      currentPassword: 'wrong-synthetic-password',
    })).toEqual({ kind: 'forbidden' })
    expect(await db.selectFrom('users').select(['id', 'role', 'session_version'])
      .where('id', 'in', [owner.userId, auditorId]).orderBy('id').execute())
      .toEqual([
        { id: [owner.userId, auditorId].sort()[0], role: owner.userId < auditorId ? 'owner' : 'auditor', session_version: 1 },
        { id: [owner.userId, auditorId].sort()[1], role: owner.userId < auditorId ? 'auditor' : 'owner', session_version: 1 },
      ])
  })

  it('预览后 revision 变更会回滚并保持唯一 owner', async () => {
    const accountId = await createAccount(owner.userId, null)
    const preview = await service.preview(owner, {
      targetUserId: auditorId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [],
      accountResolutions: [{
        accountId, ownerUserId: auditorId, teamId: null, baseRevision: 1,
      }],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected stale preview')
    await db.updateTable('accounts').set(expression => ({
      revision: expression('revision', '+', 1),
    })).where('id', '=', accountId).execute()
    await expect(service.execute(owner, {
      operationToken: preview.preview.operationToken,
      currentPassword: CURRENT_PASSWORD,
    })).rejects.toMatchObject({ code: 'OPERATION_PREVIEW_EXPIRED' })
    expect(await db.selectFrom('users').select('id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null).execute())
      .toEqual([{ id: owner.userId }])
  })

  it('同一预览令牌并发执行时只允许一次成功', async () => {
    const preview = await service.preview(owner, {
      targetUserId: auditorId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [],
      accountResolutions: [],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected concurrent preview')
    const execute = () => service.execute(owner, {
      operationToken: preview.preview.operationToken,
      currentPassword: CURRENT_PASSWORD,
    })
    const outcomes = await Promise.allSettled([execute(), execute()])
    expect(outcomes.filter(result => (
      result.status === 'fulfilled' && result.value.kind === 'transferred'
    ))).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await db.selectFrom('users').select('id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null).execute())
      .toEqual([{ id: auditorId }])
  })

  it('预览后出现在线旧版 Web 挂载时整个移交回滚', async () => {
    const accountId = (await db.insertInto('accounts').values({
      platform: 'whatsapp', owner_user_id: owner.userId, team_id: null,
      display_name: 'Synthetic late legacy mount', status: 'connected',
      connection_mode: 'web_shell',
    }).returning('id').executeTakeFirstOrThrow()).id
    const preview = await service.preview(owner, {
      targetUserId: auditorId,
      currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null,
      teamResolutions: [],
      accountResolutions: [{
        accountId, ownerUserId: auditorId, teamId: null, baseRevision: 1,
      }],
      currentOwnerBaseRevision: 1,
      targetUserBaseRevision: 1,
      allowManualCleanup: false,
    })
    if (preview.kind !== 'preview') throw new Error('expected legacy preview')
    const installationId = randomUUID()
    await db.insertInto('desktop_installations').values({
      id: installationId,
      credential_sha256: '0'.repeat(64),
      client_version: 'late-legacy-client',
      capabilities: JSON.stringify([]),
      last_seen_at: NOW,
      revoked_at: null,
    }).execute()
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId, account_id: accountId,
      owner_user_id: owner.userId, last_seen_at: NOW,
    }).execute()

    await expect(service.execute(owner, {
      operationToken: preview.preview.operationToken,
      currentPassword: CURRENT_PASSWORD,
    })).rejects.toMatchObject({ code: 'CLIENT_UPDATE_REQUIRED' })
    expect(await db.selectFrom('desktop_cleanup_tasks').select('id').execute()).toEqual([])
    expect(await db.selectFrom('users').select('id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null).execute())
      .toEqual([{ id: owner.userId }])
  })
})
