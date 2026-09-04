import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Actor, Role } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T12:00:00.000Z')
const service = new DeviceService(new DeviceRepo(db), () => new Date(NOW))
const credential = 'synthetic-device-credential-that-is-long-enough'

const ownerActor: Actor = { userId: '', role: 'owner', leadTeamIds: [] }
const agentActor: Actor = { userId: '', role: 'agent', leadTeamIds: [] }
const otherActor: Actor = { userId: '', role: 'agent', leadTeamIds: [] }

async function createUser(role: Role): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${randomUUID()}@example.test`,
    display_name: 'Synthetic device user',
    role,
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function createAccount(
  ownerUserId: string,
  connectionMode: 'adapter' | 'native_desktop' | 'web_shell' | 'cloud_api',
): Promise<string> {
  const platform = connectionMode === 'native_desktop'
    ? 'signal'
    : connectionMode === 'web_shell' || connectionMode === 'cloud_api'
      ? 'whatsapp'
      : 'telegram'
  return (await db.insertInto('accounts').values({
    platform,
    owner_user_id: ownerUserId,
    team_id: null,
    display_name: 'Synthetic mounted account',
    status: 'connected',
    connection_mode: connectionMode,
  }).returning('id').executeTakeFirstOrThrow()).id
}

async function register(installationId: string, actor: Actor = agentActor) {
  return service.register(actor, {
    installationId,
    credential,
    clientVersion: '0.0.0-test',
    capabilities: ['partition_cleanup_v1'],
  })
}

beforeEach(async () => {
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()

  ownerActor.userId = await createUser('owner')
  agentActor.userId = await createUser('agent')
  otherActor.userId = await createUser('agent')
})

afterAll(async () => db.destroy())

describe('DeviceService registration', () => {
  it('任何有效公司用户可复用同一设备凭证，错误凭证被拒绝且数据库无明文', async () => {
    const installationId = randomUUID()
    expect(await register(installationId)).toEqual({ registered: true })
    expect(await register(installationId, otherActor)).toEqual({ registered: true })

    await expect(service.register(otherActor, {
      installationId,
      credential: 'wrong-device-credential-that-is-long-enough',
      clientVersion: '0.0.1-test',
      capabilities: ['partition_cleanup_v1'],
    })).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_INVALID' })

    const row = await db.selectFrom('desktop_installations')
      .select('credential_sha256')
      .where('id', '=', installationId)
      .executeTakeFirstOrThrow()
    expect(row.credential_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(row.credential_sha256).not.toContain(credential)
  })
})

describe('DeviceService mount synchronization', () => {
  it('只接受当前员工拥有的账号挂载', async () => {
    const installationId = randomUUID()
    await register(installationId)
    const ownedAccountId = await createAccount(agentActor.userId, 'web_shell')
    const foreignAccountId = await createAccount(otherActor.userId, 'web_shell')

    expect(await service.syncMounts(agentActor, {
      installationId,
      credential,
      accountIds: [ownedAccountId],
    })).toEqual({
      readyAccountIds: [ownedAccountId],
      blockedAccountIds: [],
      manualRequiredAccountIds: [],
    })
    await expect(service.syncMounts(agentActor, {
      installationId,
      credential,
      accountIds: [foreignAccountId],
    })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_OWNED' })
  })

  it.each(['automatic', 'manual_required'] as const)(
    '同设备存在 %s 待办时拒绝重新挂载',
    async mode => {
      const installationId = randomUUID()
      await register(installationId)
      const accountId = await createAccount(agentActor.userId, 'web_shell')
      await db.insertInto('desktop_cleanup_tasks').values({
        installation_id: installationId,
        account_id: accountId,
        mode,
        reason: mode === 'automatic' ? 'ownership_changed' : 'unsupported_client_override',
        state: 'pending',
      }).execute()

      await expect(service.syncMounts(agentActor, {
        installationId,
        credential,
        accountIds: [accountId],
      })).rejects.toMatchObject({ code: 'DEVICE_CLEANUP_PENDING' })
    },
  )
})

describe('DeviceService cleanup lifecycle', () => {
  it('识别在线但不支持分区清理的安装，并允许显式改成人工待办', async () => {
    const installationId = randomUUID()
    await service.register(agentActor, {
      installationId,
      credential,
      clientVersion: 'legacy-test-client',
      capabilities: [],
    })
    const accountId = await createAccount(agentActor.userId, 'web_shell')
    await service.syncMounts(agentActor, { installationId, credential, accountIds: [accountId] })

    expect(await service.enqueueOwnershipChange({
      accountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'web_shell',
    })).toEqual({
      pendingAutomatic: 1,
      manualRequired: 0,
      unsupportedOnlineInstallations: 1,
    })

    await db.deleteFrom('desktop_cleanup_tasks').where('account_id', '=', accountId).execute()
    expect(await service.enqueueOwnershipChange({
      accountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'web_shell',
    }, { allowManualCleanup: true })).toEqual({
      pendingAutomatic: 0,
      manualRequired: 1,
      unsupportedOnlineInstallations: 1,
    })
    expect(await db.selectFrom('desktop_cleanup_tasks').select(['mode', 'reason'])
      .where('account_id', '=', accountId).executeTakeFirstOrThrow()).toEqual({
      mode: 'manual_required',
      reason: 'unsupported_client_override',
    })
  })

  it('Cloud API 和没有本地挂载的服务端 adapter 不建立清理待办', async () => {
    const cloudAccountId = await createAccount(agentActor.userId, 'cloud_api')
    const adapterAccountId = await createAccount(agentActor.userId, 'adapter')

    expect(await service.enqueueOwnershipChange({
      accountId: cloudAccountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'cloud_api',
    })).toEqual({
      pendingAutomatic: 0,
      manualRequired: 0,
      unsupportedOnlineInstallations: 0,
    })
    expect(await service.enqueueOwnershipChange({
      accountId: adapterAccountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'adapter',
    })).toEqual({
      pendingAutomatic: 0,
      manualRequired: 0,
      unsupportedOnlineInstallations: 0,
    })
    expect(await db.selectFrom('desktop_cleanup_tasks').select('id').execute()).toEqual([])
  })

  it('自动清理完成后删除旧挂载、不能再次领取，并清除 30 天前完成记录', async () => {
    const installationId = randomUUID()
    await register(installationId)
    const accountId = await createAccount(agentActor.userId, 'web_shell')
    await service.syncMounts(agentActor, { installationId, credential, accountIds: [accountId] })
    const enqueue = await service.enqueueOwnershipChange({
      accountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'web_shell',
    })
    expect(enqueue).toEqual({
      pendingAutomatic: 1,
      manualRequired: 0,
      unsupportedOnlineInstallations: 0,
    })

    const claimed = await service.claimAutomaticTasks(otherActor, { installationId, credential })
    expect(claimed.tasks).toHaveLength(1)
    await service.completeAutomaticTask(otherActor, {
      installationId,
      credential,
      taskId: claimed.tasks[0]?.id ?? '',
    })
    expect((await service.claimAutomaticTasks(otherActor, { installationId, credential })).tasks)
      .toEqual([])
    expect(await db.selectFrom('account_device_mounts').select('account_id')
      .where('installation_id', '=', installationId).execute()).toEqual([])

    await db.updateTable('desktop_cleanup_tasks').set({
      completed_at: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000),
    }).where('installation_id', '=', installationId).execute()
    await service.claimAutomaticTasks(otherActor, { installationId, credential })
    expect(await db.selectFrom('desktop_cleanup_tasks').select('id')
      .where('installation_id', '=', installationId).execute()).toEqual([])
  })

  it('Signal 始终产生人工待办、不会进入自动领取，确认后才移除旧挂载', async () => {
    const installationId = randomUUID()
    await register(installationId)
    const accountId = await createAccount(agentActor.userId, 'native_desktop')
    await service.syncMounts(agentActor, { installationId, credential, accountIds: [accountId] })

    expect(await service.enqueueOwnershipChange({
      accountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'native_desktop',
    })).toEqual({
      pendingAutomatic: 0,
      manualRequired: 1,
      unsupportedOnlineInstallations: 0,
    })
    expect((await service.claimAutomaticTasks(otherActor, { installationId, credential })).tasks)
      .toEqual([])

    const task = await db.selectFrom('desktop_cleanup_tasks').select('id')
      .where('account_id', '=', accountId).executeTakeFirstOrThrow()
    await service.confirmManualTask(ownerActor, task.id)
    expect(await db.selectFrom('account_device_mounts').select('account_id')
      .where('installation_id', '=', installationId).execute()).toEqual([])
  })

  it('没有已知挂载的 Signal 仍建立账号级人工义务', async () => {
    const accountId = await createAccount(agentActor.userId, 'native_desktop')

    expect(await service.enqueueOwnershipChange({
      accountId,
      previousOwnerUserId: agentActor.userId,
      connectionMode: 'native_desktop',
    })).toMatchObject({ manualRequired: 1 })
    expect(await db.selectFrom('desktop_cleanup_tasks')
      .select(['installation_id', 'mode', 'reason'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow()).toEqual({
      installation_id: null,
      mode: 'manual_required',
      reason: 'signal_official_unlink',
    })
  })
})
