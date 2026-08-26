import type { MediaRef } from './message.js'
import type { Direction } from './platform.js'

export const NATIVE_BRIDGE_PROTOCOL_VERSION = 2 as const
export type NativeBridgeProtocolVersion = typeof NATIVE_BRIDGE_PROTOCOL_VERSION
export const NATIVE_EDIT_VERSION_MAX = 2_147_483_647

/**
 * 平台客户端当前打开的会话。这里全部是平台侧标识；服务端 UUID 由外壳上报后解析，
 * 绝不能把两种 conversationId 混在一个字段里。
 */
export interface NativeConversationContext {
  platformConversationId: string
  contactExternalId: string
  contactDisplayName: string | null
}

interface NativeBridgeFrame {
  protocolVersion: NativeBridgeProtocolVersion
}

interface NativeCommandFrame extends NativeBridgeFrame {
  requestId: string
  /** 会话每次变化都递增；旧 revision 的命令必须被补丁客户端拒绝。 */
  contextRevision: number
  platformConversationId: string
}

export interface NativeSetDraftCommand extends NativeCommandFrame {
  type: 'composer.set-draft'
  text: string
}

export interface NativeGetDraftCommand extends NativeCommandFrame {
  type: 'composer.get-draft'
}

export interface NativeSendCommand extends NativeCommandFrame {
  type: 'composer.send'
  /** 一次逻辑发送的稳定标识；结果未知后的重试必须沿用同一个值。 */
  attemptId: string
}

export type NativeComposerCommand =
  | NativeSetDraftCommand
  | NativeGetDraftCommand
  | NativeSendCommand

export interface NativeEventAckCommand extends NativeBridgeFrame {
  type: 'event.ack'
  eventId: string
  accepted: boolean
  /** true 时补丁客户端应以相同 eventId 重试。 */
  retryable: boolean
}

export type NativeHostCommand = NativeComposerCommand | NativeEventAckCommand

export interface NativeBridgeReadyEvent extends NativeBridgeFrame {
  type: 'bridge.ready'
}

export interface NativeAccountIdentityEvent extends NativeBridgeFrame {
  type: 'account.identity'
  /** 平台稳定账号标识；Telegram 使用当前登录用户的 user id。 */
  platformAccountExternalId: string
}

export interface NativeContextChangedEvent extends NativeBridgeFrame {
  type: 'context.changed'
  contextRevision: number
  context: NativeConversationContext | null
}

export interface NativeComposerStateEvent extends NativeBridgeFrame {
  type: 'composer.state'
  contextRevision: number
  platformConversationId: string
  draft: string
  canSend: boolean
}

export type NativeCommandName = NativeComposerCommand['type']

export interface NativeCommandResultEvent extends NativeBridgeFrame {
  type: 'command.result'
  requestId: string
  command: NativeCommandName
  contextRevision: number
  ok: boolean
  /** composer.send 必须原样回显命令携带的 attemptId。 */
  attemptId?: string
  draft?: string
  platformMessageId?: string
  error?: {
    code: string
    /** 已脱敏，不得包含 token、草稿正文、验证码或 2FA 密码。 */
    message: string
  }
}

export interface NativeBridgeErrorEvent extends NativeBridgeFrame {
  type: 'bridge.error'
  code: string
  /** 已脱敏，不得包含 token、草稿正文、验证码或 2FA 密码。 */
  message: string
}

export interface NativeMessageSnapshot {
  platformConversationId: string
  /**
   * 账号范围内稳定且唯一的规范消息键。若平台原始 message id 只在会话内唯一，
   * guest 必须把规范 conversation/chat id 编入该值；所有接入链路必须使用同一算法。
   */
  platformMessageId: string
  direction: Direction
  senderExternalId: string
  senderDisplayName: string | null
  conversationDisplayName: string | null
  body: string
  mediaRefs: MediaRef[]
  /** 使用与 platformMessageId 相同的账号级规范化算法。 */
  replyToPlatformMessageId: string | null
  sentAt: string
  /** 非 null 表示这是平台确认过的编辑版本。 */
  editedAt: string | null
  /** 平台提供的单调编辑序号；同一条消息只接受更大的版本。 */
  editVersion: number | null
  raw: Record<string, unknown>
}

interface NativeMessageEventFrame extends NativeBridgeFrame {
  /** 补丁客户端生成的幂等事件 id；重试必须沿用原值。 */
  eventId: string
}

export interface NativeMessageUpsertEvent extends NativeMessageEventFrame {
  type: 'message.upsert'
  message: NativeMessageSnapshot
}

export interface NativeMessageDeletedEvent extends NativeMessageEventFrame {
  type: 'message.deleted'
  /** 使用 NativeMessageSnapshot.platformMessageId 的账号级规范键。 */
  platformMessageId: string
  deletedAt: string
}

export interface NativeMessageIdRemappedEvent extends NativeMessageEventFrame {
  type: 'message.id-remapped'
  /** 两端都必须是账号级规范键，且只能表示同一会话中的同一条消息。 */
  oldPlatformMessageId: string
  newPlatformMessageId: string
}

export type NativeGuestEvent =
  | NativeBridgeReadyEvent
  | NativeAccountIdentityEvent
  | NativeContextChangedEvent
  | NativeComposerStateEvent
  | NativeCommandResultEvent
  | NativeBridgeErrorEvent
  | NativeMessageUpsertEvent
  | NativeMessageDeletedEvent
  | NativeMessageIdRemappedEvent
