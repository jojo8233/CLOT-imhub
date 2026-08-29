import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'
import type { MessageRouteDeps } from './messages.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'accounts-route-test-secret-32chars'

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let AGENT_ID: string
let MANAGER_ID: string
let AUDITOR_ID: string
let TEAM_ID: string
let agentAccountId: string

/** manager 带这个组，所以他能「看见」agent 的账号——正是要确保他仍然不能替 agent 完成关联 */
function fakeActorRepo(): ActorRepo {
  const roles: Record<string, Role> = {}
  return {
    findUser: async (userId) => {
      roles[AGENT_ID] = 'agent'
      roles[MANAGER_ID] = 'manager'
      roles[AUDITOR_ID] = 'auditor'
      const role = roles[userId]
      return role ? { id: userId, role, disabled_at: null } : null
    },
    findMemberships: async (userId) =>
      userId === MANAGER_ID ? [{ team_id: TEAM_ID, is_lead: true }]
        : userId === AGENT_ID ? [{ team_id: TEAM_ID, is_lead: false }]
          : [],
  }
}

const adapters = {
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  submitAuthAnswer: vi.fn(async () => {}),
  purge: vi.fn(async () => {}),
}

let app: FastifyInstance
let agentToken: string
let managerToken: string
let auditorToken: string

beforeEach(async () => {
  adapters.connect.mockClear()
  adapters.disconnect.mockClear()
  adapters.submitAuthAnswer.mockClear()
  adapters.purge.mockClear()
  adapters.purge.mockResolvedValue(undefined as never)

  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()

  const team = await db.insertInto('teams').values({ name: '测试组' })
    .returning('id').executeTakeFirstOrThrow()
  TEAM_ID = team.id

  const mk = async (email: string, role: Role): Promise<string> => {
    const row = await db.insertInto('users')
      .values({ email, display_name: email, role, password_hash: 'x' })
      .returning('id').executeTakeFirstOrThrow()
    return row.id
  }
  AGENT_ID = await mk('agent-acct-route@example.com', 'agent')
  MANAGER_ID = await mk('manager-acct-route@example.com', 'manager')
  AUDITOR_ID = await mk('auditor-acct-route@example.com', 'auditor')

  await db.insertInto('team_members').values([
    { team_id: TEAM_ID, user_id: AGENT_ID, is_lead: false },
    { team_id: TEAM_ID, user_id: MANAGER_ID, is_lead: true },
  ]).execute()

  const acc = await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: AGENT_ID, team_id: TEAM_ID,
    display_name: '待关联', status: 'pending_auth',
  }).returning('id').executeTakeFirstOrThrow()
  agentAccountId = acc.id

  const deps: MessageRouteDeps = { adapters: adapters as never, gateway: {} as never }
  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer(deps, new (await import('../ws.js')).WsHub(), { actorRepo: fakeActorRepo() })
  agentToken = await signSession({ userId: AGENT_ID }, process.env.JWT_SECRET!)
  managerToken = await signSession({ userId: MANAGER_ID }, process.env.JWT_SECRET!)
  auditorToken = await signSession({ userId: AUDITOR_ID }, process.env.JWT_SECRET!)
})

afterAll(async () => {
  await app?.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

describe('POST /api/accounts', () => {
  it('建成的账号归创建者所有，并落进他所在的组', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'telegram', displayName: '我的新号' },
    })
    expect(res.statusCode).toBe(201)

    const row = await db.selectFrom('accounts')
      .select(['owner_user_id', 'team_id', 'status', 'credentials_ref'])
      .where('display_name', '=', '我的新号').executeTakeFirstOrThrow()
    expect(row.owner_user_id).toBe(AGENT_ID)
    expect(row.team_id).toBe(TEAM_ID)
    expect(row.status).toBe('pending_auth')
    // 还没鉴权成功，不该有凭据标记——启动时的自动重连正是靠它判断
    expect(row.credentials_ref).toBeNull()
  })

  it('创建后立即发起鉴权', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'telegram', displayName: '我的新号' },
    })
    expect(adapters.connect).toHaveBeenCalledTimes(1)
  })

  it('请求体里指定 owner_user_id 无效，归属只认 token', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'telegram', displayName: '冒名号', owner_user_id: MANAGER_ID },
    })
    const row = await db.selectFrom('accounts').select('owner_user_id')
      .where('display_name', '=', '冒名号').executeTakeFirstOrThrow()
    expect(row.owner_user_id).toBe(AGENT_ID)
  })

  it('auditor 是只读角色，建不了账号', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(auditorToken),
      payload: { platform: 'telegram', displayName: '不该建成' },
    })
    expect(res.statusCode).toBe(403)
    const n = await db.selectFrom('accounts').select(db.fn.countAll<string>().as('n'))
      .where('display_name', '=', '不该建成').executeTakeFirstOrThrow()
    expect(n.n).toBe('0')
  })

  it('WhatsApp Web shell 账号可创建并立即登记隔离会话', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'whatsapp', displayName: 'WA' },
    })
    expect(res.statusCode).toBe(201)
    expect(adapters.connect).toHaveBeenCalledWith('whatsapp', expect.objectContaining({
      displayName: 'WA',
      credentialsRef: null,
    }))
  })

  it('适配器还没接入的平台直接挡住，不留下建了连不上的空账号', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'zoom', displayName: 'Zoom' },
    })
    expect(res.statusCode).toBe(400)
    expect(adapters.connect).not.toHaveBeenCalled()
  })

  it('名称为空白时拒绝', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounts', headers: auth(agentToken),
      payload: { platform: 'telegram', displayName: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/accounts/:id/auth-answer', () => {
  it('owner 本人提交后转交给适配器', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/auth-answer`,
      headers: auth(agentToken), payload: { value: 'hunter2' },
    })
    expect(res.statusCode).toBe(200)
    expect(adapters.submitAuthAnswer).toHaveBeenCalledWith(agentAccountId, 'hunter2')
  })

  it('带队的 manager 看得见这个账号，但不能替下属输二次验证密码', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/auth-answer`,
      headers: auth(managerToken), payload: { value: 'hunter2' },
    })
    expect(res.statusCode).toBe(404)
    expect(adapters.submitAuthAnswer).not.toHaveBeenCalled()
  })

  it('适配器当前没在等输入时回 409，而不是静默成功', async () => {
    adapters.submitAuthAnswer.mockRejectedValueOnce(new Error('没有在等待'))
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/auth-answer`,
      headers: auth(agentToken), payload: { value: 'x' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('超长输入被挡住，且错误信息里不回显收到的内容', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/auth-answer`,
      headers: auth(agentToken), payload: { value: 'a'.repeat(300) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('aaaa')
  })
})

describe('POST /api/accounts/:id/relink', () => {
  it('未关联的账号可以重新发起，先断后连才能拿到新二维码', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/relink`, headers: auth(agentToken),
    })
    expect(res.statusCode).toBe(200)
    expect(adapters.disconnect).toHaveBeenCalledWith(agentAccountId)
    expect(adapters.connect).toHaveBeenCalledTimes(1)
  })

  it('已经在线的账号拒绝重新关联，避免踢掉正在进行的会话', async () => {
    await db.updateTable('accounts').set({ status: 'connected' })
      .where('id', '=', agentAccountId).execute()
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/relink`, headers: auth(agentToken),
    })
    expect(res.statusCode).toBe(409)
    expect(adapters.disconnect).not.toHaveBeenCalled()
  })

  it('不是自己的账号一律 404', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/accounts/${agentAccountId}/relink`, headers: auth(managerToken),
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/accounts/:id（改名）', () => {
  it('owner 本人可以改名', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { displayName: '改过的名字' },
    })
    expect(res.statusCode).toBe(200)
    const row = await db.selectFrom('accounts').select('display_name')
      .where('id', '=', agentAccountId).executeTakeFirstOrThrow()
    expect(row.display_name).toBe('改过的名字')
  })

  it('带队的 manager 也能改——改名不影响任何平台侧状态', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/accounts/${agentAccountId}`,
      headers: auth(managerToken), payload: { displayName: '主管改的' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('auditor 是只读角色，改不了', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/accounts/${agentAccountId}`,
      headers: auth(auditorToken), payload: { displayName: '不该生效' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('空名称被拒绝', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { displayName: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /api/accounts/:id', () => {
  it('名称对得上才删，并且先清平台数据再删库', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { confirmName: '待关联' },
    })
    expect(res.statusCode).toBe(200)
    expect(adapters.purge).toHaveBeenCalledWith('telegram', agentAccountId)

    const row = await db.selectFrom('accounts').select('id')
      .where('id', '=', agentAccountId).executeTakeFirst()
    expect(row).toBeUndefined()
  })

  it('名称对不上一律不删——这是不可逆操作，挡住手滑', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { confirmName: '打错了' },
    })
    expect(res.statusCode).toBe(400)
    expect(adapters.purge).not.toHaveBeenCalled()
    const row = await db.selectFrom('accounts').select('id')
      .where('id', '=', agentAccountId).executeTakeFirst()
    expect(row).toBeDefined()
  })

  it('清平台数据失败时中止删除，不留半删状态', async () => {
    adapters.purge.mockRejectedValueOnce(new Error('磁盘只读'))
    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { confirmName: '待关联' },
    })
    expect(res.statusCode).toBe(500)
    // 库里必须还在：删了库而平台侧还连着，消息收进来无处安放，是最难查的状态
    const row = await db.selectFrom('accounts').select('id')
      .where('id', '=', agentAccountId).executeTakeFirst()
    expect(row).toBeDefined()
  })

  it('看得见但不是自己的账号也不能删', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${agentAccountId}`,
      headers: auth(managerToken), payload: { confirmName: '待关联' },
    })
    expect(res.statusCode).toBe(404)
    expect(adapters.purge).not.toHaveBeenCalled()
  })

  it('删账号会带走它名下的会话与消息，返回值里说清删了多少条', async () => {
    const conv = await db.insertInto('conversations').values({
      account_id: agentAccountId, platform_conversation_id: 'pc-1', contact_external_id: 'c-1',
    }).returning('id').executeTakeFirstOrThrow()
    await db.insertInto('messages').values({
      account_id: agentAccountId, conversation_id: conv.id, platform: 'telegram',
      platform_message_id: 'm-1', direction: 'in', sender_external_id: 'c-1',
      body: 'hi', sent_at: new Date(), raw: JSON.stringify({}), media_refs: JSON.stringify([]),
    }).execute()

    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${agentAccountId}`,
      headers: auth(agentToken), payload: { confirmName: '待关联' },
    })
    expect(res.json()).toMatchObject({ ok: true, deletedMessages: 1 })

    const left = await db.selectFrom('conversations').select('id')
      .where('account_id', '=', agentAccountId).execute()
    expect(left).toEqual([])
  })

  it('Signal 账号提示用户去手机上移除已关联设备', async () => {
    const sig = await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: AGENT_ID, team_id: TEAM_ID,
      display_name: 'SG', status: 'connected', credentials_ref: '+1555',
    }).returning('id').executeTakeFirstOrThrow()

    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${sig.id}`,
      headers: auth(agentToken), payload: { confirmName: 'SG' },
    })
    // 只清本地数据、不动服务端注册，所以手机上那个条目要用户自己删
    expect(res.json().manualCleanup).toContain('已关联设备')
  })

  it('WhatsApp 账号提示用户从手机移除浏览器会话', async () => {
    const wa = await db.insertInto('accounts').values({
      platform: 'whatsapp', owner_user_id: AGENT_ID, team_id: TEAM_ID,
      display_name: 'WA', status: 'pending_auth',
    }).returning('id').executeTakeFirstOrThrow()

    const res = await app.inject({
      method: 'DELETE', url: `/api/accounts/${wa.id}`,
      headers: auth(agentToken), payload: { confirmName: 'WA' },
    })
    expect(res.json().manualCleanup).toContain('WhatsApp')
    expect(res.json().manualCleanup).toContain('已关联设备')
  })
})
