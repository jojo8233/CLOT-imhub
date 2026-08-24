import type { AccountStatus, NormalizedMessage, OutboundContent, Platform } from '@im-hub/shared'

export interface AdapterAccount {
  id: string
  displayName: string
  credentialsRef: string | null
}

/**
 * 需要人工干预才能完成的鉴权挑战。
 * qr: 内容直接渲染成二维码给人扫（Signal 的 sgnl://linkdevice、WhatsApp Web 的配对串）
 * code: 需要人工把这串码输入到别处，或把收到的验证码填回来（Telegram 的短信验证码）
 */
export interface AuthChallenge {
  kind: 'qr' | 'code'
  payload: string
  expiresAt?: Date
}

export type MessageHandler = (msg: NormalizedMessage) => void
export type StatusHandler = (accountId: string, status: AccountStatus) => void
export type AuthChallengeHandler = (accountId: string, challenge: AuthChallenge) => void
export type CredentialsHandler = (accountId: string, credentialsRef: string) => void

/**
 * 平台把先前下发的临时消息 id 换成最终 id 时触发。
 *
 * Telegram 和 WhatsApp 都是先本地回显一个临时 id、服务端确认后再换成最终 id。
 * 不处理的话库里存的是临时 id，而这条消息之后经任何其他路径再到达时带的是
 * 最终 id——(account_id, platform_message_id) 去重约束认不出它们是同一条，
 * 于是存成两行。
 */
export type MessageIdRemapHandler = (
  accountId: string,
  oldPlatformMessageId: string,
  newPlatformMessageId: string,
) => void

export interface PlatformAdapter {
  readonly platform: Platform
  connect(account: AdapterAccount): Promise<void>
  disconnect(accountId: string): Promise<void>
  sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string>
  onMessage(handler: MessageHandler): void
  onStatusChange(handler: StatusHandler): void

  /**
   * 平台要求人工完成关联时推出挑战。Signal 的扫码关联和 WhatsApp Web 都靠它，
   * 否则二维码在适配器内部生成后没有任何通道能到达前端。
   * 不需要人工介入的平台注册了也永远不触发，这是可以的。
   */
  onAuthChallenge(handler: AuthChallengeHandler): void

  /**
   * 关联成功后平台产生的新凭据，供上层写回 accounts.credentials_ref。
   * 没有这个通道的话，扫码得到的设备凭据只存在于适配器内存里，进程一重启就丢了。
   */
  onCredentialsUpdated(handler: CredentialsHandler): void

  /** 临时消息 id 被平台换成最终 id 时通知上层改写已落库的记录 */
  onMessageIdRemapped(handler: MessageIdRemapHandler): void
}
