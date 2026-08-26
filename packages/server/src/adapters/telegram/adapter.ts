import { rmSync } from 'node:fs'
import * as path from 'node:path'
import * as tdl from 'tdl'
import { getTdjson } from 'prebuilt-tdlib'
import type { Update } from 'tdlib-types'
import {
  telegramMessageKeyFromTdlib,
  type AccountStatus,
  type OutboundContent,
} from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallenge,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  MessageIdRemapHandler,
  PlatformIdentityHandler,
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
  private readonly platformIdentityHandlers: PlatformIdentityHandler[] = []
  private readonly idRemapHandlers: MessageIdRemapHandler[] = []

  /**
   * 正在等人填验证码 / 二次验证密码的账号。
   * value 是敏感值，只在 resolve 的那一瞬间存在于内存里，不留副本。
   */
  private readonly pendingAnswers = new Map<string, (value: string) => void>()

  constructor(private readonly opts: TelegramAdapterOptions) {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }

  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }
  onPlatformIdentityUpdated(handler: PlatformIdentityHandler): void {
    this.platformIdentityHandlers.push(handler)
  }
  onMessageIdRemapped(handler: MessageIdRemapHandler): void { this.idRemapHandlers.push(handler) }

  private emitStatus(accountId: string, status: AccountStatus): void {
    for (const h of this.statusHandlers) h(accountId, status)
  }

  /** 每个 handler 单独隔离：一个订阅方抛异常不能让其余订阅方收不到 */
  private emitChallenge(accountId: string, challenge: AuthChallenge): void {
    for (const h of this.authChallengeHandlers) {
      try {
        h(accountId, challenge)
      } catch (err) {
        console.error(`[telegram] 账号 ${accountId} 的鉴权挑战 handler 出错:`, err)
      }
    }
  }

  private emitCredentials(accountId: string, ref: string): void {
    for (const h of this.credentialsHandlers) {
      try {
        h(accountId, ref)
      } catch (err) {
        console.error(`[telegram] 账号 ${accountId} 的凭据 handler 出错:`, err)
      }
    }
  }

  private emitPlatformIdentity(accountId: string, externalId: string | null): void {
    for (const handler of this.platformIdentityHandlers) {
      try {
        handler(accountId, externalId)
      } catch (err) {
        console.error(`[telegram] 账号 ${accountId} 的平台身份 handler 出错:`, err)
      }
    }
  }

  /**
   * 挂起等待人工输入。上一个等待会被顶掉——TDLib 输错密码时会重新下发
   * WaitPassword，旧的那个 promise 永远不会有人来 resolve 了。
   */
  private waitForAnswer(accountId: string): Promise<string> {
    this.pendingAnswers.get(accountId)?.('')
    return new Promise<string>((resolve) => { this.pendingAnswers.set(accountId, resolve) })
  }

  async submitAuthAnswer(accountId: string, value: string): Promise<void> {
    const resolve = this.pendingAnswers.get(accountId)
    if (!resolve) throw new Error(`账号 ${accountId} 当前没有在等待鉴权输入`)
    this.pendingAnswers.delete(accountId)
    resolve(value)
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
      const au = update as { _?: string; authorization_state?: { _: string; link?: string } }
      if (au._ === 'updateAuthorizationState' && au.authorization_state) {
        // 不 await：鉴权要等人扫码/输密码，可能挂几分钟，绝不能卡住 update 分发
        void this.driveAuth(account.id, client, au.authorization_state)
      }

      // 发送成功后 TDLib 用最终 id 替换先前回显的临时 id。库里存的是临时 id，
      // 必须就地改写，否则这条消息经其他路径再到达时会被当成新消息存第二遍。
      const u = update as {
        _?: string
        old_message_id?: number
        message?: { id: number; chat_id: number }
      }
      if (u._ === 'updateMessageSendSucceeded' && u.old_message_id != null && u.message) {
        try {
          const oldId = telegramMessageKeyFromTdlib(u.message.chat_id, u.old_message_id)
          const newId = telegramMessageKeyFromTdlib(u.message.chat_id, u.message.id)
          for (const h of this.idRemapHandlers) {
            try {
              h(account.id, oldId, newId)
            } catch (err) {
              console.error(`[telegram] 账号 ${account.id} 的 id 重映射处理器抛出异常，已隔离:`, err)
            }
          }
        } catch {
          console.error(`[telegram] 账号 ${account.id} 收到无效消息 id，已拒绝重映射`)
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

    // 刻意不调 client.login()。它在 WaitPhoneNumber 里写死了发
    // setAuthenticationPhoneNumber，没有扫码入口；而且默认的 getPhoneNumber
    // 从真实 stdin 读，没有 TTY 时会永远挂起，既不超时也不报错。
    // 鉴权改由 driveAuth 自己驱动，全程异步——connect() 建完 client 就返回，
    // 一个待登录账号不会再把整个服务端启动流程卡住。
    //
    // createClient() 自身仍会处理 WaitTdlibParameters（tdl 把它放在 update
    // 分发里，不依赖 login()），所以跳过 login() 是安全的。
    await Promise.resolve()
  }

  /**
   * Telegram 鉴权状态机。
   *
   * 走扫码而不是手机号+短信：员工不用把手机号交给公司，也不用有人守在服务端
   * 终端里转发验证码。TDLib 的二维码 token 过期后会自己再下发一次
   * WaitOtherDeviceConfirmation，所以这里不需要计时，跟着事件走就行。
   */
  private async driveAuth(
    accountId: string,
    client: tdl.Client,
    authState: { _: string; link?: string },
  ): Promise<void> {
    try {
      switch (authState._) {
        case 'authorizationStateWaitPhoneNumber':
          await client.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] })
          return

        case 'authorizationStateWaitOtherDeviceConfirmation': {
          const link = authState.link ?? ''
          if (link === '') {
            console.error(`[telegram] 账号 ${accountId} 收到空的扫码链接`)
            return
          }
          this.emitChallenge(accountId, { kind: 'qr', payload: link })
          return
        }

        case 'authorizationStateWaitCode': {
          this.emitChallenge(accountId, { kind: 'code', payload: '验证码已发送到你的 Telegram' })
          const code = await this.waitForAnswer(accountId)
          if (code === '') return
          // 输错时 TDLib 会重新下发 WaitCode，本方法会被再调一次，自然形成重试
          await client.invoke({ _: 'checkAuthenticationCode', code })
          return
        }

        case 'authorizationStateWaitPassword': {
          const hint = (authState as { password_hint?: string }).password_hint ?? ''
          this.emitChallenge(accountId, { kind: 'password', payload: hint })
          const password = await this.waitForAnswer(accountId)
          if (password === '') return
          // password 只在这一行的作用域里存在：不打日志、不落库、不进错误信息
          await client.invoke({ _: 'checkAuthenticationPassword', password })
          return
        }

        case 'authorizationStateReady': {
          const self = await client.invoke({ _: 'getMe' })
          if (!Number.isSafeInteger(self.id) || self.id <= 0) {
            throw new Error('Telegram getMe 返回了无效 user id')
          }
          this.emitPlatformIdentity(accountId, String(self.id))
          this.emitStatus(accountId, 'connected')
          // 记一笔"这个账号在本机有可用 session"。启动时据此判断该不该自动重连——
          // 比看 status 准，也比看 session 目录存不存在准（TDLib 在鉴权完成前
          // 就会把目录建出来，拿目录判断会把没登录成功的账号也算进去）。
          this.emitCredentials(accountId, 'tdlib-session')
          return
        }

        case 'authorizationStateClosed':
          this.emitPlatformIdentity(accountId, null)
          this.emitStatus(accountId, 'disconnected')
          return

        default:
          return
      }
    } catch (err) {
      // 这里的 err 可能来自 checkAuthenticationPassword，TDLib 的报错文本里
      // 不含密码本身（只有 PASSWORD_HASH_INVALID 这类常量），可以安全打印
      console.error(`[telegram] 账号 ${accountId} 鉴权失败（${authState._}）:`, err)
      this.emitStatus(accountId, 'pending_auth')
    }
  }

  /**
   * 注销并删除本机 session。
   *
   * 先调 TDLib 的 logOut 再删文件：只删文件的话，Telegram 服务端那边这个
   * 「已登录设备」还在，员工手机的设备列表里会永远留着一个没人认识的条目，
   * 而且它仍然是一个有效的授权。
   *
   * logOut 失败不阻断删除——账号可能本来就没登录成功过。但磁盘删不掉要抛：
   * 残留的 session 会让下次用同名账号重新关联时行为诡异。
   */
  async purge(accountId: string): Promise<void> {
    const client = this.clients.get(accountId)
    if (client) {
      try {
        await client.invoke({ _: 'logOut' })
      } catch (err) {
        console.warn(`[telegram] 账号 ${accountId} logOut 失败（可能本来就未登录），继续删除:`, err)
      }
      try {
        await client.close()
      } catch { /* 已经关掉了 */ }
      this.clients.delete(accountId)
    }
    this.pendingAnswers.delete(accountId)
    rmSync(path.join(this.opts.dataDir, accountId), { recursive: true, force: true })
    this.emitStatus(accountId, 'disconnected')
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
          resolve(telegramMessageKeyFromTdlib(conversationId, update.message.id))
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
