import type { Direction, MediaRef, NormalizedMessage, Platform } from '@im-hub/shared'

export interface UpsertConversationInput {
  accountId: string
  platformConversationId: string
  contactExternalId: string
  contactDisplayName: string | null
}

export interface InsertMessageInput {
  conversationId: string
  accountId: string
  platform: Platform
  platformMessageId: string
  direction: Direction
  senderExternalId: string
  body: string
  mediaRefs: MediaRef[]
  sentAt: Date
  raw: unknown
}

export interface MessageRepo {
  upsertConversation(input: UpsertConversationInput): Promise<string>
  /** 已存在（account_id + platform_message_id 冲突）时返回 null，用于去重 */
  insertMessage(input: InsertMessageInput): Promise<string | null>
  touchConversation(conversationId: string, at: Date): Promise<void>
}

export interface TranslateQueue {
  enqueueTranslate(job: { messageId: string; conversationId: string }): Promise<void>
}

/**
 * 归一化消息进入业务系统的唯一入口，四个平台最终都汇到这里。
 *
 * 不直接依赖 db 单例：通过构造函数接收 repo 和 queue，
 * 这样单元测试不需要真实的 Postgres 和 Redis。
 */
export class MessageIngestor {
  constructor(private readonly repo: MessageRepo, private readonly queue: TranslateQueue) {}

  /** 返回新消息 id；重复消息返回 null。 */
  async ingest(msg: NormalizedMessage): Promise<string | null> {
    const conversationId = await this.repo.upsertConversation({
      accountId: msg.accountId,
      platformConversationId: msg.platformConversationId,
      contactExternalId: msg.senderExternalId,
      contactDisplayName: msg.senderDisplayName,
    })

    const messageId = await this.repo.insertMessage({
      conversationId,
      accountId: msg.accountId,
      platform: msg.platform,
      platformMessageId: msg.platformMessageId,
      direction: msg.direction,
      senderExternalId: msg.senderExternalId,
      body: msg.body,
      mediaRefs: msg.mediaRefs,
      sentAt: msg.sentAt,
      raw: msg.raw,
    })

    // 去重：数据库靠 (account_id, platform_message_id) 唯一约束挡下重复插入，
    // 这里必须提前返回——否则平台重连补发的旧消息会被重复翻译（白花钱），
    // 还会把 last_message_at 顶到最新、让旧会话莫名跳到列表最前面。
    if (!messageId) return null

    await this.repo.touchConversation(conversationId, msg.sentAt)
    await this.queue.enqueueTranslate({ messageId, conversationId })
    return messageId
  }
}
