import type { AccountStatus, OutboundContent } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageDeletedHandler,
  MessageHandler,
  MessageIdRemapHandler,
  PlatformAdapter,
  StatusHandler,
} from '../types.js'

/**
 * WhatsApp Web shell adapter.
 *
 * Authentication and interaction happen inside the owner's isolated Electron
 * partition. This server-side adapter is retained for historical adapter accounts
 * only. It deliberately does not scrape the official page, invent credentials,
 * or claim that native events are already available. The planned unified message
 * route is a separate WhatsApp Business Platform Cloud API account.
 */
export class WhatsAppWebAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const

  private readonly statusHandlers: StatusHandler[] = []

  onMessage(_handler: MessageHandler): void { /* M6 bridge checkpoint */ }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }
  onAuthChallenge(_handler: AuthChallengeHandler): void { /* QR is rendered by WhatsApp Web */ }
  onCredentialsUpdated(_handler: CredentialsHandler): void { /* browser session owns credentials */ }
  onMessageIdRemapped(_handler: MessageIdRemapHandler): void { /* M6 bridge checkpoint */ }
  onMessageDeleted(_handler: MessageDeletedHandler): void { /* M6 bridge checkpoint */ }

  async connect(account: AdapterAccount): Promise<void> {
    this.emitStatus(account.id, 'pending_auth')
  }

  async disconnect(accountId: string): Promise<void> {
    this.emitStatus(accountId, 'disconnected')
  }

  async purge(accountId: string): Promise<void> {
    await this.disconnect(accountId)
  }

  async sendMessage(
    _accountId: string,
    _conversationId: string,
    _content: OutboundContent,
  ): Promise<string> {
    throw new Error('WhatsApp Web messages must be sent from the isolated native client')
  }

  async submitAuthAnswer(_accountId: string, _value: string): Promise<void> {
    throw new Error('WhatsApp Web authentication is completed inside the native client')
  }

  private emitStatus(accountId: string, status: AccountStatus): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(accountId, status)
      } catch (err) {
        console.error(`[whatsapp-web] 账号 ${accountId} 的状态 handler 出错:`, err)
      }
    }
  }
}
