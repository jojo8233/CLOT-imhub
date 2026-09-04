import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import { OrganizationReadRepo } from '../../organization-admin/read-repo.js'
import { UserAdminService } from '../../organization-admin/user-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'admin-users-route-test-secret-32-characters'
process.env.ORGANIZATION_ADMIN_WRITES_ENABLED = 'false'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const temporaryPassword = 'route-temporary-password-sentinel'
const userService = new UserAdminService(db, {
  now: () => new Date('2026-09-05T00:00:00.000Z'),
  generateTemporaryPassword: () => temporaryPassword,
})
const readRepo = new OrganizationReadRepo(db)
let app: FastifyInstance
let writesOffApp: FastifyInstance
let hub: InstanceType<typeof import('../ws.js').WsHub>
const ids = new Map<Role, string>()
const tokens = new Map<Role, string>()

async function createUser(role: Role, label: string, disabled = false): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${label}-${randomUUID()}@example.test`,
    display_name: `Synthetic ${label}`,
    role,
    password_hash: 'x',
    disabled_at: disabled ? new Date('2026-09-01T00:00:00.000Z') : null,
  }).returning('id').executeTakeFirstOrThrow()).id
}

function auth(role: Role) {
  return { authorization: `Bearer ${tokens.get(role) ?? ''}` }
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { WsHub } = await import('../ws.js')
  hub = new WsHub()
  const deps = {
    adapters: {} as never,
    gateway: {} as never,
    organizationAdmin: { readRepo, userService, writesEnabled: true },
  }
  app = await buildServer(deps, hub)
  writesOffApp = await buildServer({
    ...deps,
    organizationAdmin: { readRepo, userService, writesEnabled: false },
  }, new WsHub())
})

beforeEach(async () => {
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
    const id = await createUser(role, role)
    ids.set(role, id)
    tokens.set(role, await signSession({ userId: id, sessionVersion: 1 }, process.env.JWT_SECRET ?? ''))
  }
  vi.restoreAllMocks()
})

afterAll(async () => {
  await app.close()
  await writesOffApp.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('admin user route guard', () => {
  it.each(['manager', 'auditor', 'agent'] as const)('%s 不能查询或写入员工管理', async role => {
    expect((await app.inject({
      method: 'POST', url: '/api/admin/users/search', headers: auth(role), payload: {},
    })).statusCode).toBe(403)
    expect((await app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth(role),
      payload: { email: 'blocked@example.test', displayName: 'Blocked', role: 'agent', teamId: null },
    })).statusCode).toBe(403)
  })

  it('写开关关闭时 owner 仍可查询，但写入在目标读取前返回 503', async () => {
    const search = await writesOffApp.inject({
      method: 'POST', url: '/api/admin/users/search', headers: auth('owner'), payload: {},
    })
    expect(search.statusCode).toBe(200)
    const update = await writesOffApp.inject({
      method: 'PATCH', url: `/api/admin/users/${randomUUID()}`, headers: auth('owner'),
      payload: { displayName: 'Never read target', baseRevision: 1 },
    })
    expect(update.statusCode).toBe(503)
    expect(update.json()).toEqual({
      error: 'organization admin writes disabled', code: 'ADMIN_WRITES_DISABLED',
    })
  })
})

describe('admin user routes', () => {
  it('JSON body 搜索返回稳定分页，查询词不进入 URL', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/admin/users/search', headers: auth('owner'),
      payload: { q: 'Synthetic agent', limit: 1 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      items: [{ id: ids.get('agent'), role: 'agent' }], nextCursor: null,
    })
  })

  it('创建只在成功响应展示临时密码，并禁止缓存或日志泄漏', async () => {
    const writes: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk))
      return true
    })
    const response = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth('owner'),
      payload: {
        email: 'new.route.agent@example.test', displayName: 'New Route Agent',
        role: 'agent', teamId: null,
      },
    })
    stdout.mockRestore()

    expect(response.statusCode).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      user: { email: 'new.route.agent@example.test', role: 'agent' },
      temporaryPassword,
      temporaryPasswordExpiresAt: '2026-09-06T00:00:00.000Z',
    })
    expect(writes.join('')).not.toContain(temporaryPassword)
  })

  it('重复邮箱与 revision 冲突返回稳定错误结构', async () => {
    const duplicate = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth('owner'),
      payload: {
        email: 'duplicate.route@example.test', displayName: 'First',
        role: 'auditor', teamId: null,
      },
    })
    expect(duplicate.statusCode).toBe(201)
    const duplicateAgain = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth('owner'),
      payload: {
        email: 'DUPLICATE.route@example.test', displayName: 'Second',
        role: 'auditor', teamId: null,
      },
    })
    expect(duplicateAgain.statusCode).toBe(409)
    expect(duplicateAgain.json()).toMatchObject({ code: 'ORGANIZATION_INVARIANT' })

    const conflict = await app.inject({
      method: 'PATCH', url: `/api/admin/users/${ids.get('agent')}`, headers: auth('owner'),
      payload: { displayName: 'Conflict', baseRevision: 2 },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({
      code: 'REVISION_CONFLICT', current: { id: ids.get('agent'), revision: 1 },
    })
  })

  it('重置和重新启用密码后撤销目标用户会话', async () => {
    const revoke = vi.spyOn(hub, 'revokeUser')
    const reset = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${ids.get('agent')}/reset-password`,
      headers: auth('owner'),
      payload: { baseRevision: 1 },
    })
    expect(reset.statusCode).toBe(200)
    expect(reset.headers['cache-control']).toBe('no-store')
    expect(revoke).toHaveBeenCalledWith(ids.get('agent'))

    const disabledId = await createUser('agent', 'disabled-route', true)
    const enable = await app.inject({
      method: 'POST', url: `/api/admin/users/${disabledId}/enable`, headers: auth('owner'),
      payload: { baseRevision: 1 },
    })
    expect(enable.statusCode).toBe(200)
    expect(revoke).toHaveBeenCalledWith(disabledId)
  })

  it('普通创建 owner 和多余字段均在路由边界拒绝', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth('owner'),
      payload: {
        email: 'forbidden-owner@example.test', displayName: 'Forbidden Owner',
        role: 'owner', teamId: null,
      },
    })
    expect(response.statusCode).toBe(400)
    expect((await app.inject({
      method: 'POST', url: '/api/admin/users/search', headers: auth('owner'),
      payload: { q: 'x', unknown: true },
    })).statusCode).toBe(400)
  })
})
