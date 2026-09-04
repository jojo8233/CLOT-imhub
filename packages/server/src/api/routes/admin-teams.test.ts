import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import { DeviceRepo } from '../../organization-admin/device-repo.js'
import { DeviceService } from '../../organization-admin/device-service.js'
import { AdminOperationTokenService } from '../../organization-admin/operation-token.js'
import { OrganizationReadRepo } from '../../organization-admin/read-repo.js'
import { TeamAdminService } from '../../organization-admin/team-service.js'
import { UserAdminService } from '../../organization-admin/user-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'admin-teams-route-test-secret-32-characters'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const readRepo = new OrganizationReadRepo(db)
const deviceService = new DeviceService(new DeviceRepo(db))
const operationTokens = new AdminOperationTokenService(process.env.JWT_SECRET)
const teamService = new TeamAdminService(db, deviceService, operationTokens)
const userService = new UserAdminService(db)
let app: FastifyInstance
const ids = new Map<Role, string>()
const tokens = new Map<Role, string>()
let teamId: string

async function createUser(role: Role): Promise<string> {
  return (await db.insertInto('users').values({
    email: `${role}-${randomUUID()}@example.test`, display_name: `Synthetic ${role}`,
    role, password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
}

function auth(role: Role) {
  return { authorization: `Bearer ${tokens.get(role) ?? ''}` }
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer({
    adapters: {} as never,
    gateway: {} as never,
    organizationAdmin: { readRepo, userService, teamService, writesEnabled: true },
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
    const id = await createUser(role)
    ids.set(role, id)
    tokens.set(role, await signSession({ userId: id, sessionVersion: 1 }, process.env.JWT_SECRET ?? ''))
  }
  teamId = (await db.insertInto('teams').values({ name: 'Synthetic route team' })
    .returning('id').executeTakeFirstOrThrow()).id
  await db.insertInto('team_members').values({
    team_id: teamId, user_id: ids.get('manager') ?? '', is_lead: true,
  }).execute()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('admin team routes', () => {
  it('非 owner 在读取目标前返回 403，owner 可用 JSON body 搜索', async () => {
    expect((await app.inject({
      method: 'POST', url: '/api/admin/teams/search', headers: auth('manager'), payload: {},
    })).statusCode).toBe(403)
    const result = await app.inject({
      method: 'POST', url: '/api/admin/teams/search', headers: auth('owner'),
      payload: { q: 'route team' },
    })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ items: [{ id: teamId, managerUserId: ids.get('manager') }] })
  })

  it('创建、改名和 agent 调组使用 revision', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/teams', headers: auth('owner'),
      payload: { name: 'New route team', managerUserId: ids.get('manager') },
    })
    expect(created.statusCode).toBe(201)
    const createdId = created.json<{ team: { id: string } }>().team.id
    const renamed = await app.inject({
      method: 'PATCH', url: `/api/admin/teams/${createdId}`, headers: auth('owner'),
      payload: { name: 'Renamed route team', baseRevision: 1 },
    })
    expect(renamed.statusCode).toBe(200)

    const moved = await app.inject({
      method: 'POST', url: `/api/admin/agents/${ids.get('agent')}/change-team`,
      headers: auth('owner'), payload: { teamId: createdId, baseRevision: 1 },
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json()).toMatchObject({ user: { teamIds: [createdId], revision: 2 } })
  })

  it('换主管与归档都必须 preview 后 execute', async () => {
    const nextManagerId = await createUser('manager')
    const preview = await app.inject({
      method: 'POST', url: `/api/admin/teams/${teamId}/change-manager`,
      headers: auth('owner'),
      payload: { phase: 'preview', baseRevision: 1, input: { managerUserId: nextManagerId } },
    })
    expect(preview.statusCode).toBe(200)
    const operationToken = preview.json<{ preview: { operationToken: string } }>()
      .preview.operationToken
    const execute = await app.inject({
      method: 'POST', url: `/api/admin/teams/${teamId}/change-manager`,
      headers: auth('owner'), payload: { phase: 'execute', operationToken },
    })
    expect(execute.statusCode).toBe(200)
    expect(execute.json()).toMatchObject({ team: { managerUserId: nextManagerId, revision: 2 } })

    const archivePreview = await app.inject({
      method: 'POST', url: `/api/admin/teams/${teamId}/archive`,
      headers: auth('owner'), payload: { phase: 'preview', baseRevision: 2, input: {} },
    })
    expect(archivePreview.statusCode).toBe(200)
    const archiveToken = archivePreview.json<{ preview: { operationToken: string } }>()
      .preview.operationToken
    expect((await app.inject({
      method: 'POST', url: `/api/admin/teams/${teamId}/archive`, headers: auth('owner'),
      payload: { phase: 'execute', operationToken: archiveToken },
    })).statusCode).toBe(200)
  })
})
