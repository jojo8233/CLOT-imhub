import type { MediaRef } from './message.js'
import type { Direction } from './platform.js'

export const NATIVE_BRIDGE_PROTOCOL_VERSION = 3 as const
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
  /** Signal attempt 首次建立时的 revision；重启查询时仍保持原值。 */
  attemptContextRevision?: number
  /**
   * 最终原生草稿的 SHA-256 十六进制指纹。Signal 用它把正文与 attempt 绑定；
   * Telegram v3 guest 不依赖该可选字段。
   */
  draftFingerprint?: string
}

export type NativeComposerCommand =
  | NativeSetDraftCommand
  | NativeGetDraftCommand
  | NativeSendCommand

/** 主进程完成账号授权后要求 guest 重发当前会话与输入框事实。 */
export interface NativeRequestStateCommand extends NativeBridgeFrame {
  type: 'bridge.request-state'
}

export interface NativeEventAckCommand extends NativeBridgeFrame {
  type: 'event.ack'
  eventId: string
  accepted: boolean
  /** true 时补丁客户端应以相同 eventId 重试。 */
  retryable: boolean
}

/** Signal 最终消息结果已经由外壳提交后，才允许 guest 清理持久 attempt。 */
export interface NativeSendAttemptAckCommand extends NativeBridgeFrame {
  type: 'composer.ack-send'
  attemptId: string
  platformMessageId: string
}

/** 运维动作只操作 guest 当前已认证账号的持久队列，不向宿主暴露事件正文。 */
export interface NativeOutboxRetryDeadLettersCommand extends NativeBridgeFrame {
  type: 'outbox.retry-dead-letters'
}

export interface NativeOutboxDiscardDeadLettersCommand extends NativeBridgeFrame {
  type: 'outbox.discard-dead-letters'
}

export type NativeOutboxOperationCommand =
  | NativeOutboxRetryDeadLettersCommand
  | NativeOutboxDiscardDeadLettersCommand

export interface NativeMessageTranslation {
  /** Signal 的 sender + sent_at 规范键；不得替换成本地数据库消息 id。 */
  platformMessageId: string
  translatedText: string
  /** `initial` 或 Signal editMessageTimestamp 的 ISO 字符串。 */
  revision: string
}

/**
 * 中央译文快照批量回填给补丁客户端。批量而非逐条命令，避免每条消息都重新
 * 请求一次短时 control grant 校验；guest 仍须逐条复核规范消息键与 revision。
 */
export interface NativeSetMessageTranslationsCommand extends NativeBridgeFrame {
  type: 'message.set-translations'
  translations: NativeMessageTranslation[]
}

export type NativeHostCommand =
  | NativeComposerCommand
  | NativeSendAttemptAckCommand
  | NativeEventAckCommand
  | NativeRequestStateCommand
  | NativeOutboxOperationCommand
  | NativeSetMessageTranslationsCommand

export interface NativeBridgeReadyEvent extends NativeBridgeFrame {
  type: 'bridge.ready'
}

export interface NativeAccountIdentityEvent extends NativeBridgeFrame {
  type: 'account.identity'
  /** 平台稳定账号标识；Telegram 使用当前登录用户的 user id。 */
  platformAccountExternalId: string
}

export interface NativeAccountSignedOutEvent extends NativeBridgeFrame {
  type: 'account.signed-out'
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
  /** Signal 进程重启或结果丢失后，外壳可用同一 attempt 查询或续接。 */
  sendAttempt?: {
    attemptId: string
    /** attempt 首次建立时的会话 revision；重启后的查询不能改写它。 */
    contextRevision: number
    draftFingerprint: string
    /** 非 null 表示 Signal 已确认最终消息 ID，但外壳尚未 ACK。 */
    platformMessageId: string | null
  }
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

/** guest 持久事件队列的有界运行指标；不包含消息正文或账号凭据。 */
export interface NativeOutboxStatusEvent extends NativeBridgeFrame {
  type: 'outbox.status'
  pendingCount: number
  deadLetterCount: number
  isSending: boolean
  lastErrorCode: string | null
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

/**
 * 平台侧某个参与者对消息的当前回应状态。emoji=null 是删除回应的墓碑；服务端按
 * (account, target, reactor) 唯一保存，并只接受更晚的 reactedAt。
 */
export interface NativeMessageReactionEvent extends NativeMessageEventFrame {
  type: 'message.reaction'
  targetPlatformMessageId: string
  reactorExternalId: string
  emoji: string | null
  reactedAt: string
}

export type NativeGuestEvent =
  | NativeBridgeReadyEvent
  | NativeAccountIdentityEvent
  | NativeAccountSignedOutEvent
  | NativeContextChangedEvent
  | NativeComposerStateEvent
  | NativeCommandResultEvent
  | NativeBridgeErrorEvent
  | NativeOutboxStatusEvent
  | NativeMessageUpsertEvent
  | NativeMessageDeletedEvent
  | NativeMessageIdRemappedEvent
  | NativeMessageReactionEvent
