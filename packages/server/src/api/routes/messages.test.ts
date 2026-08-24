import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'
import type { MessageRouteDeps } from './messages.js'

// server.ts 在模块加载期静态 import config.js，而 config.js 在加载期就 schema.parse(process.env)。
// 必须在任何触达 config.js / db/client.js 的 import 执行之前把这些填好，所以用动态 import。
process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'messages-route-test-secret-32-chars'

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let OWNER_ID: string

function fakeActorRepo(): ActorRepo {
  return {
    findUser: async (userId) =>
      userId === OWNER_ID ? { id: OWNER_ID, role: 'owner' as Role, disabled_at: null } : null,
    findMemberships: async () => [],
  }
}

let app: FastifyInstance
let translate: ReturnType<typeof vi.fn>
let adapterSend: ReturnType<typeof vi.fn>
let token: string
let accountId: string
let conversationId: string

beforeEach(async () => {
  // 干净状态：按外键依赖倒序清空
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()

  const user = await db.insertInto('users').values({
    email: 'owner-msg-route@example.com', display_name: 'O', role: 'owner', password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()
  OWNER_ID = user.id

  const acc = await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: OWNER_ID, display_name: 'TG', status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()
  accountId = acc.id

  const conv = await db.insertInto('conversations').values({
    account_id: accountId, platform_conversation_id: 'pc-1', contact_external_id: 'contact-1',
    target_lang: null,
  }).returning('id').executeTakeFirstOrThrow()
  conversationId = conv.id

  translate = vi.fn()
  adapterSend = vi.fn().mockResolvedValue('platform-msg-id')

  const deps: MessageRouteDeps = {
    adapters: { send: adapterSend } as never,
    gateway: { translate } as never,
  }

  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer(deps, new (await import('../ws.js')).WsHub(), { actorRepo: fakeActorRepo() })
  token = await signSession({ userId: OWNER_ID }, process.env.JWT_SECRET!)
})

afterAll(async () => {
  await app?.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

function auth(token_: string) {
  return { authorization: `Bearer ${token_}` }
}

describe('POST /api/messages/translate-preview', () => {
  it('看不到的会话返回 404，且不调用翻译网关', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId: '00000000-0000-0000-0000-000000000000', text: '你好' },
    })
    expect(res.statusCode).toBe(404)
    expect(translate).not.toHaveBeenCalled()
  })

  it('空白文本返回 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId, text: '   ' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('正常返回 translated / backTranslated / targetLang / provider，新会话没有客户消息时目标语言落到兜底 en', async () => {
    translate
      .mockResolvedValueOnce({ text: 'Hello', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })
      .mockResolvedValueOnce({ text: '你好', detectedLang: 'en', provider: 'deepl', cached: false, downgradedFrom: [] })

    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId, text: '你好' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      translated: 'Hello', backTranslated: '你好', targetLang: 'en', provider: 'deepl',
    })
    expect(translate).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: '你好', to: 'en' }))
    expect(translate).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: 'Hello', from: 'en', to: 'zh' }))
  })

  it('目标语言跟随客户最近一条入向消息的检测语言', async () => {
    await db.insertInto('messages').values({
      conversation_id: conversationId, account_id: accountId, platform: 'telegram',
      platform_message_id: 'm1', direction: 'in', sender_external_id: 'c1',
      body: 'こんにちは', body_lang: 'ja', sent_at: new Date(), media_refs: JSON.stringify([]) as never, raw: JSON.stringify({}) as never,
    }).execute()

    translate
      .mockResolvedValueOnce({ text: 'ja-text', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })
      .mockResolvedValueOnce({ text: '你好', detectedLang: 'ja', provider: 'deepl', cached: false, downgradedFrom: [] })

    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId, text: '你好' },
    })

    expect(res.json()).toMatchObject({ targetLang: 'ja' })
    expect(translate).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: 'ja' }))
  })

  it('会话锁定的语言优先于客户检测语言', async () => {
    await db.updateTable('conversations').set({ target_lang: 'fr' }).where('id', '=', conversationId).execute()
    await db.insertInto('messages').values({
      conversation_id: conversationId, account_id: accountId, platform: 'telegram',
      platform_message_id: 'm1', direction: 'in', sender_external_id: 'c1',
      body: 'こんにちは', body_lang: 'ja', sent_at: new Date(), media_refs: JSON.stringify([]) as never, raw: JSON.stringify({}) as never,
    }).execute()

    translate
      .mockResolvedValueOnce({ text: 'fr-text', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })
      .mockResolvedValueOnce({ text: '你好', detectedLang: 'fr', provider: 'deepl', cached: false, downgradedFrom: [] })

    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId, text: '你好' },
    })
    expect(res.json()).toMatchObject({ targetLang: 'fr' })
  })

  it('回译失败时 backTranslated 为 null，预览仍然成功', async () => {
    translate
      .mockResolvedValueOnce({ text: 'Hello', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })
      .mockRejectedValueOnce(new Error('back-translate service down'))

    const res = await app.inject({
      method: 'POST', url: '/api/messages/translate-preview',
      headers: auth(token),
      payload: { conversationId, text: '你好' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ translated: 'Hello', backTranslated: null, targetLang: 'en' })
  })
})

describe('POST /api/messages/send', () => {
  it('preTranslated:true 时原样发出，绝不再翻译一次', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      headers: auth(token),
      payload: { conversationId, body: 'Confirmed English text', preTranslated: true },
    })

    expect(res.statusCode).toBe(200)
    expect(translate).not.toHaveBeenCalled()
    expect(adapterSend).toHaveBeenCalledWith(accountId, 'pc-1', { body: 'Confirmed English text' })
    expect(res.json()).toEqual({ platformMessageId: 'platform-msg-id', sentText: 'Confirmed English text', provider: undefined })
  })

  it('preTranslated 缺省为 false 时保持旧行为：服务端翻译后发出（向后兼容旧客户端）', async () => {
    translate.mockResolvedValueOnce({ text: 'Hello', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })

    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      headers: auth(token),
      payload: { conversationId, body: '你好', targetLang: 'en' },
    })

    expect(res.statusCode).toBe(200)
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ text: '你好', to: 'en' }))
    expect(adapterSend).toHaveBeenCalledWith(accountId, 'pc-1', { body: 'Hello' })
    expect(res.json()).toMatchObject({ sentText: 'Hello', provider: 'deepl' })
  })

  it('preTranslated:false 且不传 targetLang 时由 resolveTargetLang 解析', async () => {
    translate.mockResolvedValueOnce({ text: 'Hello', detectedLang: 'zh', provider: 'deepl', cached: false, downgradedFrom: [] })

    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      headers: auth(token),
      payload: { conversationId, body: '你好' },
    })

    expect(res.statusCode).toBe(200)
    // 新会话没有客户入向消息，落到兜底 en
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ to: 'en' }))
  })

  it('空白 body 返回 400，preTranslated:true 也不能绕过这条校验', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      headers: auth(token),
      payload: { conversationId, body: '   ', preTranslated: true },
    })
    expect(res.statusCode).toBe(400)
    expect(adapterSend).not.toHaveBeenCalled()
  })

  it('看不到的会话返回 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      headers: auth(token),
      payload: { conversationId: '00000000-0000-0000-0000-000000000000', body: 'hi', preTranslated: true },
    })
    expect(res.statusCode).toBe(404)
    expect(adapterSend).not.toHaveBeenCalled()
  })

  it('无 token 返回 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/messages/send',
      payload: { conversationId, body: 'hi', preTranslated: true },
    })
    expect(res.statusCode).toBe(401)
  })
})
