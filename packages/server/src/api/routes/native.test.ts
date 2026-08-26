import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { NATIVE_BRIDGE_PROTOCOL_VERSION, type Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import type { MessagePublicationSnapshot } from '../../ingest/repo.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'native-route-test-secret-32-chars'

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
    display_name: 'Native TG', status: 'connected',
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
    deletedAt: null,
  }

  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer({
    adapters: {} as never,
    gateway: {} as never,
    native: {
      ingestor: { ingestDetailed } as never,
      repo: { upsertConversation, withMessageForPublish, markMessageDeleted, remapMessageId },
      publish,
    },
  }, new (await import('../ws.js')).WsHub(), { actorRepo: actorRepo() })
  agentToken = await signSession({ userId: agentId }, process.env.JWT_SECRET!)
  managerToken = await signSession({ userId: managerId }, process.env.JWT_SECRET!)
  auditorToken = await signSession({ userId: auditorId }, process.env.JWT_SECRET!)
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

const context = {
  platformConversationId: 'chat-1', contactExternalId: 'contact-1', contactDisplayName: 'Jane',
}

function upsertEvent() {
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId: 'event-1',
    message: {
      platformConversationId: 'chat-1', platformMessageId: 'message-1', direction: 'in',
      senderExternalId: 'contact-1', senderDisplayName: 'Jane', conversationDisplayName: 'Jane',
      body: 'hello', mediaRefs: [], replyToPlatformMessageId: null,
      sentAt: '2026-08-26T00:00:00.000Z', editedAt: null, raw: {},
    },
  }
}

describe('native bridge routes', () => {
  it('账号归属人可以把平台会话解析成内部 UUID', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: auth(agentToken),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(200)
    expect(upsertConversation).toHaveBeenCalledWith({ accountId, ...context })
  })

  it('manager 虽然能看见组员账号，也不能冒用原生桥接', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/context', headers: auth(managerToken),
      payload: { accountId, context },
    })
    expect(response.statusCode).toBe(404)
    expect(upsertConversation).not.toHaveBeenCalled()
  })

  it('全局只读 auditor 不能上报消息', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(auditorToken),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(404)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })

  it('auditor 即使是账号 owner 也不能驱动原生桥接', async () => {
    await db.updateTable('accounts')
      .set({ owner_user_id: auditorId })
      .where('id', '=', accountId)
      .execute()
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(auditorToken),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(404)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })

  it('消息 platform 和 accountId 只取服务端已校验账号', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(200)
    expect(ingestDetailed).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'telegram', accountId, platformMessageId: 'message-1' }),
      expect.any(Function),
    )
    expect(publish).toHaveBeenCalledWith(agentId, expect.objectContaining({ type: 'message' }))
  })

  it('首次见到的编辑版本在 message 事件中保留 editedAt revision', async () => {
    const base = upsertEvent()
    const event = {
      ...base,
      message: { ...base.message, editedAt: '2026-08-26T08:00:00+07:00' },
    }
    publicationSnapshot = {
      ...publicationSnapshot,
      body: 'canonical edited body',
      translatedBody: '规范译文',
      editedAt: new Date('2026-08-26T01:00:00.000Z'),
    }
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
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
    }
    const base = upsertEvent()
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: {
        accountId,
        event: {
          ...base,
          message: { ...base.message, body: 'edited body', editedAt: '2026-08-26T01:00:00Z' },
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
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: { accountId, event: upsertEvent() },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ accepted: true, duplicate: true })
    expect(publish).toHaveBeenCalledWith(agentId, expect.objectContaining({
      type: 'message', messageId: 'message-1', body: 'hello',
    }))
  })

  it('remap 已合并删除内部行时不再发布迟到的幽灵 message', async () => {
    withMessageForPublish.mockResolvedValue(false)
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
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
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.id-remapped', eventId: 'remap-1',
          oldPlatformMessageId: 'temp-1', newPlatformMessageId: 'final-1',
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
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: {
        accountId,
        event: {
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'message.id-remapped', eventId: 'remap-cross',
          oldPlatformMessageId: 'chat-a:1', newPlatformMessageId: 'chat-b:1',
        },
      },
    })
    expect(response.statusCode).toBe(422)
    expect(publish).not.toHaveBeenCalled()
  })

  it('拒绝未知协议版本', async () => {
    const event = { ...upsertEvent(), protocolVersion: 99 }
    const response = await app.inject({
      method: 'POST', url: '/api/native/events', headers: auth(agentToken),
      payload: { accountId, event },
    })
    expect(response.statusCode).toBe(400)
    expect(ingestDetailed).not.toHaveBeenCalled()
  })
})
