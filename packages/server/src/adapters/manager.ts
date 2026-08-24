import type { OutboundContent, Platform } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  MessageIdRemapHandler,
  PlatformAdapter,
  StatusHandler,
} from './types.js'

/**
 * 逐个调用订阅者，单个失败不影响其余，也绝不向上冒泡。
 *
 * 冒泡的后果不只是丢事件：TDLib 会把 update 回调里的异常转成 client 的
 * error 事件，适配器据此把账号标成 reconnecting——于是一个下游的入库 bug
 * 会表现成"Telegram 账号一直在重连"，极难排查。
 */
function fanOut<A extends unknown[]>(handlers: ((...args: A) => void)[], ...args: A): void {
  for (const h of handlers) {
    try {
      h(...args)
    } catch (err) {
      console.error('[adapter-manager] 事件处理器抛出异常，已隔离:', err)
    }
  }
}

/**
 * 按平台路由的适配器池。上层（ingest / api）只跟它打交道，
 * 加平台时只需在构造时多传一个 adapter，不改任何调用方。
 */
export class AdapterManager {
  private readonly byPlatform = new Map<Platform, PlatformAdapter>()
  private readonly accountPlatform = new Map<string, Platform>()
  private readonly messageHandlers: MessageHandler[] = []
  private readonly statusHandlers: StatusHandler[] = []
  private readonly authChallengeHandlers: AuthChallengeHandler[] = []
  private readonly credentialsHandlers: CredentialsHandler[] = []
  private readonly idRemapHandlers: MessageIdRemapHandler[] = []

  constructor(adapters: PlatformAdapter[]) {
    for (const a of adapters) {
      this.byPlatform.set(a.platform, a)
      a.onMessage(msg => fanOut(this.messageHandlers, msg))
      a.onStatusChange((id, status) => fanOut(this.statusHandlers, id, status))
      a.onAuthChallenge((id, c) => fanOut(this.authChallengeHandlers, id, c))
      a.onCredentialsUpdated((id, ref) => fanOut(this.credentialsHandlers, id, ref))
      a.onMessageIdRemapped((id, oldId, newId) => fanOut(this.idRemapHandlers, id, oldId, newId))
    }
  }

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }
  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }
  onMessageIdRemapped(handler: MessageIdRemapHandler): void { this.idRemapHandlers.push(handler) }

  private require(platform: Platform): PlatformAdapter {
    const adapter = this.byPlatform.get(platform)
    if (!adapter) throw new Error(`no adapter registered for platform ${platform}`)
    return adapter
  }

  async connect(platform: Platform, account: AdapterAccount): Promise<void> {
    const adapter = this.require(platform)
    // 先连上再记映射：连接失败时不能留下"已连接"的假象，
    // 否则后续 send 会打到一个根本没建立的会话上。
    await adapter.connect(account)
    this.accountPlatform.set(account.id, platform)
  }

  async disconnect(accountId: string): Promise<void> {
    const platform = this.accountPlatform.get(accountId)
    if (!platform) return
    await this.require(platform).disconnect(accountId)
    this.accountPlatform.delete(accountId)
  }

  /**
   * 把人工输入的验证码 / 二次验证密码转交给对应适配器。
   *
   * value 是敏感值：这一层不记日志、不做任何缓存，只做转发。
   */
  async submitAuthAnswer(accountId: string, value: string): Promise<void> {
    const platform = this.accountPlatform.get(accountId)
    if (!platform) throw new Error(`account ${accountId} is not connected`)
    await this.require(platform).submitAuthAnswer(accountId, value)
  }

  /**
   * 清除某账号在本机的平台数据。
   *
   * 必须显式传 platform：账号可能从来没 connect 过（建了没扫码就删），
   * 那时内部的 accountId → platform 映射里根本没有它，而恰恰是这种账号
   * 最可能留下半个 session 目录。
   */
  async purge(platform: Platform, accountId: string): Promise<void> {
    await this.require(platform).purge(accountId)
    this.accountPlatform.delete(accountId)
  }

  async send(accountId: string, conversationId: string, content: OutboundContent): Promise<string> {
    const platform = this.accountPlatform.get(accountId)
    if (!platform) throw new Error(`account ${accountId} is not connected`)
    return this.require(platform).sendMessage(accountId, conversationId, content)
  }
}
