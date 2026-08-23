import type { Direction, Platform } from './platform.js'

export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'file'
  remoteId: string
  fileName?: string
  mimeType?: string
  sizeBytes?: number
}

/** 各平台适配器归一化后的统一消息形状。落库前的唯一中间表示。 */
export interface NormalizedMessage {
  platform: Platform
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
