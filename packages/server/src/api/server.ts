import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import type { Actor } from '@im-hub/shared'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { verifySession } from '../auth/session.js'
import { loadActor, type ActorRepo } from './actor.js'
import { resolveScope } from '../rbac/scope.js'
import { ScopedDb } from '../rbac/scoped-db.js'
import type { WsHub } from './ws.js'
import { authRoutes } from './routes/auth.js'
import { accountRoutes } from './routes/accounts.js'
import { conversationRoutes } from './routes/conversations.js'
import { messageRoutes, type MessageRouteDeps } from './routes/messages.js'
import { translateRoutes } from './routes/translate.js'
import { nativeRoutes, type NativeRouteDeps } from './routes/native.js'

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor
    /** 已闭包当前可见范围的仓储。路由只允许经它取数据，不要直接 import db。 */
    scoped: ScopedDb
  }
}

const defaultActorRepo: ActorRepo = {
  findUser: async (userId) => {
    const row = await db.selectFrom('users')
      .select(['id', 'role', 'disabled_at'])
      .where('id', '=', userId)
      .executeTakeFirst()
    return row ?? null
  },
  findMemberships: (userId) => db.selectFrom('team_members')
    .select(['team_id', 'is_lead'])
    .where('user_id', '=', userId)
    .execute(),
}

export interface BuildServerOptions {
  /**
   * 允许在测试里替换成内存实现，绕开真实数据库。
   * 生产路径使用组合根里挂的默认实现（走 db 单例）。
   */
  actorRepo?: ActorRepo
}

export interface BuildServerDeps extends MessageRouteDeps {
  native?: NativeRouteDeps
}

export async function buildServer(
  deps: BuildServerDeps,
  hub: WsHub,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const actorRepo = options.actorRepo ?? defaultActorRepo
  const app = Fastify({ logger: true })

  // Electron 渲染进程在开发模式下从 http://localhost:<vite端口> 加载，
  // 打包后从 file:// 加载（origin 为 null）——两种情况都是跨源，
  // 不开 CORS 的话客户端连登录接口都调不通，且浏览器只报 CORS 不报业务错误。
  await app.register(cors, {
    origin: (origin, cb) => {
      // 无 origin：打包后的 file:// 页面、curl、以及同源请求
      if (!origin) return cb(null, true)
      const ok = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      cb(null, ok)
    },
    credentials: true,
    // 必须显式列出：@fastify/cors v11 的 methods 默认值是 'GET,HEAD,POST'，
    // 不含 PATCH/PUT/DELETE。漏了会让浏览器在预检阶段就拦掉请求，
    // 而 curl 因为不发 Origin 头、不触发预检，测起来一切正常——假信号。
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  })

  await app.register(websocket)

  app.addHook('onRequest', async (req, reply) => {
    // /api/auth/ 自己校验密码；/ws 自己在首帧里鉴权。两者都不走这个钩子。
    if (req.url.startsWith('/api/auth/') || req.url.startsWith('/ws')) return
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' })
    try {
      const claims = await verifySession(header.slice(7), config.JWT_SECRET)
      req.actor = await loadActor(claims.userId, actorRepo)
      req.scoped = new ScopedDb(db, resolveScope(req.actor))
    } catch {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  await app.register(authRoutes)
  // safeStorage 中的 user.role 只是上次登录快照。原生客户端控制门禁必须
  // 在恢复会话后用服务端每请求实时加载的 actor 刷新，避免已改为 auditor
  // 的用户继续按旧 agent 快照挂载平台会话。
  app.get('/api/session/me', async (req) => ({
    user: { id: req.actor.userId, role: req.actor.role },
  }))
  await app.register(async (instance) => { await accountRoutes(instance, deps) })
  await app.register(conversationRoutes)
  await app.register(async (instance) => { await messageRoutes(instance, deps) })
  await app.register(async (instance) => { await translateRoutes(instance, deps) })
  const native = deps.native
  if (native) {
    await app.register(async (instance) => { await nativeRoutes(instance, native) })
  }

  /**
   * 鉴权走首帧消息，不走 query string —— URL 里的 token 会落进反向代理和服务端
   * 访问日志，而它有 12 小时有效期，被日志采集带走就是 12 小时的可用凭证。
   * 浏览器的 WebSocket 构造函数设不了请求头，所以用首帧握手代替。
   */
  app.get('/ws', { websocket: true }, (socket) => {
    let authed = false

    const deadline = setTimeout(() => {
      if (!authed) socket.close(1008, 'auth timeout')
    }, 5000)

    socket.on('message', async (data: Buffer) => {
      if (authed) return
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; token?: string }
        if (msg.type !== 'auth' || !msg.token) throw new Error('expected auth frame')
        const claims = await verifySession(msg.token, config.JWT_SECRET)
        authed = true
        clearTimeout(deadline)
        hub.add(claims.userId, socket as never)
        socket.send(JSON.stringify({ type: 'auth_ok' }))
      } catch {
        clearTimeout(deadline)
        socket.close(1008, 'unauthorized')
      }
    })

    socket.on('close', () => clearTimeout(deadline))
  })

  return app
}
