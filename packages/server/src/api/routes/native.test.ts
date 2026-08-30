import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type Role } from '@im-hub/shared'
import { signNativeControlGrant } from '../../auth/native-control-grant.js'
import type { Database } from '../../db/types.js'
import type { MessagePublicationSnapshot } from '../../ingest/repo.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'

const TEST_JWT_SECRET = 'native-route-test-secret-32-chars'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET = TEST_JWT_SECRET

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

let app: FastifyInstance
let agentId: string
let managerId: string
let auditorId: string
let teamId: string
let accountId: string
let agentToken: string
let managerToken: string
let auditorToken: string
let nativeGrant: string

const upsertConversation = vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000099' })
const ingestResult = {
  messageId: 'message-1', conversationId: 'conversation-1', isNew: true, contentChanged: false,
}
const ingestDetailed = vi.fn(async (
  _message: unknown,
  onStored?: (result: typeof ingestResult) => void | Promise<void>,
) => {
  await onStored?.(ingestResult)
  return ingestResult
})
const markMessageDeleted = vi.fn()
const remapMessageId = vi.fn()
let publicationSnapshot: MessagePublicationSnapshot
const withMessageForPublish = vi.fn(async (
  _messageId: string,
  action: (message: MessagePublicationSnapshot) => void,
) => {
  action(publicationSnapshot)
  return true
})
const publish = vi.fn()
const translate = vi.fn().mockResolvedValue({
  text: '你好', detectedLang: 'en', provider: 'deepl', cached: false, downgradedFrom: [],
})

function actorRepo(): ActorRepo {
  const roles = new Map<string, Role>([
    [agentId, 'agent'], [managerId, 'manager'], [auditorId, 'auditor'],
  ])
  return {
    findUser: async (userId) => {
      const role = roles.get(userId)
      return role ? { id: userId, role, disabled_at: null } : null
    },
    findMemberships: async (userId) => userId === managerId
      ? [{ team_id: teamId, is_lead: true }]
      : userId === agentId
        ? [{ team_id: teamId, is_lead: false }]
        : [],
  }
}

beforeEach(async () => {
  await app?.close()
  upsertConversation.mockClear()
  ingestDetailed.mockClear()
  ingestResult.isNew = true
  ingestResult.contentChanged = false
  markMessageDeleted.mockReset()
  remapMessageId.mockReset()
  withMessageForPublish.mockReset().mockImplementation(async (
    _messageId: string,
    action: (message: MessagePublicationSnapshot) => void,
  ) => {
    action(publicationSnapshot)
    return true
  })
  publish.mockClear()
  translate.mockClear()

  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()

  teamId = (await db.insertInto('teams').values({ name: 'Native Team' })
    .returning('id').executeTakeFirstOrThrow()).id
  const addUser = async (email: string, role: Role) => (await db.insertInto('users').values({
    email, display_name: email, role, password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()).id
  agentId = await addUser('native-agent@example.com', 'agent')
  managerId = await addUser('native-manager@example.com', 'manager')
  auditorId = await addUser('native-auditor@example.com', 'auditor')
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: agentId, is_lead: false },
    { team_id: teamId, user_id: managerId, is_lead: true },
  ]).execute()
  accountId = (await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: agentId, team_id: teamId,
    display_name: 'Native TG', status: 'connected', platform_account_external_id: '778899',
  }).returning('id').executeTakeFirstOrThrow()).id
  publicationSnapshot = {
    id: 'message-1',
    conversationId: 'conversation-1',
    accountId,
    ownerUserId: agentId,
    platform: 'telegram',
    direction: 'in',
    body: 'hello',
    translatedBody: null,
    sentAt: new Date('2026-08-26T00:00:00.000Z'),
    editedAt: null,
    editVersion: null,
    deletedAt: null,
  }

  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer({
    adapters: {} as never,
    gateway: { translate } as never,
    native: {
      ingestor: { ingestDetailed } as never,
      repo: { upsertConversation, withMessageForPublish, markMessageDeleted, remapMessageId },
      publish,
    },
  }, new (await import('../ws.js')).WsHub(), { actorRepo: actorRepo() })
  agentToken = await signSession({ userId: agentId }, process.env.JWT_SECRET!)
  managerToken = await signSession({ userId: managerId }, process.env.JWT_SECRET!)
  auditorToken = await signSession({ userId: auditorId }, process.env.JWT_SECRET!)
  const grantResponse = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/native-control-grant`,
    headers: auth(agentToken),
  })
  expect(grantResponse.statusCode).toBe(200)
  nativeGrant = grantResponse.json<{ grant: string }>().grant
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

function nativeAuth(grant: string = nativeGrant) {
  return { authorization: `NativeGrant ${grant}` }
}

const telegramChatId = '-1001234567890'
const canonicalMessageId = `${telegramChatId}:1`
const context = {
  platformConversationId: telegramChatId, contactExternalId: '777000', contactDisplayName: 'Jane',
}

function upsertEvent() {
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId: 'event-1',
    message: {
      platformConversationId: telegramChatId, platformMessageId: canonicalMessageId, direction: 'in',
      senderExternalId: '777000', senderDisplayName: 'Jane', conversationDisplayName: 'Jane',
      body: 'hello', mediaRefs: [], replyToPlatformMessageId: null,
      sentAt: '2026-08-26T00:00:00.000Z', editedAt: null, editVersion: null, raw: {},
    },
  }
}

describe('native bridge routes', () => {
  it('grant 验证只返回账号绑定与过期时间，不回显用户会话', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/control-grant/verify', headers: nativeAuth(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      accountId,
      platform: 'telegram',
      expectedPlatformAccountExternalId: '778899',
    })
    expect(response.json()).not.toHaveProperty('userId')
    expect(response.json()).not.toHaveProperty('grant')
  })

  it('长期用户 session 不能绕过主进程直接调用 native 路由', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: auth(agentToken),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(401)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('显式撤销后旧 grant 不能继续同步会话或代理翻译', async () => {
    const revoke = await app.inject({
      method: 'DELETE', url: '/api/native/control-grant', headers: nativeAuth(),
    })
    expect(revoke.statusCode).toBe(200)
    const contextResponse = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(),
      payload: { accountId, context },
    })
    expect(contextResponse.statusCode).toBe(401)
    const translationResponse = await app.inject({
      method: 'POST', url: '/api/translate/batch', headers: nativeAuth(),
      payload: { texts: ['hello'], targetLang: 'zh' },
    })
    expect(translationResponse.statusCode).toBe(401)
    expect(translate).not.toHaveBeenCalled()
  })

  it('服务端平台身份变化会立即使既有 grant 失效', async () => {
    await db.updateTable('accounts')
      .set({ platform_account_external_id: 'another-user' })
      .where('id', '=', accountId)
      .execute()
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(401)
  })

  it('平台身份尚未就绪时不签发 grant', async () => {
    await db.updateTable('accounts')
      .set({ platform_account_external_id: null })
      .where('id', '=', accountId)
      .execute()
    const response = await app.inject({
      method: 'POST', url: `/api/accounts/${accountId}/native-control-grant`, headers: auth(agentToken),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('身份尚未就绪') })
  })

  it('Signal 原生账号只允许 owner 用实际 ACI 首次绑定并签发短时 grant', async () => {
    const signalAccountId = (await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: agentId, team_id: teamId,
      display_name: 'Native Signal', status: 'pending_auth', connection_mode: 'native_desktop',
    }).returning('id').executeTakeFirstOrThrow()).id
    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${signalAccountId}/native-control-grant`,
      headers: auth(agentToken),
      payload: { platformAccountExternalId: '11111111-2222-3333-AAAA-555555555555' },
    })
    expect(response.statusCode).toBe(200)
    const row = await db.selectFrom('accounts')
      .select(['platform_account_external_id', 'status', 'connection_mode', 'credentials_ref'])
      .where('id', '=', signalAccountId)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      platform_account_external_id: '11111111-2222-3333-aaaa-555555555555',
      status: 'connected',
      connection_mode: 'native_desktop',
      credentials_ref: null,
    })

    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/accounts/${signalAccountId}/native-control-grant`,
      headers: auth(agentToken),
      payload: { platformAccountExternalId: '22222222-2222-4333-AAAA-555555555555' },
    })
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json()).toMatchObject({ error: expect.stringContaining('身份') })

    const invalidAciAccountId = (await db.insertInto('accounts').values({
      platform: 'signal', owner_user_id: agentId, team_id: teamId,
      display_name: 'Invalid Native Signal', status: 'pending_auth', connection_mode: 'native_desktop',
    }).returning('id').executeTakeFirstOrThrow()).id
    const invalidAci = await app.inject({
      method: 'POST',
      url: `/api/accounts/${invalidAciAccountId}/native-control-grant`,
      headers: auth(agentToken),
      payload: { platformAccountExternalId: 'not-an-aci' },
    })
    expect(invalidAci.statusCode).toBe(400)
  })

  it('owner 被改成 auditor 后既有 grant 立即失效', async () => {
    await db.updateTable('users').set({ role: 'auditor' }).where('id', '=', agentId).execute()
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(401)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('一个账号的 grant 不能用于另一个账号或 partition', async () => {
    const otherAccountId = (await db.insertInto('accounts').values({
      platform: 'telegram', owner_user_id: agentId, team_id: teamId,
      display_name: 'Other TG', status: 'connected', platform_account_external_id: '112233',
    }).returning('id').executeTakeFirstOrThrow()).id
    const grantResponse = await app.inject({
      method: 'POST', url: `/api/accounts/${otherAccountId}/native-control-grant`, headers: auth(agentToken),
    })
    const otherGrant = grantResponse.json<{ grant: string }>().grant
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(otherGrant),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(401)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('有效 grant 可以代理翻译且 guest 不需要用户 JWT', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/translate/batch', headers: nativeAuth(),
      payload: { texts: ['hello'], targetLang: 'zh' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ results: [{ translated: '你好', failed: false }] })
    expect(translate).toHaveBeenCalledOnce()
  })

  it('账号归属人可以把平台会话解析成内部 UUID', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(200)
    expect(upsertConversation).toHaveBeenCalledWith({ accountId, ...context })
  })

  it('Telegram 会话拒绝旧式非数字 chat id', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: nativeAuth(),
      payload: { accountId, context: { ...context, platformConversationId: 'chat-1' } },
    })
    expect(response.statusCode).toBe(422)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('manager 虽然能看见组员账号，也不能签发原生控制 grant', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/accounts/${accountId}/native-control-grant`, headers: auth(managerToken),
    })
    expect(response.statusCode).toBe(404)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('全局只读 auditor 不能签发原生控制 grant', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/accounts/${accountId}/native-control-grant`, headers: auth(auditorToken),
    })
    expect(response.statusCode).toBe(403)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })

  it('auditor 即使是账号 owner 也不能驱动原生桥接', async () => {
    await db.updateTable('accounts')
      .set({ owner_user_id: auditorId })
      .where('id', '=', accountId)
      .execute()
    const response = await app.inject({
      method: 'POST', url: `/api/accounts/${accountId}/native-control-grant`, headers: auth(auditorToken),
    })
    expect(response.statusCode).toBe(403)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })

  it('消息 platform 和 accountId 只取服务端已校验账号', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(200)
    expect(ingestDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'telegram', accountId, platformMessageId: canonicalMessageId }),
      expect.any(Function),
      'telegram-tt',
    )
    expect(publish).toHaveBeenCalledWith(agentId, expect.objectContaining({ type: 'message' }))
  })

  it('Signal 入站文字只接受 sender+timestamp 规范键且不进入 Telegram shadow', async () => {
    const signalAci = '11111111-2222-3333-aaaa-555555555555'
    const signalAccount = await db.updateTable('accounts')
      .set({
        platform: 'signal',
        connection_mode: 'native_desktop',
        platform_account_external_id: signalAci,
      })
      .where('id', '=', accountId)
      .returning('native_control_version')
      .executeTakeFirstOrThrow()
    const { grant } = await signNativeControlGrant({
      userId: agentId,
      accountId,
      platform: 'signal',
      expectedPlatformAccountExternalId: signalAci,
      controlVersion: signalAccount.native_control_version,
    }, TEST_JWT_SECRET)
    const platformMessageId = '99999999-2222-3333-aaaa-555555555555:1788048000000'
    const event = {
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'message.upsert',
      eventId: `signal-inbound:${platformMessageId}`,
      message: {
        platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
        platformMessageId,
        direction: 'in',
        senderExternalId: '99999999-2222-3333-aaaa-555555555555',
        senderDisplayName: 'Alice',
        conversationDisplayName: 'Alice',
        body: 'signal hello',
        mediaRefs: [],
        replyToPlatformMessageId: null,
        sentAt: '2026-08-30T00:00:00.000Z',
        editedAt: null,
        editVersion: null,
        raw: { source: 'signal-desktop' },
      },
    }
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(grant),
      payload: { accountId, event },
    })
    expect(response.statusCode).toBe(200)
    expect(ingestDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'signal', accountId, platformMessageId, body: 'signal hello',
      }),
      expect.any(Function),
      undefined,
    )

    const invalid = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(grant),
      payload: {
        accountId,
        event: { ...event, message: { ...event.message, platformMessageId: 'local-sqlite-uuid' } },
      },
    })
    expect(invalid.statusCode).toBe(422)
  })

  it('Telegram 消息拒绝未带 chat 前缀的 TDLib 旧 id', async () => {
    const base = upsertEvent()
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: { ...base, message: { ...base.message, platformMessageId: '1048576' } },
      },
    })
    expect(response.statusCode).toBe(422)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })

  it('首次见到的编辑版本在 message 事件中保留 editedAt revision', async () => {
    const base = upsertEvent()
    const event = {
      ...base,
      message: {
        ...base.message, editedAt: '2026-08-26T08:00:00+07:00', editVersion: 10,
      },
    }
    publicationSnapshot = {
      ...publicationSnapshot,
      body: 'canonical edited body',
      translatedBody: '规范译文',
      editedAt: new Date('2026-08-26T01:00:00.000Z'),
      editVersion: 10,
    }
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: { accountId, event },
    })
    expect(response.statusCode).toBe(200)
    expect(publish).toHaveBeenCalledWith(agentId, expect.objectContaining({
      type: 'message', body: 'canonical edited body', translatedBody: '规范译文',
      editedAt: '2026-08-26T01:00:00.000Z',
    }))
  })

  it('同 revision 编辑重试会重发带现有译文的规范更新', async () => {
    ingestResult.isNew = false
    ingestResult.contentChanged = false
    publicationSnapshot = {
      ...publicationSnapshot,
      body: 'edited body',
      translatedBody: '已完成译文',
      editedAt: new Date('2026-08-26T01:00:00.000Z'),
      editVersion: 11,
    }
    const base = upsertEvent()
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: {
          ...base,
          message: {
            ...base.message,
            body: 'edited body',
            editedAt: '2026-08-26T01:00:00Z',
            editVersion: 11,
          },
        },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ accepted: true, duplicate: true })
    expect(publish).toHaveBeenCalledWith(agentId, {
      type: 'message_updated',
      messageId: 'message-1',
      conversationId: 'conversation-1',
      body: 'edited body',
      editedAt: '2026-08-26T01:00:00.000Z',
      translatedBody: '已完成译文',
    })
  })

  it('初始消息已落库但首次发布失败时，重试会重发规范 message', async () => {
    ingestResult.isNew = false
    ingestResult.contentChanged = false
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ accepted: true, duplicate: true })
    expect(publish).toHaveBeenCalledWith(agentId, expect.objectContaining({
      type: 'message', messageId: 'message-1', body: 'hello',
    }))
  })

  it('删除不存在的消息按幂等 no-op 接受，不让 outbox 永久重试', async () => {
    markMessageDeleted.mockResolvedValue(null)
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.deleted', eventId: 'delete-missing',
          platformMessageId: canonicalMessageId, deletedAt: '2026-08-26T02:00:00.000Z',
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ accepted: true, duplicate: true })
    expect(markMessageDeleted).toHaveBeenCalledWith(
      accountId,
      canonicalMessageId,
      new Date('2026-08-26T02:00:00.000Z'),
      expect.objectContaining({
        accountId, source: 'telegram-tt', eventType: 'delete',
        factKey: `delete:${canonicalMessageId}`,
      }),
    )
    expect(publish).not.toHaveBeenCalled()
  })

  it('重映射不存在的旧消息按幂等 no-op 接受，不让 outbox 永久重试', async () => {
    remapMessageId.mockResolvedValue(null)
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.id-remapped', eventId: 'remap-missing',
          oldPlatformMessageId: `${telegramChatId}:temp:telegram-tt:0123456789abcdef0123456789abcdef:1.000001`,
          newPlatformMessageId: canonicalMessageId,
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ accepted: true, duplicate: true })
    expect(remapMessageId).toHaveBeenCalledWith(
      accountId,
      `${telegramChatId}:temp:telegram-tt:0123456789abcdef0123456789abcdef:1.000001`,
      canonicalMessageId,
      expect.objectContaining({
        accountId, source: 'telegram-tt', eventType: 'remap',
        factKey: expect.stringContaining(`:${canonicalMessageId}`),
      }),
    )
    expect(publish).not.toHaveBeenCalled()
  })

  it('非 Telegram native 生命周期事件不写入 Telegram shadow 账本', async () => {
    const signalAccount = await db.updateTable('accounts')
      .set({ platform: 'signal' })
      .where('id', '=', accountId)
      .returning(['platform_account_external_id', 'native_control_version'])
      .executeTakeFirstOrThrow()
    const { grant: signalGrant } = await signNativeControlGrant({
      userId: agentId,
      accountId,
      platform: 'signal',
      expectedPlatformAccountExternalId: signalAccount.platform_account_external_id ?? '778899',
      controlVersion: signalAccount.native_control_version,
    }, TEST_JWT_SECRET)
    markMessageDeleted.mockResolvedValue(null)
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(signalGrant),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.deleted', eventId: 'signal-delete',
          platformMessageId: 'signal-sender:1', deletedAt: '2026-08-26T02:00:00.000Z',
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(markMessageDeleted).toHaveBeenCalledWith(
      accountId, 'signal-sender:1', new Date('2026-08-26T02:00:00.000Z'), undefined,
    )
  })

  it('remap 已合并删除内部行时不再发布迟到的幽灵 message', async () => {
    withMessageForPublish.mockResolvedValue(false)
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(200)
    expect(publish).not.toHaveBeenCalled()
  })

  it('temp/final 双行合并后通知客户端重拉规范消息快照', async () => {
    remapMessageId.mockResolvedValue({
      messageId: 'canonical-row', conversationId: 'conversation-1',
      changed: true, removedMessageId: 'removed-row',
    })
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.id-remapped', eventId: 'remap-1',
          oldPlatformMessageId: `${telegramChatId}:temp:telegram-tt:0123456789abcdef0123456789abcdef:1.000001`,
          newPlatformMessageId: canonicalMessageId,
        },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(publish).toHaveBeenCalledWith(agentId, {
      type: 'message_merged', conversationId: 'conversation-1',
      removedMessageId: 'removed-row', canonicalMessageId: 'canonical-row',
    })
  })

  it('跨会话 remap 永久拒绝，避免 guest outbox 无限重试', async () => {
    remapMessageId.mockResolvedValue({
      messageId: 'message-1', conversationId: 'conversation-1',
      changed: false, removedMessageId: null, integrityViolation: 'cross_conversation',
    })
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.id-remapped', eventId: 'remap-cross',
          oldPlatformMessageId: '-100111:1', newPlatformMessageId: '-100222:1',
        },
      },
    })
    expect(response.statusCode).toBe(422)
    expect(remapMessageId).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('拒绝未知协议版本', async () => {
    const event = { ...upsertEvent(), protocolVersion: 99 }
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: nativeAuth(),
      payload: { accountId, event },
    })
    expect(response.statusCode).toBe(400)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })
})
