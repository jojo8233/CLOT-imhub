import type {
  AccountStatus, AuthChallengeKind, NormalizedMessage, OutboundContent, Platform,
} from '@im-hub/shared'

export interface AdapterAccount {
  id: string
  displayName: string
  credentialsRef: string | null
}

/**
 * 需要人工干预才能完成的鉴权挑战。
 * qr:       内容直接渲染成二维码给人扫（Telegram 扫码登录、Signal 关联设备、WhatsApp Web）
 * code:     需要把收到的验证码填回来
 * password: 二次验证密码
 *
 * code 和 password 都要等人把答案送回来，走 submitAuthAnswer。
 */
export interface AuthChallenge {
  kind: AuthChallengeKind
  payload: string
  expiresAt?: Date
}

export type MessageHandler = (msg: NormalizedMessage) => void
export type StatusHandler = (accountId: string, status: AccountStatus) => void
export type AuthChallengeHandler = (accountId: string, challenge: AuthChallenge) => void
export type CredentialsHandler = (accountId: string, credentialsRef: string) => void
export type PlatformIdentityHandler = (
  accountId: string,
  platformAccountExternalId: string | null,
) => void

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

/** 平台确认一条消息已从当前账号视图删除时触发。 */
export type MessageDeletedHandler = (
  accountId: string,
  platformMessageId: string,
  deletedAt: Date,
) => void

export type CurrentMessageFetchResult = {
  platformMessageId: string
} & ({
  status: 'found'
  message: NormalizedMessage
} | {
  status: 'unavailable' | 'unsupported'
})

export interface PlatformAdapter {
  readonly platform: Platform
  connect(account: AdapterAccount): Promise<void>
  disconnect(accountId: string): Promise<void>
  sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string>
  /**
   * 精确读取当前平台快照；只允许最终服务端消息 id，不做无界历史遍历。
   * 返回的 message 仍须由组合根以该适配器的真实来源进入 ingest/shadow。
   */
  fetchCurrentMessages?(
    accountId: string,
    platformMessageIds: string[],
  ): Promise<CurrentMessageFetchResult[]>
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

  /** 平台确认的当前登录身份发生变化时通知上层，用于撤销并重新绑定控制能力。 */
  onPlatformIdentityUpdated?(handler: PlatformIdentityHandler): void

  /** 临时消息 id 被平台换成最终 id 时通知上层改写已落库的记录 */
  onMessageIdRemapped(handler: MessageIdRemapHandler): void

  /** 服务端删除事件；纯本地缓存淘汰不能伪装成业务删除。 */
  onMessageDeleted(handler: MessageDeletedHandler): void

  /**
   * 把人工输入的验证码或二次验证密码交回给正在等待的鉴权流程。
   *
   * value 是敏感值：实现方不得写日志、不得落库、不得放进错误信息，
   * 用完立即丢弃。没有流程在等时抛错，不要静默吞掉——那会让前端一直转圈。
   */
  submitAuthAnswer(accountId: string, value: string): Promise<void>

  /**
   * 断开并**彻底清除**本机上该账号的平台数据，删除账号时调用。
   *
   * 必须做到「之后再 connect 需要重新关联」。只删数据库行而留下磁盘上的
   * session，下次就会出现「平台侧还连着、但库里没有对应账号」的幽灵状态——
   * 消息收进来无处安放，只能丢弃。
   *
   * 实现方要吞掉自己的错误还是抛出，取决于失败是否可恢复：清不干净必须抛，
   * 让调用方有机会中止删除，而不是留下一个半删状态。
   */
  purge(accountId: string): Promise<void>
}
