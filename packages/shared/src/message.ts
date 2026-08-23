import type { Direction, Platform } from './platform.js'

export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'file'
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
  senderDisplayName: string | null
  body: string
  mediaRefs: MediaRef[]
  sentAt: Date
  raw: unknown
}

export interface OutboundContent {
  body: string
}
