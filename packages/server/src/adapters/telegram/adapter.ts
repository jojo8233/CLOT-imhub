import * as path from 'node:path'
import * as tdl from 'tdl'
import { getTdjson } from 'prebuilt-tdlib'
import type { AccountStatus, OutboundContent } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  PlatformAdapter,
  StatusHandler,
} from '../types.js'
import { normalizeTelegramMessage } from './normalize.js'

tdl.configure({ tdjson: getTdjson() })

export interface TelegramAdapterOptions {
  apiId: number
  apiHash: string
  dataDir: string
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const

  /** 一账号一个 TDLib client——多开靠的就是这里，各实例的 session 目录彼此隔离 */
  private readonly clients = new Map<string, tdl.Client>()
  private readonly messageHandlers: MessageHandler[] = []
  private readonly statusHandlers: StatusHandler[] = []
  private readonly authChallengeHandlers: AuthChallengeHandler[] = []
  private readonly credentialsHandlers: CredentialsHandler[] = []

  constructor(private readonly opts: TelegramAdapterOptions) {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }

  // P0 的 Telegram 登录在终端交互完成（见 Task 15），这两个通道登记但不触发。
  // Signal 的扫码关联（P1）会真正用到它们。
  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }

  private emitStatus(accountId: string, status: AccountStatus): void {
    for (const h of this.statusHandlers) h(accountId, status)
  }

  async connect(account: AdapterAccount): Promise<void> {
    if (this.clients.has(account.id)) return

    const client = tdl.createClient({
      apiId: this.opts.apiId,
      apiHash: this.opts.apiHash,
      databaseDirectory: path.join(this.opts.dataDir, account.id, 'db'),
      filesDirectory: path.join(this.opts.dataDir, account.id, 'files'),
    })

    client.on('update', (update: unknown) => {
      const msg = normalizeTelegramMessage(update, account.id)
      if (!msg) return
      for (const h of this.messageHandlers) {
        // 一个 handler 抛出的异常绝不能让 tdl 把它当成 TDLib 层面的错误接住——
        // tdl 会把 update 回调里未捕获的异常转成 client 的 'error' 事件，而我们的
        // error 处理会把账号状态错误地标成 reconnecting。消息处理失败跟连接状态无关。
        try {
          h(msg)
        } catch (err) {
          console.error(`[telegram] 账号 ${account.id} 的消息 handler 出错:`, err)
        }
      }
    })

    client.on('error', (err) => {
      console.error(`[telegram] 账号 ${account.id} 出错:`, err)
      this.emitStatus(account.id, 'reconnecting')
    })

    this.clients.set(account.id, client)
    this.emitStatus(account.id, 'pending_auth')
    await client.login()
    this.emitStatus(account.id, 'connected')
  }

  async disconnect(accountId: string): Promise<void> {
    const client = this.clients.get(accountId)
    if (!client) return
    await client.close()
    this.clients.delete(accountId)
    this.emitStatus(accountId, 'disconnected')
  }

  async sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string> {
    const client = this.clients.get(accountId)
    if (!client) throw new Error(`telegram account ${accountId} is not connected`)

    const res = await client.invoke({
      _: 'sendMessage',
      chat_id: Number(conversationId),
      input_message_content: {
        _: 'inputMessageText',
        text: { _: 'formattedText', text: content.body },
      },
    })
    return String((res as { id: number }).id)
  }
}
