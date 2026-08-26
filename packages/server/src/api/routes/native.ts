import type { FastifyInstance, FastifyRequest } from 'fastify'
import type {
  NativeMessageDeletedEvent,
  NativeMessageIdRemappedEvent,
  NativeMessageUpsertEvent,
  NormalizedMessage,
  Platform,
  WsServerEvent,
} from '@im-hub/shared'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  NATIVE_EDIT_VERSION_MAX,
  normalizeTelegramChatId,
  parseTelegramMessageKey,
} from '@im-hub/shared'
import { z } from 'zod'
import type { MessageIngestor, UpsertConversationInput } from '../../ingest/ingestor.js'
import type { MessageIdRemapResult, MessagePublicationSnapshot } from '../../ingest/repo.js'

const id = z.string().trim().min(1).max(512)
const timestamp = z.string().datetime({ offset: true })

const contextSchema = z.object({
  platformConversationId: id,
  contactExternalId: id,
  contactDisplayName: z.string().max(512).nullable(),
})

const mediaRefSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'file', 'sticker']),
  remoteId: id,
  fileName: z.string().max(1_024).optional(),
  mimeType: z.string().max(256).optional(),
  sizeBytes: z.number().int().nonnegative().safe().optional(),
})

const messageSnapshotSchema = z.object({
  platformConversationId: id,
  platformMessageId: id,
  direction: z.enum(['in', 'out']),
  senderExternalId: id,
  senderDisplayName: z.string().max(512).nullable(),
  conversationDisplayName: z.string().max(512).nullable(),
  body: z.string().max(1_000_000),
  mediaRefs: z.array(mediaRefSchema).max(64),
  replyToPlatformMessageId: id.nullable(),
  sentAt: timestamp,
  editedAt: timestamp.nullable(),
  editVersion: z.number().int().min(0).max(NATIVE_EDIT_VERSION_MAX).nullable(),
  raw: z.record(z.unknown()),
}).refine(message => message.editVersion === null || message.editedAt !== null, {
  message: 'editVersion requires editedAt',
})

const eventSchema = z.discriminatedUnion('type', [
  z.object({
    protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL_VERSION),
    type: z.literal('message.upsert'),
    eventId: z.string().min(1).max(128),
    message: messageSnapshotSchema,
  }),
  z.object({
    protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL_VERSION),
    type: z.literal('message.deleted'),
    eventId: z.string().min(1).max(128),
    platformMessageId: id,
    deletedAt: timestamp,
  }),
  z.object({
    protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL_VERSION),
    type: z.literal('message.id-remapped'),
    eventId: z.string().min(1).max(128),
    oldPlatformMessageId: id,
    newPlatformMessageId: id,
  }),
])

const contextBody = z.object({ accountId: z.string().uuid(), context: contextSchema })
const eventBody = z.object({ accountId: z.string().uuid(), event: eventSchema })

interface NativeEventRepo {
  upsertConversation(input: UpsertConversationInput): Promise<{ id: string }>
  withMessageForPublish(
    messageId: string,
    action: (message: MessagePublicationSnapshot) => void,
  ): Promise<boolean>
  markMessageDeleted(
    accountId: string,
    platformMessageId: string,
    deletedAt: Date,
  ): Promise<{ messageId: string; conversationId: string; changed: boolean } | null>
  remapMessageId(
    accountId: string,
    oldPlatformMessageId: string,
    newPlatformMessageId: string,
  ): Promise<MessageIdRemapResult | null>
}

export interface NativeRouteDeps {
  ingestor: MessageIngestor
  repo: NativeEventRepo
  publish(userId: string, event: WsServerEvent): void
}

async function requireOwnedNativeAccount(req: FastifyRequest, accountId: string) {
  // “可见”不等于“可以操控平台账号”。auditor/manager 即使能读到该账号，也不能
  // 冒用其本机会话上报消息或驱动发送；M2 按 M0 基线只接受实际 owner。
  if (req.actor.role === 'auditor') return null
  return req.scoped.accounts()
    .select(['accounts.id as id', 'accounts.platform as platform'])
    .where('accounts.id', '=', accountId)
    .where('accounts.owner_user_id', '=', req.actor.userId)
    .executeTakeFirst()
}

export async function nativeRoutes(app: FastifyInstance, deps: NativeRouteDeps): Promise<void> {
  app.post('/api/native/context', async (req, reply) => {
    const parsed = contextBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const account = await requireOwnedNativeAccount(req, parsed.data.accountId)
    if (!account) return reply.code(404).send({ error: 'not found' })
    if (account.platform === 'telegram'
      && !isCanonicalTelegramChatId(parsed.data.context.platformConversationId)) {
      return reply.code(422).send({ error: 'invalid canonical Telegram chat id' })
    }

    const conversation = await deps.repo.upsertConversation({
      accountId: account.id,
      platformConversationId: parsed.data.context.platformConversationId,
      contactExternalId: parsed.data.context.contactExternalId,
      contactDisplayName: parsed.data.context.contactDisplayName,
    })
    return { conversationId: conversation.id }
  })

  app.post('/api/native/events', async (req, reply) => {
    const parsed = eventBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const account = await requireOwnedNativeAccount(req, parsed.data.accountId)
    if (!account) return reply.code(404).send({ error: 'not found' })

    const event = parsed.data.event
    if (account.platform === 'telegram') {
      const canonicalError = validateCanonicalTelegramEvent(event)
      if (canonicalError) return reply.code(422).send({ error: canonicalError })
    }
    if (event.type === 'message.upsert') {
      const result = await ingestNativeMessage(
        deps.ingestor,
        account.id,
        account.platform,
        event,
        async stored => {
          // 并发 temp/final upsert 可能在本请求 touch 期间已被 remap 合并。发布前
          // 在 share lock 内发布，保证 remap 的 merge 事件不可能先到后又冒出幽灵消息。
          await deps.repo.withMessageForPublish(stored.messageId, message => {
            if (message.deletedAt) return
            if (stored.isNew || !event.message.editedAt) {
              // 首次请求可能在消息提交后、WS 发布前失败。无 edit revision 的
              // outbox 重试仍重发规范 message；客户端按内部 messageId 去重。
              deps.publish(req.actor.userId, {
                type: 'message',
                messageId: message.id,
                conversationId: message.conversationId,
                accountId: message.accountId,
                platform: message.platform,
                direction: message.direction,
                body: message.body,
                translatedBody: message.translatedBody,
                sentAt: message.sentAt.toISOString(),
                editedAt: message.editedAt?.toISOString() ?? null,
              })
            } else if (sameEditRevision(message, event)) {
              // 不只看本次 contentChanged：首次编辑已落库但在发布前失败时，
              // 同 revision 重试必须重发规范快照，否则客户端会永久留在旧正文。
              if (!message.editedAt) return
              deps.publish(req.actor.userId, {
                type: 'message_updated',
                messageId: message.id,
                conversationId: message.conversationId,
                body: message.body,
                editedAt: message.editedAt.toISOString(),
                translatedBody: message.translatedBody,
              })
            }
          })
        },
      )
      return { accepted: true, duplicate: !result.isNew && !result.contentChanged }
    }

    if (event.type === 'message.deleted') {
      const result = await deleteNativeMessage(deps.repo, account.id, event)
      if (!result) return reply.code(409).send({ error: 'message not found; retry event after upsert' })
      if (result.changed) {
        deps.publish(req.actor.userId, {
          type: 'message_deleted',
          messageId: result.messageId,
          conversationId: result.conversationId,
          deletedAt: event.deletedAt,
        })
      }
      return { accepted: true, duplicate: !result.changed }
    }

    const result = await remapNativeMessage(deps.repo, account.id, event)
    if (!result) return reply.code(409).send({ error: 'message not found; retry event after upsert' })
    if (result.integrityViolation === 'cross_conversation') {
      return reply.code(422).send({ error: 'message remap crosses conversations' })
    }
    if (result.removedMessageId) {
      deps.publish(req.actor.userId, {
        type: 'message_merged',
        conversationId: result.conversationId,
        removedMessageId: result.removedMessageId,
        canonicalMessageId: result.messageId,
      })
    }
    return { accepted: true, duplicate: !result.changed }
  })
}

async function ingestNativeMessage(
  ingestor: MessageIngestor,
  accountId: string,
  platform: Platform,
  event: NativeMessageUpsertEvent,
  onStored: (result: Awaited<ReturnType<MessageIngestor['ingestDetailed']>>) => void | Promise<void>,
) {
  const message: NormalizedMessage = {
    platform,
    accountId,
    platformConversationId: event.message.platformConversationId,
    platformMessageId: event.message.platformMessageId,
    direction: event.message.direction,
    senderExternalId: event.message.senderExternalId,
    senderDisplayName: event.message.senderDisplayName,
    conversationDisplayName: event.message.conversationDisplayName,
    body: event.message.body,
    mediaRefs: event.message.mediaRefs,
    replyToPlatformMessageId: event.message.replyToPlatformMessageId,
    editedAt: event.message.editedAt ? new Date(event.message.editedAt) : null,
    editVersion: event.message.editVersion,
    sentAt: new Date(event.message.sentAt),
    raw: event.message.raw,
  }
  return ingestor.ingestDetailed(message, onStored)
}

function deleteNativeMessage(repo: NativeEventRepo, accountId: string, event: NativeMessageDeletedEvent) {
  return repo.markMessageDeleted(accountId, event.platformMessageId, new Date(event.deletedAt))
}

function remapNativeMessage(repo: NativeEventRepo, accountId: string, event: NativeMessageIdRemappedEvent) {
  return repo.remapMessageId(accountId, event.oldPlatformMessageId, event.newPlatformMessageId)
}

function isCanonicalTelegramChatId(chatId: string): boolean {
  try {
    return normalizeTelegramChatId(chatId) === chatId
  } catch {
    return false
  }
}

function validateCanonicalTelegramEvent(
  event: NativeMessageUpsertEvent | NativeMessageDeletedEvent | NativeMessageIdRemappedEvent,
): string | null {
  if (event.type === 'message.upsert') {
    if (!isCanonicalTelegramChatId(event.message.platformConversationId)) {
      return 'invalid canonical Telegram chat id'
    }
    const message = parseTelegramMessageKey(event.message.platformMessageId)
    if (!message || message.chatId !== event.message.platformConversationId) {
      return 'Telegram message id does not match its chat id'
    }
    if (event.message.replyToPlatformMessageId) {
      const reply = parseTelegramMessageKey(event.message.replyToPlatformMessageId)
      if (!reply || reply.chatId !== message.chatId) {
        return 'Telegram reply id does not match its chat id'
      }
    }
    return null
  }

  if (event.type === 'message.deleted') {
    return parseTelegramMessageKey(event.platformMessageId)
      ? null
      : 'invalid canonical Telegram message id'
  }

  const oldMessage = parseTelegramMessageKey(event.oldPlatformMessageId)
  const newMessage = parseTelegramMessageKey(event.newPlatformMessageId)
  if (!oldMessage || !newMessage) return 'invalid canonical Telegram message id'
  return oldMessage.chatId === newMessage.chatId
    ? null
    : 'Telegram message remap crosses chats'
}

function sameEditRevision(
  message: MessagePublicationSnapshot,
  event: NativeMessageUpsertEvent,
): boolean {
  if (event.message.editVersion !== null) {
    return message.editVersion === event.message.editVersion
  }
  return message.editVersion === null
    && message.editedAt !== null
    && event.message.editedAt !== null
    && message.editedAt.toISOString() === new Date(event.message.editedAt).toISOString()
}
