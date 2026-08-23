import type { OutboundContent, Platform } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  PlatformAdapter,
  StatusHandler,
} from './types.js'

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

  constructor(adapters: PlatformAdapter[]) {
    for (const a of adapters) {
      this.byPlatform.set(a.platform, a)
      a.onMessage(msg => { for (const h of this.messageHandlers) h(msg) })
      a.onStatusChange((id, status) => { for (const h of this.statusHandlers) h(id, status) })
      a.onAuthChallenge((id, c) => { for (const h of this.authChallengeHandlers) h(id, c) })
      a.onCredentialsUpdated((id, ref) => { for (const h of this.credentialsHandlers) h(id, ref) })
    }
  }

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }
  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }

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

  async send(accountId: string, conversationId: string, content: OutboundContent): Promise<string> {
    const platform = this.accountPlatform.get(accountId)
    if (!platform) throw new Error(`account ${accountId} is not connected`)
    return this.require(platform).sendMessage(accountId, conversationId, content)
  }
}
