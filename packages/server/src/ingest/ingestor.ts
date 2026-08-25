import type { Direction, MediaRef, NormalizedMessage, Platform } from '@im-hub/shared'

export interface UpsertConversationInput {
  accountId: string
  platformConversationId: string
  /** 只有入向消息能确定对方是谁；出向消息传 null，由仓储层保持原值不动 */
  contactExternalId: string | null
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

export interface InsertMessageResult {
  id: string
  /** false 表示这条消息此前已入库（平台重复推送 / 调用方重试） */
  isNew: boolean
}

export interface MessageRepo {
  /**
   * 必须是数据库层面的原子 upsert（ON CONFLICT ... RETURNING），
   * 不能是"先查再插"——TDLib 的 update 是并发的，同一会话的两条消息
   * 同时到达时，先查后写会产生两个 conversation 行，消息历史从此一分为二。
   */
  upsertConversation(input: UpsertConversationInput): Promise<{ id: string }>
  insertMessage(input: InsertMessageInput): Promise<InsertMessageResult>
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
    // 出向消息的 sender 是我方账号，不是客户。拿它更新联系人会把会话的对方身份
    // 覆盖成我们自己——员工主动发起的会话更是从第一条起就错。
    const isInbound = msg.direction === 'in'

    const { id: conversationId } = await this.repo.upsertConversation({
      accountId: msg.accountId,
      platformConversationId: msg.platformConversationId,
      contactExternalId: isInbound ? msg.senderExternalId : null,
      // 会话名优先用 conversationDisplayName（群名 / 私聊对方名）。它区分了
      // 会话与发言人——群里不再显示成某个发言人的名字。
      // 出站消息也可能带群名（我方在群里发言），所以不再用 isInbound 卡它。
      contactDisplayName: msg.conversationDisplayName
        ?? (isInbound ? msg.senderDisplayName : null),
    })

    const { id: messageId, isNew } = await this.repo.insertMessage({
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

    // 只有真正的新消息才更新会话时间。重复推送的旧消息若也更新，
    // 会把早已沉底的会话顶到列表最前面。
    if (isNew) {
      await this.repo.touchConversation(conversationId, msg.sentAt)
    }

    // 无论是否新消息都派发翻译任务。这看似浪费，实则是唯一的补偿机制：
    // 队列故障导致首次派发失败时，平台的重复推送或调用方的重试能把它补回来。
    // 代价可控——BullMQ 用 messageId 作 jobId 去重，且相同文本会命中翻译缓存。
    await this.queue.enqueueTranslate({ messageId, conversationId })

    return isNew ? messageId : null
  }
}
