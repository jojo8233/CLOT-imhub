import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { AccountConnectionMode, Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { AccountAdminService } from './account-service.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import { AdminOperationTokenService } from './operation-token.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T12:00:00.000Z')
const deviceService = new DeviceService(new DeviceRepo(db), () => new Date(NOW))
const service = new AccountAdminService(
  db,
  deviceService,
  new AdminOperationTokenService('account-service-operation-secret-32-chars', () => new Date(NOW)),
)
const owner: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
let managerId: string
let noTeamManagerId: string
let agentId: string
let teamlessAgentId: string
let auditorId: string
let disabledAgentId: string
let teamId: string
let otherTeamId: string

async function createUser(role: Role, label: string, disabled = false): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: 'x',
    disabled_at: disabled ? NOW : null,
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function createAccount(
  ownerUserId: string,
  team: string | null,
  mode: AccountConnectionMode = 'web_shell',
): Promise<string> {
  const platform = mode === 'native_desktop'
    ? 'signal'
    : mode === 'web_shell' || mode === 'cloud_api'
      ? 'whatsapp'
      : 'telegram'
  return (await db.insertInto('accounts').values({
    platform,
    owner_user_id: ownerUserId,
    team_id: team,
    display_name: `Synthetic ${mode}`,
    status: 'connected',
    connection_mode: mode,
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function previewAndAssign(input: {
  accountId: string
  ownerUserId: string
  teamId: string | null
  allowManualCleanup?: boolean
}) {
  const preview = await service.previewAssignment(owner, {
    ...input,
    allowManualCleanup: input.allowManualCleanup ?? false,
    baseRevision: 1,
  })
  if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`)
  return service.assign(owner, {
    accountId: input.accountId,
    operationToken: preview.preview.operationToken,
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

  owner.userId = await createUser('owner', 'owner')
  managerId = await createUser('manager', 'manager')
  noTeamManagerId = await createUser('manager', 'manager-no-team')
  agentId = await createUser('agent', 'agent')
  teamlessAgentId = await createUser('agent', 'agent-no-team')
  auditorId = await createUser('auditor', 'auditor')
  disabledAgentId = await createUser('agent', 'disabled-agent', true)
  teamId = (await db.insertInto('teams').values({ name: 'Synthetic primary team' })
    .returning('id').executeTakeFirstOrThrow()).id
  otherTeamId = (await db.insertInto('teams').values({ name: 'Synthetic other team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: managerId, is_lead: true },
    { team_id: teamId, user_id: agentId, is_lead: false },
  ]).execute()
})

afterAll(async () => db.destroy())

describe('AccountAdminService assignment matrix', () => {
  it('agent 的团队由 membership 强制确定，未分组 agent 强制为 null', async () => {
    const first = await createAccount(owner.userId, otherTeamId, 'adapter')
    expect(await previewAndAssign({ accountId: first, ownerUserId: agentId, teamId: null }))
      .toMatchObject({
        kind: 'assigned',
        account: { ownerUserId: agentId, teamId, revision: 2 },
      })

    const second = await createAccount(owner.userId, teamId, 'cloud_api')
    expect(await previewAndAssign({
      accountId: second, ownerUserId: teamlessAgentId, teamId: teamId,
    })).toMatchObject({
      kind: 'assigned',
      account: { ownerUserId: teamlessAgentId, teamId: null, revision: 2 },
    })
  })

  it('manager 必须明确选择自己负责的启用团队', async () => {
    const accountId = await createAccount(owner.userId, null)
    expect(await service.previewAssignment(owner, {
      accountId, ownerUserId: managerId, teamId: null,
      allowManualCleanup: false, baseRevision: 1,
    })).toMatchObject({ kind: 'blocked' })
    expect(await service.previewAssignment(owner, {
      accountId, ownerUserId: noTeamManagerId, teamId,
      allowManualCleanup: false, baseRevision: 1,
    })).toMatchObject({ kind: 'blocked' })
    expect(await previewAndAssign({ accountId, ownerUserId: managerId, teamId }))
      .toMatchObject({ kind: 'assigned', account: { ownerUserId: managerId, teamId } })
  })

  it('owner 可选任意启用团队或未分组，auditor 和停用员工始终拒绝', async () => {
    const accountId = await createAccount(agentId, teamId, 'cloud_api')
    expect(await previewAndAssign({ accountId, ownerUserId: owner.userId, teamId: otherTeamId }))
      .toMatchObject({ kind: 'assigned', account: { ownerUserId: owner.userId, teamId: otherTeamId } })

    const blockedId = await createAccount(owner.userId, null)
    for (const ownerUserId of [auditorId, disabledAgentId]) {
      expect(await service.previewAssignment(owner, {
        accountId: blockedId, ownerUserId, teamId: null,
        allowManualCleanup: false, baseRevision: 1,
      })).toMatchObject({ kind: 'blocked' })
    }
  })

  it('过期 account revision 返回最新快照，归档团队不可选', async () => {
    const accountId = await createAccount(owner.userId, null)
    expect(await service.previewAssignment(owner, {
      accountId, ownerUserId: owner.userId, teamId: null,
      allowManualCleanup: false, baseRevision: 9,
    })).toMatchObject({ kind: 'conflict', current: { id: accountId, revision: 1 } })
    await db.updateTable('teams').set({ disabled_at: NOW }).where('id', '=', otherTeamId).execute()
    expect(await service.previewAssignment(owner, {
      accountId, ownerUserId: owner.userId, teamId: otherTeamId,
      allowManualCleanup: false, baseRevision: 1,
    })).toMatchObject({ kind: 'blocked' })
  })
})

describe('AccountAdminService cleanup policy', () => {
  it('Web 分区生成自动清理，Signal 只生成人工官方解除待办', async () => {
    const installationId = randomUUID()
    await db.insertInto('desktop_installations').values({
      id: installationId,
      credential_sha256: '0'.repeat(64),
      client_version: 'cleanup-capable-client',
      capabilities: JSON.stringify(['partition_cleanup_v1']),
      last_seen_at: NOW,
      revoked_at: null,
    }).execute()
    const webId = await createAccount(owner.userId, otherTeamId)
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId, account_id: webId,
      owner_user_id: owner.userId, last_seen_at: NOW,
    }).execute()
    const webPreview = await service.previewAssignment(owner, {
      accountId: webId, ownerUserId: agentId, teamId: null,
      allowManualCleanup: false, baseRevision: 1,
    })
    expect(webPreview).toMatchObject({
      kind: 'preview', preview: { summary: { automaticCleanupTasks: 1, manualCleanupTasks: 0 } },
    })
    if (webPreview.kind !== 'preview') throw new Error('expected web preview')
    await service.assign(owner, { accountId: webId, operationToken: webPreview.preview.operationToken })

    const signalId = await createAccount(owner.userId, otherTeamId, 'native_desktop')
    const signalPreview = await service.previewAssignment(owner, {
      accountId: signalId, ownerUserId: agentId, teamId: null,
      allowManualCleanup: false, baseRevision: 1,
    })
    expect(signalPreview).toMatchObject({
      kind: 'preview', preview: { summary: { automaticCleanupTasks: 0, manualCleanupTasks: 1 } },
    })
    if (signalPreview.kind !== 'preview') throw new Error('expected signal preview')
    await service.assign(owner, {
      accountId: signalId, operationToken: signalPreview.preview.operationToken,
    })
    expect(await db.selectFrom('desktop_cleanup_tasks').select(['account_id', 'mode', 'reason'])
      .orderBy('account_id').execute()).toEqual(expect.arrayContaining([
      { account_id: webId, mode: 'automatic', reason: 'ownership_changed' },
      { account_id: signalId, mode: 'manual_required', reason: 'signal_official_unlink' },
    ]))
  })

  it('在线旧版 Web 客户端默认阻断，明确允许后转为人工待办', async () => {
    const installationId = randomUUID()
    await db.insertInto('desktop_installations').values({
      id: installationId,
      credential_sha256: '0'.repeat(64),
      client_version: 'legacy-client',
      capabilities: JSON.stringify([]),
      last_seen_at: NOW,
      revoked_at: null,
    }).execute()
    const accountId = await createAccount(owner.userId, null)
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId, account_id: accountId,
      owner_user_id: owner.userId, last_seen_at: NOW,
    }).execute()

    expect(await service.previewAssignment(owner, {
      accountId, ownerUserId: agentId, teamId: null,
      allowManualCleanup: false, baseRevision: 1,
    })).toMatchObject({ kind: 'blocked', blockers: [{ code: 'CLIENT_UPDATE_REQUIRED', count: 1 }] })

    const assigned = await previewAndAssign({
      accountId, ownerUserId: agentId, teamId: null, allowManualCleanup: true,
    })
    expect(assigned).toMatchObject({ kind: 'assigned' })
    expect(await db.selectFrom('desktop_cleanup_tasks').select(['mode', 'reason'])
      .where('account_id', '=', accountId).executeTakeFirstOrThrow()).toEqual({
      mode: 'manual_required', reason: 'unsupported_client_override',
    })
  })
})
