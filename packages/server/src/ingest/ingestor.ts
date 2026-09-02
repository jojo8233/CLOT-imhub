import type { Direction, MediaRef, NormalizedMessage, Platform } from '@im-hub/shared'
import {
  buildTelegramUpsertObservation,
  type TelegramShadowObservation,
  type TelegramShadowSource,
} from '../shadow/telegram.js'

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
  replyToPlatformMessageId: string | null
  editedAt: Date | null
  editVersion: number | null
  sentAt: Date
  raw: unknown
  shadowObservation?: TelegramShadowObservation
}

export interface InsertMessageResult {
  id: string
  /** false 表示这条消息此前已入库（平台重复推送 / 调用方重试） */
  isNew: boolean
  /** true 表示平台确认的编辑版本更新了既有消息。 */
  contentChanged: boolean
}

export interface IngestMessageResult {
  conversationId: string
  messageId: string
  isNew: boolean
  contentChanged: boolean
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
  enqueueTranslate(job: { messageId: string; conversationId: string; revision?: string }): Promise<void>
}

export function messageRevision(editVersion: number | null, editedAt: Date | null): string {
  return editVersion === null
    ? editedAt?.toISOString() ?? 'initial'
    : `version:${editVersion}`
}

/**
 * 归一化消息进入业务系统的唯一入口，四个平台最终都汇到这里。
 *
 * 不直接依赖 db 单例：通过构造函数接收 repo 和 queue，
 * 这样单元测试不需要真实的 Postgres 和 Redis。
 */
export class MessageIngestor {
  constructor(private readonly repo: MessageRepo, private readonly queue: TranslateQueue) {}

  async ingestDetailed(
    msg: NormalizedMessage,
    /** 在翻译任务可被 worker 消费前发布 message/message_updated，避免译文事件先到。 */
    onStored?: (result: IngestMessageResult) => void | Promise<void>,
    shadowSource?: TelegramShadowSource,
  ): Promise<IngestMessageResult> {
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

    const { id: messageId, isNew, contentChanged } = await this.repo.insertMessage({
      conversationId,
      accountId: msg.accountId,
      platform: msg.platform,
      platformMessageId: msg.platformMessageId,
      direction: msg.direction,
      senderExternalId: msg.senderExternalId,
      body: msg.body,
      mediaRefs: msg.mediaRefs,
      replyToPlatformMessageId: msg.replyToPlatformMessageId ?? null,
      editedAt: msg.editedAt ?? null,
      editVersion: msg.editVersion ?? null,
      sentAt: msg.sentAt,
      raw: msg.raw,
      shadowObservation: shadowSource && msg.platform === 'telegram'
        ? buildTelegramUpsertObservation(shadowSource, msg)
        : undefined,
    })

    // repo 用 greatest 保证时间只前进。重复推送也 touch，既不会把旧会话顶上来，
    // 又能补偿首次消息已落库但 touch 暂时失败的情况。
    await this.repo.touchConversation(conversationId, msg.sentAt)

    const result = { messageId, conversationId, isNew, contentChanged }
    await onStored?.(result)

    // 无论是否新消息都派发翻译任务。这看似浪费，实则是唯一的补偿机制：
    // 队列故障导致首次派发失败时，平台的重复推送或调用方的重试能把它补回来。
    // 代价可控——BullMQ 用 messageId 作 jobId 去重，且相同文本会命中翻译缓存。
    // 纯媒体消息没有可翻译文本。空正文仍然正常存档，但不制造必然失败的翻译任务。
    const shouldTranslate = isInbound || (msg.platform === 'signal' && msg.direction === 'out')
    if (shouldTranslate && msg.body.trim() !== '') {
      await this.queue.enqueueTranslate({
        messageId,
        conversationId,
        revision: messageRevision(msg.editVersion ?? null, msg.editedAt ?? null),
      })
    }

    return result
  }

  /** 保持旧适配器契约：只有首次新增返回 id；重复与编辑不冒充新消息。 */
  async ingest(msg: NormalizedMessage): Promise<string | null> {
    const result = await this.ingestDetailed(msg)
    return result.isNew ? result.messageId : null
  }
}
