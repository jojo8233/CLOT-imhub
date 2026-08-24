import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import type { AccountStatus, OutboundContent } from '@im-hub/shared'
import type {
  AdapterAccount,
  AuthChallenge,
  AuthChallengeHandler,
  CredentialsHandler,
  MessageHandler,
  MessageIdRemapHandler,
  PlatformAdapter,
  StatusHandler,
} from '../types.js'
import { DIRECT_PREFIX, GROUP_PREFIX, normalizeSignalMessage } from './normalize.js'

export interface SignalAdapterOptions {
  /** signal-cli 可执行文件。装在别处时用环境变量覆盖 */
  binary: string
  /** signal-cli 的数据目录。跟 TDLib 的 session 放在一起，备份和重置才好统一处理 */
  dataDir: string
}

interface RpcPending {
  resolve(value: unknown): void
  reject(err: Error): void
}

/** 进程意外退出后的重启退避。指数增长，封顶 30 秒 */
const RESTART_BASE_MS = 2_000
const RESTART_MAX_MS = 30_000

/**
 * Signal 适配器，底层是 signal-cli 的 JSON-RPC 模式。
 *
 * 为什么是 signal-cli：Signal 没有官方的 Node 库，也没有网页版可以包
 * （Signal Desktop 本身就是 Electron 应用，不是网站）。剩下的选择只有
 * 逆向实现协议——那既不稳也有封号风险。
 *
 * 一个进程服务所有 Signal 账号：signal-cli 的 jsonRpc 模式本身就是多账号的，
 * 每个请求带 account 参数。多开一个进程一个账号会白白多出几百 MB 常驻内存。
 *
 * 关联设备是「次要设备」模式——员工手机上的 Signal 才是主设备。这意味着
 * 员工在手机上发的消息会以 syncMessage 同步过来，见 normalize.ts。
 */
export class SignalAdapter implements PlatformAdapter {
  readonly platform = 'signal' as const

  private proc: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, RpcPending>()
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | null = null
  /**
   * 我们主动杀掉的进程。
   *
   * kill() 是异步的：exit 事件在我们已经建好新进程之后才到。用一个布尔开关
   * 挡不住——等 exit 真的触发时开关早关回去了，于是新进程的引用会被旧进程的
   * exit 回调清掉，并且还会多排一次重启。所以按进程实例记，而不是记状态。
   */
  private readonly intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>()

  /** signal-cli 用手机号寻址账号；我们用自己的 accounts.id。两边都要能查 */
  private readonly numberByAccount = new Map<string, string>()
  private readonly accountByNumber = new Map<string, string>()
  /** 已经警告过的陌生号码。同一个号每条消息都刷一行会把日志淹掉 */
  private readonly warnedUnknownAccounts = new Set<string>()

  private readonly messageHandlers: MessageHandler[] = []
  private readonly statusHandlers: StatusHandler[] = []
  private readonly authChallengeHandlers: AuthChallengeHandler[] = []
  private readonly credentialsHandlers: CredentialsHandler[] = []

  constructor(private readonly opts: SignalAdapterOptions) {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler) }
  onStatusChange(handler: StatusHandler): void { this.statusHandlers.push(handler) }
  onAuthChallenge(handler: AuthChallengeHandler): void { this.authChallengeHandlers.push(handler) }
  onCredentialsUpdated(handler: CredentialsHandler): void { this.credentialsHandlers.push(handler) }

  /** Signal 没有临时消息 id（消息身份就是 发送者+timestamp），这个通道永远不会触发 */
  onMessageIdRemapped(_handler: MessageIdRemapHandler): void { /* 不适用 */ }

  private emitStatus(accountId: string, status: AccountStatus): void {
    for (const h of this.statusHandlers) {
      try { h(accountId, status) } catch (err) {
        console.error(`[signal] 账号 ${accountId} 的状态 handler 出错:`, err)
      }
    }
  }

  private emitChallenge(accountId: string, challenge: AuthChallenge): void {
    for (const h of this.authChallengeHandlers) {
      try { h(accountId, challenge) } catch (err) {
        console.error(`[signal] 账号 ${accountId} 的鉴权挑战 handler 出错:`, err)
      }
    }
  }

  private emitCredentials(accountId: string, ref: string): void {
    for (const h of this.credentialsHandlers) {
      try { h(accountId, ref) } catch (err) {
        console.error(`[signal] 账号 ${accountId} 的凭据 handler 出错:`, err)
      }
    }
  }

  // ── 进程与 JSON-RPC ────────────────────────────────────────────

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc

    const proc = spawn(this.opts.binary, ['--config', this.opts.dataDir, 'jsonRpc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc

    // 输出是行分隔 JSON。用 readline 而不是自己攒 buffer——大附件的通知会被
    // 拆成多个 chunk，按 chunk 解析必然在中间截断。
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line.trim() === '') return
      try {
        this.handleLine(JSON.parse(line))
      } catch (err) {
        console.error('[signal] 无法解析 signal-cli 输出:', err, line.slice(0, 200))
      }
    })

    // stderr 里有链接进度和真实错误，直接透传出来，不然出问题时一点线索都没有
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.trim() !== '') console.error('[signal-cli]', line)
    })

    proc.on('exit', (code, signal) => {
      // 挂起的请求不会再有回复，逐个失败掉，否则调用方永远等下去。
      // 这一步无论是不是主动杀的都要做。
      for (const [, pendingReq] of this.pending) {
        pendingReq.reject(new Error('signal-cli 进程已退出'))
      }
      this.pending.clear()

      if (this.intentionalKills.has(proc)) return
      // 退出的不是当前进程（说明已经换了新的），不要动 this.proc
      if (this.proc !== proc) return
      this.proc = null

      console.error(`[signal] signal-cli 退出（code=${String(code)} signal=${String(signal)}），准备重启`)
      for (const accountId of this.numberByAccount.keys()) this.emitStatus(accountId, 'reconnecting')
      this.scheduleRestart()
    })

    proc.on('error', (err) => {
      console.error('[signal] 启动 signal-cli 失败:', err)
    })

    this.restartAttempts = 0
    return proc
  }

  /**
   * 进程死了必须自己爬起来。
   *
   * 不重启的话，所有 Signal 账号会静默地不再收消息——员工照常上班，界面上
   * 看着一切正常，只是客户发来的东西再也不到了。这是最坏的一种坏法。
   *
   * 凭据在磁盘上（--config 指定的目录），重启后账号自动恢复，不用重新扫码。
   */
  private scheduleRestart(): void {
    if (this.restartTimer) return
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS)
    this.restartAttempts += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.numberByAccount.size === 0) return
      console.log('[signal] 正在重启 signal-cli…')
      this.ensureProcess()
      for (const accountId of this.numberByAccount.keys()) this.emitStatus(accountId, 'connected')
    }, delay)
    this.restartTimer.unref()
  }

  private handleLine(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: unknown
    }

    if (m.id !== undefined) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message ?? 'signal-cli 返回了错误'))
      else p.resolve(m.result)
      return
    }

    if (m.method !== 'receive') return

    const account = (m.params as { account?: string } | undefined)?.account
    if (!account) return
    const accountId = this.accountByNumber.get(account)
    if (!accountId) {
      // signal-cli 的数据目录里关联着一个我们这边没登记的号：多半是数据库里
      // 的账号行被删了，但设备关联还在。不能凭空造记录，但**绝不能静默丢弃**
      // ——静默丢弃的表现就是「扫码明明成功了却一条消息都没有」，而日志里
      // 什么都没有，根本无从查起。
      if (!this.warnedUnknownAccounts.has(account)) {
        this.warnedUnknownAccounts.add(account)
        console.warn(
          `[signal] 收到 ${account} 的消息，但数据库里没有对应的账号，已丢弃。\n` +
            '         signal-cli 仍关联着这个号。要么在库里补一条 credentials_ref 指向它的\n' +
            "         signal 账号，要么执行 signal-cli unregister 解除关联。",
        )
      }
      return
    }

    const normalized = normalizeSignalMessage(m.params, accountId)
    if (!normalized) return
    for (const h of this.messageHandlers) {
      try { h(normalized) } catch (err) {
        console.error(`[signal] 账号 ${accountId} 的消息 handler 出错:`, err)
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.ensureProcess()
    const id = this.nextRequestId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (!err) return
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  // ── PlatformAdapter ───────────────────────────────────────────

  async connect(account: AdapterAccount): Promise<void> {
    this.ensureProcess()

    // credentialsRef 存的是关联成功后拿到的手机号。有它就说明这台机器上
    // 已经有可用的 signal-cli 账号数据，直接开始收消息即可。
    if (account.credentialsRef !== null && account.credentialsRef !== '') {
      this.numberByAccount.set(account.id, account.credentialsRef)
      this.accountByNumber.set(account.credentialsRef, account.id)
      this.emitStatus(account.id, 'connected')
      return
    }

    this.emitStatus(account.id, 'pending_auth')
    // 不 await：关联要等人拿手机扫码，可能挂几分钟
    void this.linkDevice(account)
  }

  /**
   * 关联为次要设备。
   *
   * startLink 和 finishLink 必须落在同一个 signal-cli 进程上——finishLink 是
   * 按进程内的会话查 uuid 的，换个进程会直接报 "Unknown device link uri"。
   */
  private async linkDevice(account: AdapterAccount): Promise<void> {
    try {
      const started = await this.request('startLink', {}) as { deviceLinkUri?: string }
      const uri = started.deviceLinkUri
      if (!uri) throw new Error('startLink 没有返回 deviceLinkUri')

      this.emitChallenge(account.id, { kind: 'qr', payload: uri })

      // 阻塞到手机扫码为止；扫完返回本账号的手机号
      const finished = await this.request('finishLink', {
        deviceLinkUri: uri,
        deviceName: account.displayName,
      }) as { number?: string }

      const number = finished.number
      if (!number) throw new Error('finishLink 没有返回账号号码')

      this.numberByAccount.set(account.id, number)
      this.accountByNumber.set(number, account.id)
      // 号码就是 signal-cli 的账号寻址方式，存进 credentials_ref 供重启后自动恢复
      this.emitCredentials(account.id, number)

      // signal-cli 的 --receive-mode 默认是 on-start：只为**进程启动时already
      // 存在**的账号拉起接收线程。刚刚关联的这个账号不在其中，不重启的话它
      // 会一直收不到任何消息——而界面上一切正常，这是最难查的一种坏法。
      //
      // 凭据已经落到磁盘上了，重启后所有账号（包括这个新的）都会自动恢复。
      this.restartForNewAccount()
      this.emitStatus(account.id, 'connected')
    } catch (err) {
      console.error(`[signal] 账号 ${account.id} 关联失败:`, err)
      this.emitStatus(account.id, 'pending_auth')
    }
  }

  /**
   * 关联完新账号后重启 signal-cli，让它把新账号纳入接收范围。
   *
   * 对其他 Signal 账号是一次短暂的重连，可以接受——关联是低频操作，
   * 而「新账号收不到消息」是致命的。
   */
  private restartForNewAccount(): void {
    const proc = this.proc
    if (!proc) return
    this.intentionalKills.add(proc)
    proc.kill()
    this.proc = null
    this.restartAttempts = 0
    this.ensureProcess()
  }

  /**
   * 清除本机上这个 Signal 账号的数据。
   *
   * 用 deleteLocalAccountData 而不是 unregister：unregister 会去 Signal 服务端
   * 解除这台设备的注册，那是对用户真实账号的操作。删一条我们这边的记录不该
   * 顺手改动他的 Signal 账号——万一语义理解错了，代价是不可逆的。
   *
   * 代价是手机的「已关联设备」里会留下一个条目，需要用户自己去移除。
   * 调用方要把这件事明确告诉用户，不能让它悄悄留在那儿。
   */
  async purge(accountId: string): Promise<void> {
    const number = this.numberByAccount.get(accountId)
    if (number !== undefined) {
      try {
        // ignoreRegistered：这个号在服务端仍是注册状态，不加这个参数会被拒绝
        await this.request('deleteLocalAccountData', { account: number, ignoreRegistered: true })
      } catch (err) {
        console.warn(`[signal] 清除 ${accountId} 的本地数据失败:`, err)
      }
    }
    await this.disconnect(accountId)
  }

  async disconnect(accountId: string): Promise<void> {
    const number = this.numberByAccount.get(accountId)
    if (number !== undefined) {
      this.numberByAccount.delete(accountId)
      this.accountByNumber.delete(number)
    }
    this.emitStatus(accountId, 'disconnected')

    // 没有账号在用了就把进程收掉，别让它空跑着常驻
    if (this.numberByAccount.size === 0 && this.proc) {
      this.intentionalKills.add(this.proc)
      this.proc.kill()
      this.proc = null
    }
  }

  async sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string> {
    const account = this.numberByAccount.get(accountId)
    if (account === undefined) throw new Error(`signal account ${accountId} is not connected`)

    // 单聊和群要走完全不同的参数，靠会话 id 的前缀区分（见 normalize.ts 的说明）
    const params: Record<string, unknown> = { account, message: content.body }
    if (conversationId.startsWith(GROUP_PREFIX)) {
      params.groupId = conversationId.slice(GROUP_PREFIX.length)
    } else if (conversationId.startsWith(DIRECT_PREFIX)) {
      params.recipient = [conversationId.slice(DIRECT_PREFIX.length)]
    } else {
      throw new Error(`signal 会话 id 缺少前缀，无法判断是单聊还是群：${conversationId}`)
    }

    const res = await this.request('send', params) as { timestamp?: number }
    if (res.timestamp === undefined) throw new Error('signal-cli 没有返回消息 timestamp')

    // 与 normalize.ts 里同步消息的算法保持一致：同一条消息经两条路径必须算出
    // 同一个 id，否则 (account_id, platform_message_id) 去重会把它存成两行
    return `${account}:${res.timestamp}`
  }

  /** Signal 的设备关联只有扫码一步，没有验证码或密码环节 */
  async submitAuthAnswer(_accountId: string, _value: string): Promise<void> {
    throw new Error('Signal 关联只需要扫码，不需要额外输入')
  }
}
