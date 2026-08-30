import type { FastifyInstance } from 'fastify'
import type {
  NativeMessageDeletedEvent,
  NativeMessageIdRemappedEvent,
  NativeMessageReactionEvent,
  NativeMessageUpsertEvent,
  NormalizedMessage,
  Platform,
  WsServerEvent,
} from '@im-hub/shared'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  NATIVE_EDIT_VERSION_MAX,
  isSignalConversationId,
  normalizeSignalPersonId,
  normalizeTelegramChatId,
  parseSignalMessageKey,
  parseTelegramMessageKey,
  signalDirectConversationId,
  signalMessageKey,
} from '@im-hub/shared'
import { z } from 'zod'
import type { MessageIngestor, UpsertConversationInput } from '../../ingest/ingestor.js'
import type {
  MessageIdRemapResult,
  MessagePublicationSnapshot,
  MessageReactionUpsertResult,
} from '../../ingest/repo.js'
import {
  buildTelegramDeleteObservation,
  buildTelegramRemapObservation,
  type TelegramShadowObservation,
} from '../../shadow/telegram.js'
import { authorizeNativeControl } from '../native-control.js'

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
  z.object({
    protocolVersion: z.literal(NATIVE_BRIDGE_PROTOCOL_VERSION),
    type: z.literal('message.reaction'),
    eventId: z.string().min(1).max(128),
    targetPlatformMessageId: id,
    reactorExternalId: id,
    emoji: z.string().min(1).max(64).nullable(),
    reactedAt: timestamp,
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
    shadowObservation?: TelegramShadowObservation,
  ): Promise<{ messageId: string; conversationId: string; changed: boolean } | null>
  remapMessageId(
    accountId: string,
    oldPlatformMessageId: string,
    newPlatformMessageId: string,
    shadowObservation?: TelegramShadowObservation,
  ): Promise<MessageIdRemapResult | null>
  upsertMessageReaction(
    accountId: string,
    platformMessageId: string,
    reactorExternalId: string,
    emoji: string | null,
    reactedAt: Date,
  ): Promise<MessageReactionUpsertResult>
}

export interface NativeRouteDeps {
  ingestor: MessageIngestor
  repo: NativeEventRepo
  publish(userId: string, event: WsServerEvent): void
}

export async function nativeRoutes(app: FastifyInstance, deps: NativeRouteDeps): Promise<void> {
  app.post('/api/native/context', async (req, reply) => {
    const parsed = contextBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const account = await authorizeNativeRequest(req.headers.authorization, parsed.data.accountId)
    if (!account) return reply.code(401).send({ error: 'native control unavailable' })
    if (account.platform === 'telegram'
      && !isCanonicalTelegramChatId(parsed.data.context.platformConversationId)) {
      return reply.code(422).send({ error: 'invalid canonical Telegram chat id' })
    }
    if (account.platform === 'signal') {
      const canonicalError = validateCanonicalSignalContext(parsed.data.context)
      if (canonicalError) return reply.code(422).send({ error: canonicalError })
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

    const account = await authorizeNativeRequest(req.headers.authorization, parsed.data.accountId)
    if (!account) return reply.code(401).send({ error: 'native control unavailable' })

    const event = parsed.data.event
    if (account.platform === 'telegram') {
      const canonicalError = validateCanonicalTelegramEvent(event)
      if (canonicalError) return reply.code(422).send({ error: canonicalError })
    } else if (account.platform === 'signal') {
      const canonicalError = validateCanonicalSignalEvent(event)
      if (canonicalError) return reply.code(422).send({ error: canonicalError })
      if (event.type === 'message.reaction'
        && event.reactorExternalId === account.expectedPlatformAccountExternalId) {
        return reply.code(422).send({ error: 'Signal native bridge only accepts inbound reactions' })
      }
    } else if (event.type === 'message.reaction') {
      return reply.code(422).send({ error: 'native message reactions are not supported for this platform' })
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
              deps.publish(account.userId, {
                type: 'message',
                messageId: message.id,
                platformMessageId: message.platformMessageId,
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
              deps.publish(account.userId, {
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
      const result = await deleteNativeMessage(deps.repo, account.id, account.platform, event)
      // 删除是幂等的状态事实；中央库没有该消息时，目标状态已经成立。
      if (!result) return { accepted: true, duplicate: true }
      if (result.changed) {
        deps.publish(account.userId, {
          type: 'message_deleted',
          messageId: result.messageId,
          conversationId: result.conversationId,
          deletedAt: event.deletedAt,
        })
      }
      return { accepted: true, duplicate: !result.changed }
    }

    if (event.type === 'message.reaction') {
      const result = await deps.repo.upsertMessageReaction(
        account.id,
        event.targetPlatformMessageId,
        event.reactorExternalId,
        event.emoji,
        new Date(event.reactedAt),
      )
      return { accepted: true, duplicate: !result.changed }
    }

    const result = await remapNativeMessage(deps.repo, account.id, account.platform, event)
    // outbox 保证同一消息的 temp upsert 先于 remap。两端都不存在说明没有待合并行，
    // 后续 final upsert 可直接以规范键落库，因此该重放是已完成的 no-op。
    if (!result) return { accepted: true, duplicate: true }
    if (result.integrityViolation === 'cross_conversation') {
      return reply.code(422).send({ error: 'message remap crosses conversations' })
    }
    if (result.removedMessageId) {
      deps.publish(account.userId, {
        type: 'message_merged',
        conversationId: result.conversationId,
        removedMessageId: result.removedMessageId,
        canonicalMessageId: result.messageId,
      })
    }
    return { accepted: true, duplicate: !result.changed }
  })
}

async function authorizeNativeRequest(authorization: string | undefined, accountId: string) {
  try {
    return await authorizeNativeControl(authorization, accountId)
  } catch {
    return null
  }
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
  return ingestor.ingestDetailed(
    message,
    onStored,
    platform === 'telegram' ? 'telegram-tt' : undefined,
  )
}

function deleteNativeMessage(
  repo: NativeEventRepo,
  accountId: string,
  platform: Platform,
  event: NativeMessageDeletedEvent,
) {
  return repo.markMessageDeleted(
    accountId,
    event.platformMessageId,
    new Date(event.deletedAt),
    platform === 'telegram'
      ? buildTelegramDeleteObservation(accountId, 'telegram-tt', event.platformMessageId)
      : undefined,
  )
}

function remapNativeMessage(
  repo: NativeEventRepo,
  accountId: string,
  platform: Platform,
  event: NativeMessageIdRemappedEvent,
) {
  return repo.remapMessageId(
    accountId,
    event.oldPlatformMessageId,
    event.newPlatformMessageId,
    platform === 'telegram'
      ? buildTelegramRemapObservation(
          accountId,
          'telegram-tt',
          event.oldPlatformMessageId,
          event.newPlatformMessageId,
        )
      : undefined,
  )
}

function isCanonicalTelegramChatId(chatId: string): boolean {
  try {
    return normalizeTelegramChatId(chatId) === chatId
  } catch {
    return false
  }
}

function validateCanonicalSignalContext(context: z.infer<typeof contextSchema>): string | null {
  if (!isSignalConversationId(context.platformConversationId)) {
    return 'invalid canonical Signal conversation id'
  }
  if (context.platformConversationId.startsWith('g:')) {
    return context.contactExternalId === context.platformConversationId
      ? null
      : 'Signal group context contact does not match conversation id'
  }
  try {
    return signalDirectConversationId(context.contactExternalId) === context.platformConversationId
      ? null
      : 'Signal direct context contact does not match conversation id'
  } catch {
    return 'invalid canonical Signal context contact id'
  }
}

function validateCanonicalTelegramEvent(
  event: NativeMessageUpsertEvent | NativeMessageDeletedEvent
    | NativeMessageIdRemappedEvent | NativeMessageReactionEvent,
): string | null {
  if (event.type === 'message.reaction') {
    return 'Telegram native reactions are not supported'
  }
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

function validateCanonicalSignalEvent(
  event: NativeMessageUpsertEvent | NativeMessageDeletedEvent
    | NativeMessageIdRemappedEvent | NativeMessageReactionEvent,
): string | null {
  if (event.type === 'message.id-remapped') {
    return 'Signal message ids cannot be remapped'
  }
  if (event.type === 'message.deleted') {
    return parseSignalMessageKey(event.platformMessageId)
      ? null
      : 'invalid canonical Signal message id'
  }
  if (event.type === 'message.reaction') {
    if (!parseSignalMessageKey(event.targetPlatformMessageId)) {
      return 'invalid canonical Signal reaction target id'
    }
    try {
      return normalizeSignalPersonId(event.reactorExternalId) === event.reactorExternalId
        ? null
        : 'invalid canonical Signal reactor id'
    } catch {
      return 'invalid canonical Signal reactor id'
    }
  }

  const { message } = event
  if (!isSignalConversationId(message.platformConversationId)) {
    return 'invalid canonical Signal conversation id'
  }
  let expectedMessageId: string
  try {
    expectedMessageId = signalMessageKey(
      message.senderExternalId,
      new Date(message.sentAt).getTime(),
    )
  } catch {
    return 'invalid canonical Signal message id'
  }
  if (message.platformMessageId !== expectedMessageId) {
    return 'Signal message id does not match sender and sent time'
  }
  if (message.platformConversationId.startsWith('u:')
    && message.direction === 'in'
    && message.platformConversationId !== signalDirectConversationId(message.senderExternalId)) {
    return 'Signal direct conversation does not match inbound sender'
  }
  if (message.replyToPlatformMessageId
    && !parseSignalMessageKey(message.replyToPlatformMessageId)) {
    return 'invalid canonical Signal reply id'
  }
  return null
}
