import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import { AccountAdminService } from '../../organization-admin/account-service.js'
import { DeviceRepo } from '../../organization-admin/device-repo.js'
import { DeviceService } from '../../organization-admin/device-service.js'
import { AdminOperationTokenService } from '../../organization-admin/operation-token.js'
import { OrganizationReadRepo } from '../../organization-admin/read-repo.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'admin-accounts-route-secret-32-characters'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-05T12:00:00.000Z')
const readRepo = new OrganizationReadRepo(db)
const deviceService = new DeviceService(new DeviceRepo(db), () => new Date(NOW))
const operationTokens = new AdminOperationTokenService(
  process.env.JWT_SECRET,
  () => new Date(NOW),
)
const accountService = new AccountAdminService(db, deviceService, operationTokens)
let app: FastifyInstance
let hub: import('../ws.js').WsHub
const ids = new Map<Role, string>()
const tokens = new Map<Role, string>()
let teamId: string

async function createUser(role: Role): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${role}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${role}`,
    role,
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
}

function auth(role: Role) {
  return { authorization: `Bearer ${tokens.get(role) ?? ''}` }
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { WsHub } = await import('../ws.js')
  hub = new WsHub()
  app = await buildServer({
    adapters: {} as never,
    gateway: {} as never,
    organizationAdmin: { readRepo, accountService, writesEnabled: true },
  }, hub, { deviceService })
})

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()
  ids.clear()
  tokens.clear()
  const { signSession } = await import('../../auth/session.js')
  for (const role of ['owner', 'manager', 'auditor', 'agent'] as const) {
    const id = await createUser(role)
    ids.set(role, id)
    tokens.set(role, await signSession({ userId: id, sessionVersion: 1 }, process.env.JWT_SECRET ?? ''))
  }
  teamId = (await db.insertInto('teams').values({ name: 'Synthetic account route team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: ids.get('manager') ?? '', is_lead: true },
    { team_id: teamId, user_id: ids.get('agent') ?? '', is_lead: false },
  ]).execute()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('admin account routes', () => {
  it('非 owner 在查询前返回 403，owner 可按平台与清理状态搜索', async () => {
    const accountId = (await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: ids.get('agent') ?? '', team_id: teamId,
      display_name: 'Searchable Signal', status: 'connected', connection_mode: 'native_desktop',
    }).returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('desktop_cleanup_tasks').values({
      installation_id: null, account_id: accountId, mode: 'manual_required',
      reason: 'signal_official_unlink', state: 'pending',
    }).execute()
    expect((await app.inject({
      method: 'POST', url: '/api/admin/accounts/search', headers: auth('manager'), payload: {},
    })).statusCode).toBe(403)
    const result = await app.inject({
      method: 'POST', url: '/api/admin/accounts/search', headers: auth('owner'),
      payload: { platform: 'signal', cleanupState: 'manual_required' },
    })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({
      items: [{ id: accountId, cleanupState: 'manual_required', pendingCleanupCount: 1 }],
    })
  })

  it('账号转移必须 preview/execute，且只在提交后发布组织与清理事件', async () => {
    const ownerId = ids.get('owner') ?? ''
    const agentId = ids.get('agent') ?? ''
    const installationId = randomUUID()
    await db.insertInto('desktop_installations').values({
      id: installationId,
      credential_sha256: '0'.repeat(64),
      client_version: 'route-cleanup-client',
      capabilities: JSON.stringify(['partition_cleanup_v1']),
      last_seen_at: NOW,
      revoked_at: null,
    }).execute()
    const accountId = (await db.insertInto('accounts').values({
      platform: 'whatsapp', owner_user_id: ownerId, team_id: null,
      display_name: 'Transfer route account', status: 'connected', connection_mode: 'web_shell',
    }).returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId, account_id: accountId,
      owner_user_id: ownerId, last_seen_at: NOW,
    }).execute()
    const publish = vi.spyOn(hub, 'publishTo')
    const revoke = vi.spyOn(hub, 'revokeUser')

    const preview = await app.inject({
      method: 'POST', url: `/api/admin/accounts/${accountId}/assignment-preview`,
      headers: auth('owner'), payload: {
        ownerUserId: agentId, teamId, allowManualCleanup: false, baseRevision: 1,
      },
    })
    expect(preview.statusCode).toBe(200)
    expect(publish).not.toHaveBeenCalled()
    const operationToken = preview.json<{ preview: { operationToken: string } }>()
      .preview.operationToken
    const execute = await app.inject({
      method: 'POST', url: `/api/admin/accounts/${accountId}/assign`,
      headers: auth('owner'), payload: { operationToken },
    })
    expect(execute.statusCode).toBe(200)
    expect(execute.json()).toMatchObject({ account: { ownerUserId: agentId, teamId } })
    expect(publish).toHaveBeenCalledWith(ownerId, { type: 'organization_changed' })
    expect(publish).toHaveBeenCalledWith(agentId, { type: 'organization_changed' })
    expect(publish).toHaveBeenCalledWith(ownerId, { type: 'desktop_cleanup_requested' })
    expect(revoke).not.toHaveBeenCalled()
  })

  it('Signal 人工待办只能由 owner 确认，文案不声称本机已擦除', async () => {
    const accountId = (await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: ids.get('agent') ?? '', team_id: teamId,
      display_name: 'Manual Signal cleanup', status: 'connected',
      connection_mode: 'native_desktop',
    }).returning('id').executeTakeFirstOrThrow()).id
    const taskId = (await db.insertInto('desktop_cleanup_tasks').values({
      installation_id: null, account_id: accountId, mode: 'manual_required',
      reason: 'signal_official_unlink', state: 'pending',
    }).returning('id').executeTakeFirstOrThrow()).id
    expect((await app.inject({
      method: 'POST', url: `/api/admin/desktop/cleanup-tasks/${taskId}/confirm-manual`,
      headers: auth('manager'),
    })).statusCode).toBe(403)
    const confirmed = await app.inject({
      method: 'POST', url: `/api/admin/desktop/cleanup-tasks/${taskId}/confirm-manual`,
      headers: auth('owner'),
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json()).toEqual({ confirmed: true, message: '已确认官方解除' })
    expect(confirmed.body).not.toContain('擦除')
  })
})
