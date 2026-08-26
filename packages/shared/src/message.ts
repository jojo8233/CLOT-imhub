import type { Direction, Platform } from './platform.js'

export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'file' | 'sticker'
  /** 平台侧的文件标识，用于回源下载；不是 URL，也不是内容哈希 */
  remoteId: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
}

/** 各平台适配器归一化后的统一消息形状。落库前的唯一中间表示。 */
export interface NormalizedMessage {
  platform: Platform
  /** 我们自己的 accounts.id，不是平台侧的账号标识 */
  accountId: string
  platformConversationId: string
  platformMessageId: string
  direction: Direction
  senderExternalId: string
  /** 发这条消息的人的名字。群里是发言人，私聊里就是对方 */
  senderDisplayName: string | null
  /**
   * 这条消息所属**会话**的名字。群会话是群名，私聊是对方的名字。
   *
   * 与 senderDisplayName 分开：群里发言人 ≠ 会话名，混用会让群显示成
   * 某个发言人的名字。拿不到时为 null，由仓储层保持已有值不动。
   */
  conversationDisplayName: string | null
  body: string
  mediaRefs: MediaRef[]
  /** 平台侧被回复消息的 id；没有回复关系时为 null/省略。 */
  replyToPlatformMessageId?: string | null
  /** 平台确认的编辑时间；普通新增消息为 null/省略。 */
  editedAt?: Date | null
  sentAt: Date
  raw: unknown
}

export interface OutboundContent {
  body: string
}
