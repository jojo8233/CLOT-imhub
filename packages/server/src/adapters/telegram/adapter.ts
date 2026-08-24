import * as path from 'node:path'
import * as tdl from 'tdl'
import { getTdjson } from 'prebuilt-tdlib'
import type { Update } from 'tdlib-types'
import type { AccountStatus, OutboundContent } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  MessageIdRemapHandler,
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
  private readonly idRemapHandlers: MessageIdRemapHandler[] = []

  constructor(private readonly opts: TelegramAdapterOptions) {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }

  // P0 的 Telegram 登录在终端交互完成（见 Task 15），这两个通道登记但不触发。
  // Signal 的扫码关联（P1）会真正用到它们。
  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }
  onMessageIdRemapped(handler: MessageIdRemapHandler): void { this.idRemapHandlers.push(handler) }

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
      // 发送成功后 TDLib 用最终 id 替换先前回显的临时 id。库里存的是临时 id，
      // 必须就地改写，否则这条消息经其他路径再到达时会被当成新消息存第二遍。
      const u = update as { _?: string; old_message_id?: number; message?: { id: number } }
      if (u._ === 'updateMessageSendSucceeded' && u.old_message_id != null && u.message) {
        const oldId = String(u.old_message_id)
        const newId = String(u.message.id)
        for (const h of this.idRemapHandlers) {
          try {
            h(account.id, oldId, newId)
          } catch (err) {
            console.error(`[telegram] 账号 ${account.id} 的 id 重映射处理器抛出异常，已隔离:`, err)
          }
        }
      }

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
    // 注意：login() 默认通过 readline 从真实 stdin 读手机号和验证码。
    // 在没有 TTY 的守护进程里它会永远挂起，既不超时也不报错。
    // P0 阶段登录由人在终端完成（见 Task 15）；将来要 daemonize 必须先改成
    // 传入自定义的 getPhoneNumber / getAuthCode 回调，并接到 onAuthChallenge 上。
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

    // TDLib 是本地回显：invoke 立刻返回一个 sending_state 为 pending 的临时消息，
    // 真实 id 随后由 updateMessageSendSucceeded 下发（带着这条临时 id 作为
    // old_message_id 供我们对上号）。存临时 id 会让 (account_id, platform_message_id)
    // 去重约束从发出第一条消息起就失效——该消息后续所有 update 携带的都是最终 id。
    const res = await client.invoke({
      _: 'sendMessage',
      chat_id: Number(conversationId),
      input_message_content: {
        _: 'inputMessageText',
        text: { _: 'formattedText', text: content.body },
      },
    })
    const tempId = res.id

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.off('update', handler)
        reject(new Error(`telegram sendMessage 超时：未收到 ${tempId} 的最终 id`))
      }, 30_000)

      const handler = (update: Update): void => {
        if (update._ === 'updateMessageSendSucceeded' && update.old_message_id === tempId) {
          clearTimeout(timer)
          client.off('update', handler)
          resolve(String(update.message.id))
        } else if (update._ === 'updateMessageSendFailed' && update.old_message_id === tempId) {
          clearTimeout(timer)
          client.off('update', handler)
          reject(new Error(`telegram 发送失败: ${update.error.message}`))
        }
      }

      client.on('update', handler)
    })
  }
}
