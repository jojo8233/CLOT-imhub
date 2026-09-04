import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'
import type { MessageRouteDeps } from './messages.js'
import { DeviceRepo } from '../../organization-admin/device-repo.js'
import { DeviceService } from '../../organization-admin/device-service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = 'desktop-installations-route-secret-32'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const credential = 'route-synthetic-device-credential-sentinel'
const installationId = randomUUID()
let userId: string
let token: string
let app: FastifyInstance

function actorRepo(): ActorRepo {
  return {
    findUser: async id => id === userId
      ? { id: userId, role: 'agent', disabled_at: null, session_version: 1 }
      : null,
    findMemberships: async () => [],
  }
}

function headers(deviceCredential = credential) {
  return {
    authorization: `Bearer ${token}`,
    'x-im-hub-installation-id': installationId,
    'x-im-hub-device-credential': deviceCredential,
  }
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { WsHub } = await import('../ws.js')
  const { signSession } = await import('../../auth/session.js')
  userId = (await db.insertInto('users').values({
    email: `${randomUUID()}@example.test`,
    display_name: 'Synthetic route user',
    role: 'agent',
    password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
  token = await signSession({ userId, sessionVersion: 1 }, process.env.JWT_SECRET ?? '')
  app = await buildServer({} as MessageRouteDeps, new WsHub(), {
    actorRepo: actorRepo(),
    deviceService: new DeviceService(new DeviceRepo(db)),
  })
})

beforeEach(async () => {
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('accounts').execute()
})

afterAll(async () => {
  await app.close()
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').where('id', '=', userId).execute()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('desktop installation routes', () => {
  it('登记、心跳和挂载同步均绑定普通会话与设备凭证', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/register',
      headers: headers(),
      payload: { clientVersion: '0.0.0-test', capabilities: ['partition_cleanup_v1'] },
    })
    expect(register.statusCode).toBe(200)

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/heartbeat',
      headers: headers(),
      payload: { clientVersion: '0.0.1-test', capabilities: ['partition_cleanup_v1'] },
    })
    expect(heartbeat.statusCode).toBe(200)

    const accountId = (await db.insertInto('accounts').values({
      platform: 'whatsapp',
      owner_user_id: userId,
      display_name: 'Synthetic route mount',
      status: 'connected',
      connection_mode: 'web_shell',
    }).returning('id').executeTakeFirstOrThrow()).id
    const sync = await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/sync-mounts',
      headers: headers(),
      payload: { accountIds: [accountId] },
    })
    expect(sync.statusCode).toBe(200)
    expect(sync.json()).toEqual({
      readyAccountIds: [accountId],
      blockedAccountIds: [],
      manualRequiredAccountIds: [],
    })
  })

  it('错误设备凭证返回稳定代码，响应和捕获日志都不出现凭证明文', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/register',
      headers: headers(),
      payload: { clientVersion: '0.0.0-test', capabilities: ['partition_cleanup_v1'] },
    })
    const writes: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      writes.push(String(chunk))
      return true
    })
    const wrongCredential = `${credential}-wrong`
    const response = await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/heartbeat',
      headers: headers(wrongCredential),
      payload: { clientVersion: '0.0.0-test', capabilities: [] },
    })
    stdout.mockRestore()

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'DEVICE_CREDENTIAL_INVALID' })
    expect(response.body).not.toContain(wrongCredential)
    expect(writes.join('')).not.toContain(wrongCredential)
  })

  it('只领取自动任务，完成后移除旧挂载', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/desktop/installations/register',
      headers: headers(),
      payload: { clientVersion: '0.0.0-test', capabilities: ['partition_cleanup_v1'] },
    })
    const accountId = (await db.insertInto('accounts').values({
      platform: 'whatsapp', owner_user_id: userId, display_name: 'Cleanup route account',
      status: 'connected', connection_mode: 'web_shell',
    }).returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('account_device_mounts').values({
      installation_id: installationId,
      account_id: accountId,
      owner_user_id: userId,
      last_seen_at: new Date(),
    }).execute()
    const taskId = (await db.insertInto('desktop_cleanup_tasks').values({
      installation_id: installationId,
      account_id: accountId,
      mode: 'automatic',
      reason: 'ownership_changed',
      state: 'pending',
    }).returning('id').executeTakeFirstOrThrow()).id
    await db.insertInto('desktop_cleanup_tasks').values({
      installation_id: installationId,
      account_id: accountId,
      mode: 'manual_required',
      reason: 'unsupported_client_override',
      state: 'pending',
    }).execute()

    const claim = await app.inject({
      method: 'POST', url: '/api/desktop/cleanup-tasks/claim', headers: headers(), payload: {},
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json<{ tasks: Array<{ id: string }> }>().tasks.map(task => task.id))
      .toEqual([taskId])

    const complete = await app.inject({
      method: 'POST',
      url: `/api/desktop/cleanup-tasks/${taskId}/complete`,
      headers: headers(),
      payload: {},
    })
    expect(complete.statusCode).toBe(200)
    expect(await db.selectFrom('account_device_mounts').select('account_id')
      .where('installation_id', '=', installationId).execute()).toEqual([])
  })
})
