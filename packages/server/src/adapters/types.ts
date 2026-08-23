import type { AccountStatus, NormalizedMessage, OutboundContent, Platform } from '@im-hub/shared'

export interface AdapterAccount {
  id: string
  displayName: string
  credentialsRef: string | null
}

export type MessageHandler = (msg: NormalizedMessage) => void
export type StatusHandler = (accountId: string, status: AccountStatus) => void

export interface PlatformAdapter {
  readonly platform: Platform
  connect(account: AdapterAccount): Promise<void>
  disconnect(accountId: string): Promise<void>
  sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string>
  onMessage(handler: MessageHandler): void
  onStatusChange(handler: StatusHandler): void
}
