import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  NativeCommandResultEvent,
  NativeControlStateUpdate,
  NativeGuestEvent,
  NativeHostCommand,
  NativeOutboxStatusEvent,
} from '@im-hub/shared'
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from '@im-hub/shared'
import type { SignalDesktopState } from '../../signal-desktop-ipc.js'
import {
  api,
  getCurrentUser,
  type AccountRow,
  type SessionUser,
} from '../api/client.js'
import {
  handleNativeCommandResult,
  nativeMessageTranslationBridge,
  nativeMessageTranslationsFromRows,
  registerNativeCommandTarget,
} from '../native-bridge.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { EmptyHint, IconButton } from './ui.js'

/**
 * 套壳原生客户端。
 *
 * 每个平台账号一个 <webview>，各自带独立的 partition——登录态就是靠 partition
 * 隔离的，这也是"多开"在这条路线下的实现方式。
 *
 * 关键取舍：恢复宿主会话后，当前 owner 的已支持账号 webview 会全部创建，
 * 之后**不卸载**，只用 display 切换显示。
 * Telegram Web 重新加载一次要重连、重拉会话列表、丢掉滚动位置，来回切账号
 * 时会明显卡顿闪烁。常驻的代价是内存，但切换体验是这条路线的核心价值。
 *
 * 安全边界：webview 里跑的是第三方站点，一律当不可信内容。它拿不到
 * window.imHub、用户 JWT 或 control grant，也没有 node 能力；翻译和命令都经
 * webview 自己的 preload 进入主进程按账号校验。
 */

/**
 * 各平台加载哪份客户端。
 *
 * 指向**我们自己构建的补丁版**，不是官方地址：补丁版里翻译改走 im-hub 的
 * 网关，并且去掉了 Telegram 的 Premium 门禁。扒官方页面的 DOM 是行不通的
 * ——那份代码混淆过，选择器一改版就失效，而且失效时不报错、只是悄悄不翻译。
 *
 * 开发期指向 telegram-tt 的 Vite 服务器；打包后会换成随应用分发的静态产物。
 */
interface WebClientDefinition {
  src: string
  bridgeEnabled: boolean
}

const WEB_CLIENT: Record<string, WebClientDefinition> = {
  // 开发期指向 telegram-tt 的 Vite 服务器（代码/telegram-tt，npm run dev）。
  // 打包时这里要换成随应用分发的静态产物地址，见 native-client-pivot 设计文档。
  telegram: { src: 'http://localhost:1234/', bridgeEnabled: true },
  // First M6 checkpoint: official linked-device UI in an isolated partition.
  // No im-hub preload or control grant is injected until the WhatsApp-specific
  // identity and event bridge has its own verified contract.
  whatsapp: { src: 'https://web.whatsapp.com/', bridgeEnabled: false },
}

const PLATFORM_PHASE: Record<string, string> = {
  signal: 'M5',
  whatsapp: 'M6',
  zoom: 'M8',
}

export function nativeClientSupported(platform: string): boolean {
  return platform in WEB_CLIENT
}

export function browserCompatibleUserAgent(userAgent: string): string {
  const platform = /\(([^)]+)\)/.exec(userAgent)?.[1]
  const chrome = /Chrome\/[\d.]+/.exec(userAgent)?.[0]
  if (!platform || !chrome) return userAgent.replace(/\sElectron\/[\d.]+/g, '')
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`
}

export function nativeAccountControllable(
  account: Pick<AccountRow, 'owner_user_id'> | null,
  user: Pick<SessionUser, 'id' | 'role'> | null,
): boolean {
  return account !== null && user !== null
    && account.owner_user_id === user.id
    && user.role !== 'auditor'
}

/**
 * 消息 outbox 是账号级后台观测链路，不能把“用户点过这个 tab”当成
 * 正确性前置条件。宿主恢复会话后预挂载当前 owner 的所有已支持账号，
 * 隐藏 pane 继续用各自 partition 接收平台 update 并清空 outbox。
 */
export function nativeAccountIdsToMount(
  accounts: ReadonlyArray<Pick<AccountRow,
    'id' | 'platform' | 'owner_user_id' | 'connection_mode'>>,
  user: Pick<SessionUser, 'id' | 'role'> | null,
  supportsWebview: boolean,
): string[] {
  if (!supportsWebview) return []
  return accounts
    .filter(account => nativeClientSupported(account.platform)
      && (account.platform !== 'whatsapp'
        || account.connection_mode === 'adapter'
        || account.connection_mode === 'web_shell')
      && nativeAccountControllable(account, user))
    .map(account => account.id)
}

export function signalDesktopAccountIdsToMount(
  accounts: ReadonlyArray<Pick<AccountRow,
    'id' | 'platform' | 'owner_user_id' | 'connection_mode'>>,
  user: Pick<SessionUser, 'id' | 'role'> | null,
  supportsSignalDesktop: boolean,
): string[] {
  if (!supportsSignalDesktop) return []
  return accounts
    .filter(account => account.platform === 'signal'
      && account.connection_mode === 'native_desktop'
      && nativeAccountControllable(account, user))
    .map(account => account.id)
}

export function signalOutboxStatusError(
  status: Pick<NativeOutboxStatusEvent,
    'pendingCount' | 'deadLetterCount' | 'lastErrorCode'>,
): string | null {
  if (status.lastErrorCode === 'outbox_storage_failed') return '持久消息队列不可用'
  if (status.deadLetterCount > 0) return `${status.deadLetterCount} 条事件永久失败，等待人工处理`
  if (status.lastErrorCode === 'outbox_capacity'
    || status.lastErrorCode === 'dead_letter_capacity') return '持久消息队列容量已满'
  if (status.lastErrorCode && status.pendingCount > 0) return '持久消息队列暂时失败，正在重试'
  return null
}

/** 单条入站消息归一化失败不影响账号授权，也不能阻断后续消息继续回传。 */
export function signalInboundErrorIsNonfatal(code: string): boolean {
  return code === 'invalid_signal_inbound'
    || code === 'invalid_signal_media'
    || code === 'unsupported_signal_media'
    || code === 'invalid_signal_edit'
    || code === 'invalid_signal_delete'
    || code === 'invalid_signal_reaction'
    || code === 'signal_composer_state_unavailable'
    || code === 'signal_draft_too_large'
    || code === 'signal_send_ledger_unavailable'
    || code === 'signal_send_ack_failed'
}

interface NativeWebviewLoadProbe {
  getURL(): string
  getWebContentsId(): number
  isLoading(): boolean
}

/**
 * React 的 effect 可能在很快的本机页面已经触发 dom-ready 后才挂上监听器。
 * 这时 webview 已经可用，不能继续等到二十秒超时。
 */
export function nativeWebviewAlreadyLoaded(webview: NativeWebviewLoadProbe, src: string): boolean {
  return nativeWebviewAtExpectedOrigin(webview, src) && !webview.isLoading()
}

/**
 * WhatsApp Web 登录后可能让 Electron 的全局 isLoading 长时间保持 true，即使文档已经
 * complete。shell-only 页面只需要确认 guest 已附着且仍在精确白名单 origin；页面自身的
 * 加载界面比宿主的误报遮罩更准确。bridge 客户端仍使用上面的严格完成条件。
 */
export function nativeWebviewAtExpectedOrigin(webview: NativeWebviewLoadProbe, src: string): boolean {
  try {
    return webview.getWebContentsId() > 0
      && new URL(webview.getURL()).origin === new URL(src).origin
  } catch {
    return false
  }
}

/**
 * 同一账号的 control grant 是单活版本：每次签发都会立即让上一份失效。
 * 因此 dom-ready、身份上报和 StrictMode 即使同时触发，也只能共用一次签发。
 */
export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | null = null
  return () => {
    if (active) return active
    const current = operation().finally(() => {
      if (active === current) active = null
    })
    active = current
    return current
  }
}

/**
 * 当前宿主是否支持 <webview>。
 *
 * 这是 Electron 独有的元素，浏览器里 document.createElement('webview') 会得到
 * 一个普通的未知元素——不报错、不渲染、dom-ready 永远不触发。不检测的话界面
 * 会永远停在"正在打开原生界面…"，而没有任何线索说明为什么。
 */
function webviewSupported(): boolean {
  try {
    return 'getWebContentsId' in document.createElement('webview')
  } catch {
    return false
  }
}

/** dom-ready 的等待上限。超过这个时间基本可以断定不是"慢"，是"不会来了" */
const READY_TIMEOUT_MS = 20_000

export function NativeClient() {
  const accounts = useStore(s => s.accounts)
  const activeAccountId = useStore(s => s.activeAccountId)
  const activeNativeConversationId = useStore(s => activeAccountId
    ? s.nativeBridgeByAccount[activeAccountId]?.context?.conversationId ?? null
    : null)
  const setActiveConversation = useStore(s => s.setActiveConversation)

  const active = accounts.find(a => a.id === activeAccountId) ?? null
  const currentUser = getCurrentUser()
  const activeOwnedByCurrentUser = nativeAccountControllable(active, currentUser)
  const supportsWebview = webviewSupported()
  const supportsSignalDesktop = window.imHub?.signalDesktop !== undefined
  // 不只挂载 active 账号：否则宿主刷新后从未点开的账号会错过
  // Telegram delete/edit update，之后打开只能看到最终状态，无法补出已丢的事件。
  const mounted = nativeAccountIdsToMount(accounts, currentUser, supportsWebview)
  const mountedSignalDesktop = signalDesktopAccountIdsToMount(
    accounts,
    currentUser,
    supportsSignalDesktop,
  )

  // 每个常驻 webview 都记住自己的当前会话。切回某账号时恢复它的服务端会话，
  // 不能继续显示上一个账号的客户资料，也不该要求平台再次发 context.changed。
  useEffect(() => {
    setActiveConversation(activeNativeConversationId)
  }, [activeAccountId, activeNativeConversationId, setActiveConversation])

  let overlay: ReactNode = null
  if (!active) {
    overlay = <EmptyHint>从顶栏选一个账号<br />这里会打开它的原生界面</EmptyHint>
  } else if (active.platform === 'signal' && active.connection_mode !== 'native_desktop') {
    overlay = (
      <EmptyHint>
        这是服务端后台适配器账号，不会打开 Signal Desktop。<br />
        请从顶栏“+”添加一个 Signal 原生桌面账号。
      </EmptyHint>
    )
  } else if (active.platform === 'signal' && !supportsSignalDesktop) {
    overlay = (
      <EmptyHint>
        Signal Desktop 宿主桥接不可用。<br />请重新启动 im-hub 桌面开发进程。
      </EmptyHint>
    )
  } else if (active.platform === 'whatsapp'
    && active.connection_mode !== 'adapter'
    && active.connection_mode !== 'web_shell') {
    overlay = (
      <EmptyHint>
        这个账号不是 WhatsApp 官方网页壳，不会加载 web.whatsapp.com。<br />
        Business Platform 需要单独完成 Cloud API 授权与 Webhook 配置。
      </EmptyHint>
    )
  } else if (active.platform !== 'signal' && !nativeClientSupported(active.platform)) {
    overlay = (
      <EmptyHint>
        {PLATFORM_LABEL[active.platform] ?? active.platform} 原生客户端尚未接入。
        <br />计划在 {PLATFORM_PHASE[active.platform] ?? '后续阶段'} 完成多开、翻译与消息回传。
      </EmptyHint>
    )
  } else if (!activeOwnedByCurrentUser) {
    overlay = (
      <EmptyHint>
        这个平台账号不属于当前用户，原生客户端保持锁定。
        <br />管理与审计角色只能读取已回传的存档，不能操控账号或发送消息。
      </EmptyHint>
    )
  } else if (active.platform !== 'signal' && !supportsWebview) {
    overlay = (
      <EmptyHint>
        原生界面只能在桌面客户端里打开。<br />
        当前窗口没有 Electron webview 能力。<br />
        <span style={{ color: theme.color.textMuted }}>
          请切换到 im-hub 应用窗口（Cmd+Tab），或点 Dock 里的图标。
        </span>
      </EmptyHint>
    )
  }

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: theme.color.chat }}>
      {mountedSignalDesktop.map(accountId => (
        <SignalDesktopPane
          key={accountId}
          accountId={accountId}
          visible={accountId === active?.id && active.platform === 'signal'}
        />
      ))}
      {mounted.map(id => {
        const acc = accounts.find(a => a.id === id)
        // mounted 每次都从当前账号和授权事实派生。owner/角色变化后会立即
        // 卸载已失权的隐藏 pane，避免它继续保持 control grant 和 command target。
        if (!acc
          || !nativeClientSupported(acc.platform)
          || !nativeAccountControllable(acc, currentUser)) return null
        const client = WEB_CLIENT[acc.platform]!
        return (
          <WebviewPane
            key={id}
            accountId={id}
            src={client.src}
            bridgeEnabled={client.bridgeEnabled}
            userAgent={acc.platform === 'whatsapp'
              ? browserCompatibleUserAgent(navigator.userAgent)
              : undefined}
            visible={id === active?.id}
          />
        )
      })}
      {overlay && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: theme.color.chat,
        }}>
          {overlay}
        </div>
      )}
    </div>
  )
}

function SignalDesktopPane({ accountId, visible }: { accountId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const lastContextRevisionRef = useRef(-1)
  const [state, setState] = useState<SignalDesktopState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [guestWebContentsId, setGuestWebContentsId] = useState<number | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [outboxError, setOutboxError] = useState<string | null>(null)
  const bridge = window.imHub?.signalDesktop

  useEffect(() => {
    if (!bridge) return
    return bridge.onState(update => {
      if (update.accountId !== accountId) return
      setState(update.state)
      setMessage(update.message)
    })
  }, [accountId, bridge])

  useEffect(() => {
    if (!bridge) return
    let disposed = false
    let animationFrame: number | null = null
    const element = ref.current
    if (!element) return

    const sync = (): void => {
      if (disposed) return
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null
        if (disposed) return
        const rect = element.getBoundingClientRect()
        const actuallyVisible = visible && rect.width >= 1 && rect.height >= 1
        void bridge.sync(accountId, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }, actuallyVisible).then(update => {
          if (disposed || update.accountId !== accountId) return
          setState(update.state)
          setMessage(update.message)
          setGuestWebContentsId(update.guestWebContentsId)
        }).catch(() => {
          if (disposed) return
          setState('failed')
          setMessage('Signal Desktop 宿主同步失败')
        })
      })
    }

    const observer = new ResizeObserver(sync)
    observer.observe(element)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    sync()
    return () => {
      disposed = true
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      const rect = element.getBoundingClientRect()
      void bridge.sync(accountId, {
        x: rect.x,
        y: rect.y,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      }, false).catch(() => {})
    }
  }, [accountId, bridge, visible])

  useEffect(() => {
    if (!bridge) return
    return () => { void bridge.release(accountId).catch(() => {}) }
  }, [accountId, bridge])

  useEffect(() => {
    const nativeControl = window.imHub?.nativeControl
    if (!nativeControl || guestWebContentsId === null) return
    const target = { accountId, guestWebContentsId }
    lastContextRevisionRef.current = -1
    let disposed = false
    let grantRefreshTimer: ReturnType<typeof setTimeout> | null = null
    let provisionGeneration = 0
    let hasUsableGrant = false
    let observedIdentity: string | null = null
    let activeProvision: Promise<void> | null = null

    const syncVisibleTranslations = (): void => {
      const current = useStore.getState()
      if (current.activeAccountId !== accountId || !current.activeConversationId) return
      const conversation = current.conversations.find(
        item => item.id === current.activeConversationId && item.account_id === accountId,
      )
      if (!conversation) return
      void nativeMessageTranslationBridge.sync(
        accountId,
        nativeMessageTranslationsFromRows(current.messages),
      ).catch(() => {})
    }

    const applyControlState = (control: NativeControlStateUpdate): void => {
      if (disposed || control.accountId !== accountId) return
      hasUsableGrant = control.expiresAt !== null && control.state !== 'blocked'
      if (control.state === 'ready') {
        setControlError(null)
        useStore.getState().setNativeBridgeConnection(accountId, 'ready')
        syncVisibleTranslations()
        return
      }
      const detail = control.message ?? 'Signal 入站桥接尚未就绪'
      setControlError(control.state === 'blocked' ? detail : null)
      useStore.getState().setNativeBridgeConnection(
        accountId,
        control.state === 'blocked' ? 'failed' : 'waiting',
        detail,
      )
    }

    const scheduleGrantRefresh = (expiresAt: string): void => {
      if (grantRefreshTimer) clearTimeout(grantRefreshTimer)
      const delay = Math.max(
        MIN_GRANT_REFRESH_MS,
        Date.parse(expiresAt) - Date.now() - GRANT_REFRESH_MARGIN_MS,
      )
      grantRefreshTimer = setTimeout(() => { void provisionControl() }, delay)
    }

    const provisionControl = (): Promise<void> => {
      if (activeProvision) return activeProvision
      const operation = (async (): Promise<void> => {
        if (disposed || !observedIdentity) return
        const generation = ++provisionGeneration
        try {
          const grant = await api.createNativeControlGrant(accountId, observedIdentity)
          if (disposed || generation !== provisionGeneration) return
          const control = await nativeControl.configure(target, grant)
          if (disposed || generation !== provisionGeneration) return
          applyControlState(control)
          scheduleGrantRefresh(grant.expiresAt)
        } catch {
          if (disposed || generation !== provisionGeneration) return
          hasUsableGrant = false
          setControlError('Signal 账号身份绑定或短时授权建立失败')
          useStore.getState().setNativeBridgeConnection(
            accountId,
            'failed',
            'Signal 账号身份绑定或短时授权建立失败',
          )
        }
      })().finally(() => {
        if (activeProvision === operation) activeProvision = null
      })
      activeProvision = operation
      return operation
    }

    const sendEventAck = (eventId: string, accepted: boolean, retryable: boolean): void => {
      void nativeControl.sendCommand(target, {
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'event.ack',
        eventId,
        accepted,
        retryable,
      }).catch(() => {
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', 'Signal 入站 ACK 桥接已断开')
      })
    }

    const onGuestEvent = (event: NativeGuestEvent): void => {
      if (disposed) return
      if (event.type === 'bridge.ready') {
        useStore.getState().setNativeBridgeNotice(accountId, null)
        useStore.getState().setNativeBridgeConnection(accountId, 'waiting', '正在核对 Signal 登录身份')
        return
      }
      if (event.type === 'account.identity') {
        const changed = observedIdentity !== event.platformAccountExternalId
        observedIdentity = event.platformAccountExternalId
        useStore.getState().setNativeAccountIdentity(accountId, observedIdentity)
        if (changed || !hasUsableGrant) void provisionControl()
        return
      }
      if (event.type === 'account.signed-out') {
        observedIdentity = null
        hasUsableGrant = false
        useStore.getState().setNativeAccountIdentity(accountId, null)
        useStore.getState().setNativeBridgeNotice(accountId, null)
        setControlError('Signal 账号已退出')
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', 'Signal 账号已退出')
        return
      }
      if (event.type === 'command.result') {
        handleNativeCommandResult(accountId, event as NativeCommandResultEvent)
        return
      }
      if (event.type === 'bridge.error') {
        if (signalInboundErrorIsNonfatal(event.code)) {
          useStore.getState().setNativeBridgeNotice(accountId, event.message)
          return
        }
        useStore.getState().setNativeBridgeNotice(accountId, null)
        setControlError(event.message)
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', event.message)
        return
      }
      if (event.type === 'outbox.status') {
        setOutboxError(signalOutboxStatusError(event))
        useStore.getState().setNativeOutboxStatus(accountId, {
          pendingCount: event.pendingCount,
          deadLetterCount: event.deadLetterCount,
          isSending: event.isSending,
          lastErrorCode: event.lastErrorCode,
        })
        return
      }
      if (event.type === 'context.changed') {
        const currentContext = useStore.getState().nativeBridgeByAccount[accountId]?.context
        if (event.contextRevision < lastContextRevisionRef.current) return
        if (event.contextRevision === lastContextRevisionRef.current) {
          const incomingConversationId = event.context?.platformConversationId ?? null
          const currentConversationId = currentContext?.platformConversationId ?? null
          if (incomingConversationId !== currentConversationId) {
            setControlError('Signal 原生客户端复用了当前会话 revision')
            useStore.getState().setNativeBridgeConnection(
              accountId,
              'failed',
              'Signal 原生客户端复用了当前会话 revision',
            )
          }
          return
        }
        lastContextRevisionRef.current = event.contextRevision
        if (!event.context) {
          useStore.getState().setNativeContext(accountId, null)
          return
        }
        const context = event.context
        useStore.getState().setNativeContext(accountId, {
          ...context,
          contextRevision: event.contextRevision,
          conversationId: null,
        })
        void nativeControl.syncContext(target, context).then(({ conversationId }) => {
          if (disposed) return
          useStore.getState().resolveNativeConversation(
            accountId,
            event.contextRevision,
            context.platformConversationId,
            conversationId,
          )
          // 初次 composer.state 可能先于服务端 conversation UUID 解析完成。
          // 解析后要求 Signal 重放，确保进程重启留下的发送 attempt 不会丢在竞态里。
          void nativeControl.sendCommand(target, {
            protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
            type: 'bridge.request-state',
          }).catch(() => {
            useStore.getState().setNativeBridgeNotice(accountId, 'Signal 发送状态重放失败，请重试')
          })
          void api.listConversations().then(({ conversations }) => {
            if (!disposed) useStore.getState().setConversations(conversations)
          }).catch(() => {})
        }).catch(() => {
          if (disposed) return
          setControlError('Signal 当前会话同步到服务端失败')
          useStore.getState().setNativeBridgeConnection(
            accountId,
            'failed',
            'Signal 当前会话同步到服务端失败',
          )
        })
        return
      }
      if (event.type === 'composer.state') {
        useStore.getState().setNativeBridgeNotice(accountId, null)
        useStore.getState().applyNativeComposerState(
          accountId,
          event.contextRevision,
          event.platformConversationId,
          event.draft,
          event.canSend,
          event.sendAttempt,
        )
        return
      }
      if (event.type !== 'message.upsert'
        && event.type !== 'message.deleted'
        && event.type !== 'message.id-remapped'
        && event.type !== 'message.reaction') return

      void nativeControl.reportEvent(target, event).then(() => {
        if (disposed) return
        setControlError(null)
        useStore.getState().setNativeBridgeNotice(accountId, null)
        useStore.getState().setNativeBridgeConnection(accountId, 'ready')
        sendEventAck(event.eventId, true, false)
        void api.listConversations().then(({ conversations }) => {
          if (!disposed) useStore.getState().setConversations(conversations)
        }).catch(() => {})
      }).catch((error: unknown) => {
        if (disposed) return
        const status = nativeProxyStatus(error)
        const retryable = status === null
          || status === 408
          || status === 409
          || status === 425
          || status === 429
          || status >= 500
        const detail = retryable ? 'Signal 入站回传失败，正在重试' : 'Signal 入站回传被服务端拒绝'
        useStore.getState().setNativeBridgeNotice(accountId, detail)
        sendEventAck(event.eventId, false, retryable)
      })
    }

    const removeEventListener = nativeControl.onEvent(value => {
      if (value.accountId === accountId) onGuestEvent(value.event)
    })
    const removeStateListener = nativeControl.onState(applyControlState)
    const unregisterTarget = registerNativeCommandTarget(accountId, {
      send: (_channel: string, command: unknown): Promise<void> =>
        nativeControl.sendCommand(target, command as NativeHostCommand),
    })
    useStore.getState().setNativeBridgeConnection(accountId, 'waiting', '正在等待 Signal 登录身份')

    return () => {
      disposed = true
      provisionGeneration += 1
      if (grantRefreshTimer) clearTimeout(grantRefreshTimer)
      removeEventListener()
      removeStateListener()
      unregisterTarget()
      lastContextRevisionRef.current = -1
      useStore.getState().setNativeContext(accountId, null)
      void nativeControl.release(target).catch(() => {})
    }
  }, [accountId, guestWebContentsId])

  const retry = (): void => {
    const element = ref.current
    if (!bridge || !element) return
    const rect = element.getBoundingClientRect()
    setState('starting')
    setMessage('正在重新启动 Signal Desktop')
    void bridge.release(accountId).then(() => bridge.sync(accountId, {
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    }, visible && rect.width >= 1 && rect.height >= 1)).catch(() => {
      setState('failed')
      setMessage('Signal Desktop 重新启动失败')
    })
  }

  const bridgeError = controlError ?? outboxError

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', inset: 0,
        display: visible ? 'block' : 'none',
        background: theme.color.chat,
      }}
    >
      {state !== 'ready' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: theme.space.md,
          color: state === 'failed' ? theme.color.danger : theme.color.textFaint,
          fontSize: theme.font.size.sm,
        }}>
          <span className={state === 'failed' ? undefined : 'ih-pulse'}>
            {message ?? '正在打开 Signal Desktop…'}
          </span>
          {state === 'failed' && (
            <button
              className="ih-btn"
              onClick={retry}
              style={{
                padding: '8px 16px', borderRadius: theme.radius.pill,
                border: `1px solid ${theme.color.borderStrong}`,
                background: theme.color.white, color: theme.color.text,
              }}
            >
              重试
            </button>
          )}
        </div>
      )}
      {bridgeError && state === 'ready' && (
        <div style={{
          position: 'absolute', left: 16, right: 16, top: 12, zIndex: 3,
          padding: '9px 12px', borderRadius: theme.radius.md,
          background: theme.color.dangerSoft, color: theme.color.danger,
          fontSize: theme.font.size.sm, pointerEvents: 'none',
        }}>
          Signal 入站桥接：{bridgeError}
        </div>
      )}
    </div>
  )
}

const GRANT_REFRESH_MARGIN_MS = 60_000
const MIN_GRANT_REFRESH_MS = 30_000

function nativeProxyStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /原生代理请求失败（(\d{3})）/.exec(message)
  return match ? Number(match[1]) : null
}

function WebviewPane({ accountId, src, bridgeEnabled, userAgent, visible }: {
  accountId: string
  src: string
  bridgeEnabled: boolean
  userAgent?: string
  visible: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  const guestWebContentsIdRef = useRef<number | null>(null)
  const lastContextRevisionRef = useRef(-1)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [detail, setDetail] = useState<string>('')
  const [controlError, setControlError] = useState<string | null>(null)
  const nativePreload = window.imHub?.nativeBridgePreload

  useEffect(() => {
    if (state !== 'loading') return
    const timer = setTimeout(() => {
      console.error(`[native-client:${accountId.slice(0, 8)}] 原生客户端页面加载超时`)
      setState('failed')
      setDetail(import.meta.env.DEV
        ? '等了 20 秒还没加载出来。确认对应平台客户端和网络可用，然后点右下角 ⌘ 看控制台'
        : '等了 20 秒还没加载出来。检查网络或代理后重新打开应用')
      useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端页面加载超时')
    }, READY_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [accountId, state])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    if (!bridgeEnabled) {
      let readyHandled = false
      let originProbeTimer: ReturnType<typeof setInterval> | null = null
      const onStartLoading = (): void => {
        if (nativeWebviewAtExpectedOrigin(el as unknown as NativeWebviewLoadProbe, src)) {
          setState('ready')
          return
        }
        readyHandled = false
        setState('loading')
        setDetail('')
        setControlError(null)
      }
      const onReady = (): void => {
        if (readyHandled) return
        const webview = el as unknown as NativeWebviewLoadProbe
        try {
          if (new URL(webview.getURL()).origin !== new URL(src).origin) {
            throw new Error('unexpected origin')
          }
        } catch {
          console.error(`[native-client:${accountId.slice(0, 8)}] 官方客户端来源校验失败`)
          setState('failed')
          setDetail('平台客户端跳转到了未授权页面，已停止加载')
          return
        }
        readyHandled = true
        if (originProbeTimer) clearInterval(originProbeTimer)
        setState('ready')
      }
      const onFail = (e: Event): void => {
        const err = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
        if (err.isMainFrame === false) return
        console.error(
          `[native-client:${accountId.slice(0, 8)}] 官方客户端主页面加载失败，错误码 ${String(err.errorCode ?? 'unknown')}`,
        )
        setState('failed')
        setDetail(`${err.errorDescription ?? '未知错误'}（${String(err.errorCode ?? '')}）`)
      }
      const onConsole = (e: Event): void => {
        const message = e as Event & { level?: number }
        if ((message.level ?? 0) >= 2) {
          console.error(
            `[native-client:${accountId.slice(0, 8)}]`,
            'guest 报告 warning/error；请在开发构建中检查隔离控制台',
          )
        }
      }
      el.addEventListener('did-start-loading', onStartLoading)
      el.addEventListener('dom-ready', onReady)
      el.addEventListener('did-stop-loading', onReady)
      el.addEventListener('did-fail-load', onFail)
      el.addEventListener('console-message', onConsole)
      // React effect 可能晚于 dom-ready，而 WhatsApp 的 isLoading 又可能长期不归零。
      // 短轮询只验证 webContents + 精确 origin，不读取或操控官方页面 DOM。
      originProbeTimer = setInterval(() => {
        if (nativeWebviewAtExpectedOrigin(el as unknown as NativeWebviewLoadProbe, src)) onReady()
      }, 250)
      if (nativeWebviewAtExpectedOrigin(el as unknown as NativeWebviewLoadProbe, src)) onReady()
      return () => {
        if (originProbeTimer) clearInterval(originProbeTimer)
        el.removeEventListener('did-start-loading', onStartLoading)
        el.removeEventListener('dom-ready', onReady)
        el.removeEventListener('did-stop-loading', onReady)
        el.removeEventListener('did-fail-load', onFail)
        el.removeEventListener('console-message', onConsole)
      }
    }

    const nativeControl = window.imHub?.nativeControl
    if (!nativeControl) {
      setControlError('主进程账号控制桥接不可用')
      useStore.getState().setNativeBridgeConnection(accountId, 'failed', '主进程账号控制桥接不可用')
      return
    }
    let disposed = false
    let grantRefreshTimer: ReturnType<typeof setTimeout> | null = null
    let provisionGeneration = 0
    let readyHandled = false
    let hasUsableGrant = false

    const currentTarget = () => {
      const guestWebContentsId = guestWebContentsIdRef.current
      return guestWebContentsId === null ? null : { accountId, guestWebContentsId }
    }

    const applyControlState = (control: NativeControlStateUpdate): void => {
      if (disposed || control.accountId !== accountId) return
      hasUsableGrant = control.expiresAt !== null && control.state !== 'blocked'
      if (control.state === 'ready') {
        setControlError(null)
        useStore.getState().setNativeBridgeConnection(accountId, 'ready')
        return
      }
      const message = control.message ?? '账号控制尚未就绪'
      setControlError(control.state === 'blocked' ? message : null)
      useStore.getState().setNativeBridgeConnection(
        accountId,
        control.state === 'blocked' ? 'failed' : 'waiting',
        message,
      )
    }

    const scheduleGrantRefresh = (expiresAt: string): void => {
      if (grantRefreshTimer) clearTimeout(grantRefreshTimer)
      const delay = Math.max(
        MIN_GRANT_REFRESH_MS,
        Date.parse(expiresAt) - Date.now() - GRANT_REFRESH_MARGIN_MS,
      )
      grantRefreshTimer = setTimeout(() => { void provisionControl() }, delay)
    }

    const provisionControl = createSingleFlight(async (): Promise<void> => {
      const target = currentTarget()
      if (!target || disposed) return
      const generation = ++provisionGeneration
      try {
        const grant = await api.createNativeControlGrant(accountId)
        if (disposed || generation !== provisionGeneration) return
        const control = await nativeControl.configure(target, grant)
        if (disposed || generation !== provisionGeneration) return
        applyControlState(control)
        scheduleGrantRefresh(grant.expiresAt)
      } catch {
        if (disposed || generation !== provisionGeneration) return
        hasUsableGrant = false
        setControlError('账号控制授权建立失败，请确认服务端账号已连接')
        useStore.getState().setNativeBridgeConnection(
          accountId,
          'failed',
          '账号控制授权建立失败，请确认服务端账号已连接',
        )
      }
    })

    const onStartLoading = (): void => {
      readyHandled = false
      provisionGeneration += 1
      if (grantRefreshTimer) clearTimeout(grantRefreshTimer)
      const target = currentTarget()
      if (target) void nativeControl.release(target).catch(() => {})
      setState('loading')
      setDetail('')
      setControlError(null)
      hasUsableGrant = false
      lastContextRevisionRef.current = -1
      useStore.getState().setNativeAccountIdentity(accountId, null)
      useStore.getState().setNativeContext(accountId, null)
      useStore.getState().setNativeBridgeConnection(accountId, 'waiting')
    }

    const onReady = (): void => {
      if (readyHandled) return
      const webview = el as unknown as NativeWebviewLoadProbe
      try {
        if (new URL(webview.getURL()).origin !== new URL(src).origin) throw new Error('unexpected origin')
        guestWebContentsIdRef.current = webview.getWebContentsId()
      } catch {
        console.error(`[native-client:${accountId.slice(0, 8)}] 原生客户端来源校验失败`)
        setState('failed')
        setDetail('原生客户端跳转到了未授权页面，已停止账号控制')
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端来源校验失败')
        return
      }
      readyHandled = true
      setState('ready')
      void provisionControl()
    }

    const onFail = (e: Event): void => {
      const err = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (err.isMainFrame === false) return
      console.error(
        `[native-client:${accountId.slice(0, 8)}] 原生客户端主页面加载失败，错误码 ${String(err.errorCode ?? 'unknown')}`,
      )
      setState('failed')
      setDetail(`${err.errorDescription ?? '未知错误'}（${String(err.errorCode ?? '')}）`)
      useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端页面加载失败')
    }

    const onConsole = (e: Event): void => {
      const message = e as Event & { level?: number }
      if ((message.level ?? 0) >= 2) {
        console.error(`[native-client:${accountId.slice(0, 8)}]`, 'guest 报告 warning/error；请在开发构建中检查隔离控制台')
      }
    }

    const sendEventAck = (command: NativeHostCommand): void => {
      const target = currentTarget()
      if (!target) return
      void nativeControl.sendCommand(target, command).catch(() => {
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端桥接已断开')
      })
    }

    const handleEvent = (event: NativeGuestEvent): void => {
      if (disposed) return
      if (event.type === 'bridge.ready') {
        useStore.getState().setNativeBridgeConnection(accountId, 'waiting', '正在核对 Telegram 登录身份')
        return
      }
      if (event.type === 'account.identity') {
        useStore.getState().setNativeAccountIdentity(accountId, event.platformAccountExternalId)
        if (!hasUsableGrant) void provisionControl()
        return
      }
      if (event.type === 'account.signed-out') {
        useStore.getState().setNativeAccountIdentity(accountId, null)
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', 'Telegram 账号已退出')
        return
      }
      if (event.type === 'command.result') {
        handleNativeCommandResult(accountId, event as NativeCommandResultEvent)
        return
      }
      if (event.type === 'bridge.error') {
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', event.message)
        return
      }
      if (event.type === 'outbox.status') {
        useStore.getState().setNativeOutboxStatus(accountId, {
          pendingCount: event.pendingCount,
          deadLetterCount: event.deadLetterCount,
          isSending: event.isSending,
          lastErrorCode: event.lastErrorCode,
        })
        return
      }
      if (event.type === 'context.changed') {
        const currentContext = useStore.getState().nativeBridgeByAccount[accountId]?.context
        if (event.contextRevision < lastContextRevisionRef.current) return
        if (event.contextRevision === lastContextRevisionRef.current) {
          const incomingConversationId = event.context?.platformConversationId ?? null
          const currentConversationId = currentContext?.platformConversationId ?? null
          if (incomingConversationId !== currentConversationId) {
            useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端复用了当前会话 revision')
          }
          return
        }
        lastContextRevisionRef.current = event.contextRevision
        if (!event.context) {
          useStore.getState().setNativeContext(accountId, null)
          return
        }
        const context = event.context
        useStore.getState().setNativeContext(accountId, {
          ...context,
          contextRevision: event.contextRevision,
          conversationId: null,
        })
        const target = currentTarget()
        if (!target) return
        void nativeControl.syncContext(target, context).then(({ conversationId }) => {
          if (disposed) return
          useStore.getState().resolveNativeConversation(
            accountId,
            event.contextRevision,
            context.platformConversationId,
            conversationId,
          )
          void api.listConversations().then(({ conversations }) => {
            if (!disposed) useStore.getState().setConversations(conversations)
          }).catch(() => {})
        }).catch(() => {
          if (disposed) return
          useStore.getState().setNativeBridgeConnection(accountId, 'failed', '当前会话同步到服务端失败')
        })
        return
      }
      if (event.type === 'composer.state') {
        useStore.getState().applyNativeComposerState(
          accountId,
          event.contextRevision,
          event.platformConversationId,
          event.draft,
          event.canSend,
        )
        return
      }

      const target = currentTarget()
      if (!target) return
      void nativeControl.reportEvent(target, event).then(() => {
        if (disposed) return
        sendEventAck({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'event.ack',
          eventId: event.eventId,
          accepted: true,
          retryable: false,
        })
      }).catch((error: unknown) => {
        if (disposed) return
        const status = nativeProxyStatus(error)
        const retryable = status === null
          || status === 408
          || status === 409
          || status === 425
          || status === 429
          || status >= 500
        useStore.getState().setNativeBridgeConnection(
          accountId,
          retryable ? 'ready' : 'failed',
          retryable ? '消息回传失败，正在等待客户端重试' : '消息回传被服务端拒绝',
        )
        sendEventAck({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'event.ack',
          eventId: event.eventId,
          accepted: false,
          retryable,
        })
      })
    }

    const removeEventListener = nativeControl.onEvent((value) => {
      if (value.accountId === accountId) handleEvent(value.event)
    })
    const removeStateListener = nativeControl.onState(applyControlState)
    const commandTarget = {
      send: (_channel: string, command: unknown): Promise<void> => {
        const target = currentTarget()
        if (!target) return Promise.reject(new Error('原生客户端尚未登记'))
        return nativeControl.sendCommand(target, command as NativeHostCommand)
      },
    }
    const unregisterTarget = registerNativeCommandTarget(accountId, commandTarget)
    el.addEventListener('did-start-loading', onStartLoading)
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-stop-loading', onReady)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    if (nativeWebviewAlreadyLoaded(el as unknown as NativeWebviewLoadProbe, src)) onReady()
    return () => {
      disposed = true
      provisionGeneration += 1
      if (grantRefreshTimer) clearTimeout(grantRefreshTimer)
      const target = currentTarget()
      if (target) void nativeControl.release(target).catch(() => {})
      unregisterTarget()
      removeEventListener()
      removeStateListener()
      el.removeEventListener('did-start-loading', onStartLoading)
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-stop-loading', onReady)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
    }
  }, [accountId, bridgeEnabled, src])

  function openDevTools(): void {
    const el = ref.current as unknown as { openDevTools?(): void } | null
    el?.openDevTools?.()
  }

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: visible ? 'block' : 'none',
    }}>
      {state === 'failed' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 2, background: theme.color.chat,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <EmptyHint>加载失败：{detail}<br />检查网络或代理后重开这个账号</EmptyHint>
        </div>
      )}
      {state === 'loading' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 2, background: theme.color.chat,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span className="ih-pulse" style={{ fontSize: theme.font.size.sm, color: theme.color.textFaint }}>
            正在打开原生界面…
          </span>
        </div>
      )}
      {controlError && state === 'ready' && (
        <div style={{
          position: 'absolute', left: 16, right: 16, top: 12, zIndex: 3,
          padding: '9px 12px', borderRadius: theme.radius.md,
          background: theme.color.dangerSoft, color: theme.color.danger,
          fontSize: theme.font.size.sm, pointerEvents: 'none',
        }}>
          账号控制已阻断：{controlError}
        </div>
      )}
      {import.meta.env.DEV && (
        <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3, opacity: .85 }}>
          <IconButton onClick={openDevTools} label="打开这个账号的调试控制台">⌘</IconButton>
        </div>
      )}
      <webview
        ref={ref as never}
        src={src}
        partition={`persist:native-${accountId}`}
        preload={bridgeEnabled ? nativePreload : undefined}
        useragent={userAgent}
        allowpopups
        style={{ width: '100%', height: '100%', border: 'none', display: 'inline-flex' }}
      />
    </div>
  )
}
