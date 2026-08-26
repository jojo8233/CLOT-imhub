import type { AccountStatus, Direction, Platform } from './platform.js'

/**
 * 需要人工介入的鉴权挑战类型。
 * qr       扫码关联（Telegram 扫码登录、Signal 关联设备、WhatsApp Web）
 * code     需要把收到的验证码填回来
 * password 二次验证密码
 */
export type AuthChallengeKind = 'qr' | 'code' | 'password'

export interface WsMessageEvent {
  type: 'message'
  messageId: string
  conversationId: string
  accountId: string
  platform: Platform
  direction: Direction
  body: string
  translatedBody: string | null
  sentAt: string
  /** 首次见到的事件也可能已经是编辑版本，不能默认成 initial。 */
  editedAt: string | null
}

export interface WsMessageUpdatedEvent {
  type: 'message_updated'
  messageId: string
  conversationId: string
  body: string
  editedAt: string
  /** worker 若已先完成当前编辑版本，更新事件直接携带已有译文。 */
  translatedBody: string | null
}

export interface WsMessageDeletedEvent {
  type: 'message_deleted'
  messageId: string
  conversationId: string
  deletedAt: string
}

export interface WsMessageMergedEvent {
  type: 'message_merged'
  conversationId: string
  removedMessageId: string
  canonicalMessageId: string
}

export interface WsAccountStatusEvent {
  type: 'account_status'
  accountId: string
  status: AccountStatus
}

export interface WsTranslationEvent {
  type: 'translation'
  messageId: string
  conversationId: string
  targetLang: string
  translatedText: string
  provider: string
  /** `initial` 或 messages.edited_at ISO；客户端据此拒绝迟到的旧正文译文。 */
  revision: string
}

/**
 * 平台要求人工完成关联时推给发起人。
 *
 * 只推给账号的 owner——二维码等价于一次登录授权，扫了就是把账号接进这台机器，
 * 不能广播给同组其他人。
 */
export interface WsAuthChallengeEvent {
  type: 'auth_challenge'
  accountId: string
  kind: AuthChallengeKind
  /**
   * qr：待编码成二维码的链接
   * code：给人看的提示语（验证码发到哪儿了）
   * password：二次验证的密码提示，可能是空串
   */
  payload: string
}

/** 鉴权流程走完（成功或失败）。客户端收到就该把二维码弹窗关掉。 */
export interface WsAuthDoneEvent {
  type: 'auth_done'
  accountId: string
  ok: boolean
  /** ok 为 false 时的失败原因。已脱敏，不含用户输入的任何内容 */
  reason: string | null
}

export type WsServerEvent =
  | WsMessageEvent
  | WsMessageUpdatedEvent
  | WsMessageDeletedEvent
  | WsMessageMergedEvent
  | WsAccountStatusEvent
  | WsTranslationEvent
  | WsAuthChallengeEvent
  | WsAuthDoneEvent
