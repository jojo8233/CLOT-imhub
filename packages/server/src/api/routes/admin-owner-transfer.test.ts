import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import { hashPassword } from '../../auth/password.js'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import { DeviceRepo } from '../../organization-admin/device-repo.js'
import { DeviceService } from '../../organization-admin/device-service.js'
import { AdminOperationTokenService } from '../../organization-admin/operation-token.js'
import { OwnerTransferService } from '../../organization-admin/owner-transfer-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'owner-transfer-route-secret-32-characters'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const CURRENT_PASSWORD = 'synthetic-owner-route-password'
const deviceService = new DeviceService(new DeviceRepo(db))
const service = new OwnerTransferService(
  db,
  deviceService,
  new AdminOperationTokenService(process.env.JWT_SECRET ?? ''),
)
let app: FastifyInstance
let hub: import('../ws.js').WsHub
const ids = new Map<Role, string>()
const tokens = new Map<Role, string>()

async function createUser(role: Role): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${role}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${role}`,
    role,
    password_hash: role === 'owner' ? await hashPassword(CURRENT_PASSWORD) : 'x',
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
    organizationAdmin: { ownerTransferService: service, writesEnabled: true },
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
    tokens.set(role, await signSession(
      { userId: id, sessionVersion: 1 },
      process.env.JWT_SECRET ?? '',
    ))
  }
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('admin owner transfer routes', () => {
  it('非 owner 在解析目标前就被拒绝', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/admin/owner-transfer/preview', headers: auth('manager'),
      payload: {
        targetUserId: randomUUID(), currentOwnerNextRole: 'auditor',
        currentOwnerTeamId: null, teamResolutions: [], accountResolutions: [],
        currentOwnerBaseRevision: 1, targetUserBaseRevision: 1,
        allowManualCleanup: false,
      },
    })
    expect(response.statusCode).toBe(403)
  })

  it('密码错误只返回通用 403，不发布任何事件', async () => {
    const preview = await transferPreview()
    const operationToken = preview.json<{ preview: { operationToken: string } }>()
      .preview.operationToken
    const publish = vi.spyOn(hub, 'publishTo')
    const revoke = vi.spyOn(hub, 'revokeUser')
    const response = await app.inject({
      method: 'POST', url: '/api/admin/owner-transfer', headers: auth('owner'),
      payload: { operationToken, currentPassword: 'wrong-password-value' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'forbidden' })
    expect(publish).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('成功提交后才撤销双方会话，并保持唯一 owner', async () => {
    const preview = await transferPreview()
    const operationToken = preview.json<{ preview: { operationToken: string } }>()
      .preview.operationToken
    const publish = vi.spyOn(hub, 'publishTo')
    const revoke = vi.spyOn(hub, 'revokeUser')
    const response = await app.inject({
      method: 'POST', url: '/api/admin/owner-transfer', headers: auth('owner'),
      payload: { operationToken, currentPassword: CURRENT_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      currentOwner: { id: ids.get('owner'), role: 'auditor' },
      newOwner: { id: ids.get('auditor'), role: 'owner' },
    })
    expect(revoke).toHaveBeenCalledWith(ids.get('owner'))
    expect(revoke).toHaveBeenCalledWith(ids.get('auditor'))
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(revoke.mock.invocationCallOrder[0] ?? 0)
    expect(await db.selectFrom('users').select('id')
      .where('role', '=', 'owner').where('disabled_at', 'is', null).execute())
      .toEqual([{ id: ids.get('auditor') }])
  })
})

function transferPreview() {
  return app.inject({
    method: 'POST', url: '/api/admin/owner-transfer/preview', headers: auth('owner'),
    payload: {
      targetUserId: ids.get('auditor'), currentOwnerNextRole: 'auditor',
      currentOwnerTeamId: null, teamResolutions: [], accountResolutions: [],
      currentOwnerBaseRevision: 1, targetUserBaseRevision: 1,
      allowManualCleanup: false,
    },
  })
}
