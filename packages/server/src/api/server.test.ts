import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Role } from '@im-hub/shared'
import type { ActorRepo } from './actor.js'
import type { MessageRouteDeps } from './routes/messages.js'

// server.ts 静态 import 了 config.js，而 config.js 在模块加载期就 schema.parse(process.env)——
// 缺变量会直接抛错崩掉整个测试文件。测试环境不一定有 .env，这里先兜底填上，
// 且必须在任何触达 config.js 的 import 执行之前完成，所以下面用动态 import 而不是静态 import。
// 强制指向测试库：这些测试会写真库，绝不能落到开发库上
process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'server-test-secret-server-test-secret-32'

let buildServer: typeof import('./server.js').buildServer
let signSession: typeof import('../auth/session.js').signSession
let dbModule: typeof import('../db/client.js')

const OWNER_ID = 'owner-1'
const DISABLED_ID = 'disabled-1'

function fakeActorRepo(): ActorRepo {
  const users: Record<string, { id: string; role: Role; disabled_at: Date | null }> = {
    [OWNER_ID]: { id: OWNER_ID, role: 'owner', disabled_at: null },
    [DISABLED_ID]: { id: DISABLED_ID, role: 'agent', disabled_at: new Date() },
  }
  return {
    findUser: async (userId) => users[userId] ?? null,
    findMemberships: async () => [],
  }
}

describe('buildServer 鉴权钩子', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    ;({ buildServer } = await import('./server.js'))
    ;({ signSession } = await import('../auth/session.js'))
    dbModule = await import('../db/client.js')

    app = await buildServer(
      {} as MessageRouteDeps,
      new (await import('./ws.js')).WsHub(),
      { actorRepo: fakeActorRepo() },
    )
  })

  afterAll(async () => {
    await app.close()
    await dbModule.db.destroy()
  })

  it('无 Authorization 头的业务请求返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/accounts' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('Bearer 后跟垃圾 token 返回 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })

  it('/api/auth/login 不需要 token，钩子放行给路由自己处理', async () => {
    // 故意发一个 zod 校验不过的空 body：如果鉴权钩子拦下了这个请求，
    // 会看到钩子的 {error: 'unauthorized'}；实际应该看到路由自己的 400。
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid body' })
  })

  it('合法 token 能通过钩子并挂上 req.actor / req.scoped', async () => {
    const token = await signSession({ userId: OWNER_ID }, process.env.JWT_SECRET!)
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
    })
    // owner 的 scope 是 kind: 'all'，req.scoped.accounts() 会真的打一次数据库；
    // 能拿到 200 而不是钩子里的 401，说明 req.actor/req.scoped 已经被正确挂上。
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('accounts')
  })

  it('token 合法但用户已停用时返回 401', async () => {
    const token = await signSession({ userId: DISABLED_ID }, process.env.JWT_SECRET!)
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'unauthorized' })
  })
})
