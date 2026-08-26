import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NativeCommandResultEvent } from '@im-hub/shared'
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from '@im-hub/shared'
import {
  api,
  getCurrentUser,
  getServerUrl,
  getSessionToken,
  HttpError,
  NetworkError,
  UnauthorizedError,
  type NativeServerEvent,
  type AccountRow,
  type SessionUser,
} from '../api/client.js'
import {
  NATIVE_COMMAND_CHANNEL,
  NATIVE_EVENT_CHANNEL,
  handleNativeCommandResult,
  parseNativeGuestEvent,
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
 * 关键取舍：webview 一旦创建就**不卸载**，只用 display 切换显示。
 * Telegram Web 重新加载一次要重连、重拉会话列表、丢掉滚动位置，来回切账号
 * 时会明显卡顿闪烁。常驻的代价是内存，但切换体验是这条路线的核心价值。
 *
 * 安全边界：webview 里跑的是第三方站点，一律当不可信内容。它拿不到
 * window.imHub，也没有 node 能力；将来注入翻译要走 webview 自己的 preload，
 * 只暴露最小接口。
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
const WEB_CLIENT: Record<string, string> = {
  // 开发期指向 telegram-tt 的 Vite 服务器（代码/telegram-tt，npm run dev）。
  // 打包时这里要换成随应用分发的静态产物地址，见 native-client-pivot 设计文档。
  telegram: 'http://localhost:1234/',
}

const PLATFORM_PHASE: Record<string, string> = {
  signal: 'M5',
  whatsapp: 'M6',
  zoom: 'M8',
}

export function nativeClientSupported(platform: string): boolean {
  return platform in WEB_CLIENT
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

  // 已经建过 webview 的账号。建过就一直留着，只切显隐
  const [mounted, setMounted] = useState<string[]>([])

  const active = accounts.find(a => a.id === activeAccountId) ?? null
  const currentUser = getCurrentUser()
  const activeOwnedByCurrentUser = nativeAccountControllable(active, currentUser)
  const supportsWebview = webviewSupported()

  useEffect(() => {
    if (!active
      || !activeOwnedByCurrentUser
      || !supportsWebview
      || !nativeClientSupported(active.platform)) return
    setMounted(prev => prev.includes(active.id) ? prev : [...prev, active.id])
  }, [active, activeOwnedByCurrentUser, supportsWebview])

  // 每个常驻 webview 都记住自己的当前会话。切回某账号时恢复它的服务端会话，
  // 不能继续显示上一个账号的客户资料，也不该要求平台再次发 context.changed。
  useEffect(() => {
    setActiveConversation(activeNativeConversationId)
  }, [activeAccountId, activeNativeConversationId, setActiveConversation])

  let overlay: ReactNode = null
  if (!active) {
    overlay = <EmptyHint>从顶栏选一个账号<br />这里会打开它的原生界面</EmptyHint>
  } else if (!nativeClientSupported(active.platform)) {
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
  } else if (!supportsWebview) {
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
      {mounted.map(id => {
        const acc = accounts.find(a => a.id === id)
        // mounted 是历史记忆，不是授权事实。owner/角色变化后必须立即卸载
        // 已失权的隐藏 pane，避免它继续注入 token、保持 command target。
        if (!acc
          || !nativeClientSupported(acc.platform)
          || !nativeAccountControllable(acc, currentUser)) return null
        return (
          <WebviewPane key={id} accountId={id} src={WEB_CLIENT[acc.platform]!} visible={id === active?.id} />
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

function WebviewPane({ accountId, src, visible }: {
  accountId: string
  src: string
  visible: boolean
}) {
  const ref = useRef<HTMLElement>(null)
  // 放 ref 里：dom-ready 回调只绑定一次，不该因为 token 变化重新绑监听
  const tokenRef = useRef(getSessionToken() ?? '')
  const serverUrlRef = useRef(getServerUrl())
  const lastContextRevisionRef = useRef(-1)
  tokenRef.current = getSessionToken() ?? ''
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [detail, setDetail] = useState<string>('')
  const nativePreload = (globalThis as {
    imHub?: { nativeBridgePreload?: string }
  }).imHub?.nativeBridgePreload

  // 超时兜底：转圈转到天荒地老是最没用的状态，用户不知道该等还是该重来
  useEffect(() => {
    if (state !== 'loading') return
    const timer = setTimeout(() => {
      setState('failed')
      setDetail(import.meta.env.DEV
        ? '等了 20 秒还没加载出来。确认 telegram-tt 的开发服务器在跑（代码/telegram-tt 目录下 npm run dev），然后点右下角 ⌘ 看控制台'
        : '等了 20 秒还没加载出来。检查网络或代理后重新打开应用')
      useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端页面加载超时')
    }, READY_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [accountId, state])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    const onStartLoading = (): void => {
      // guest 进程重新加载后，上一进程报告的会话 revision 已经失效。必须等新进程
      // 重新发 context.changed，不能短暂复用旧会话去翻译或发送。
      setState('loading')
      setDetail('')
      lastContextRevisionRef.current = -1
      useStore.getState().setNativeContext(accountId, null)
      useStore.getState().setNativeBridgeConnection(accountId, 'waiting')
    }
    const onReady = (): void => {
      const currentUrl = (el as unknown as { getURL(): string }).getURL()
      try {
        if (new URL(currentUrl).origin !== new URL(src).origin) throw new Error('unexpected origin')
      } catch {
        setState('failed')
        setDetail('原生客户端跳转到了未授权页面，已停止配置注入')
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端来源校验失败')
        return
      }
      setState('ready')
      // 把服务端地址与登录态注入补丁版客户端，它据此调 /api/translate/batch。
      //
      // 用 executeJavaScript 而不是 <webview preload>：preload 要单独走一遍
      // 构建配置，而这里注入的时机（dom-ready）远早于用户点开会话触发翻译，
      // 够用。将来要在页面脚本之前注入别的东西时再改成 preload。
      const cfg = JSON.stringify({ serverUrl: serverUrlRef.current, token: tokenRef.current })
      // 写完立刻回读一次确认。注入是整条翻译链路的第一环，
      // 它悄悄失败的话，后面所有开关看起来都是对的，就是没有译文。
      void (el as unknown as { executeJavaScript(code: string): Promise<unknown> })
        .executeJavaScript(`window.__IM_HUB__ = ${cfg}; Boolean(window.__IM_HUB__ && window.__IM_HUB__.token)`)
        .then((ok: unknown) => {
          if (ok === true) console.log('[native] im-hub 配置已注入', serverUrlRef.current)
          else console.error('[native] im-hub 配置注入后回读失败，翻译不会生效')
        })
        .catch(() => { console.error('[native] 注入 im-hub 配置失败（详情已脱敏）') })
    }
    const onFail = (e: Event): void => {
      const err = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // 子资源加载失败很常见（广告、统计、被墙的 CDN），只有主框架失败才算真挂了
      if (err.isMainFrame === false) return
      setState('failed')
      setDetail(`${err.errorDescription ?? '未知错误'}（${String(err.errorCode ?? '')}）`)
      useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端页面加载失败')
    }
    // guest 仍有 M3 待收口的历史 token 注入。不得原样转发 console
    // message/sourceId，否则页面 console.log(token) 会把 JWT 带进外壳日志。
    const onConsole = (e: Event): void => {
      const m = e as Event & { level?: number }
      const tag = `[tg:${accountId.slice(0, 8)}]`
      if ((m.level ?? 0) >= 2) {
        console.error(tag, 'guest 报告 warning/error；请在开发构建中检查它的隔离控制台')
      }
    }
    const onIpcMessage = (e: Event): void => {
      if (disposed) return
      const ipc = e as Event & { channel?: string; args?: unknown[] }
      if (ipc.channel !== NATIVE_EVENT_CHANNEL) return
      const event = parseNativeGuestEvent(ipc.args?.[0])
      if (!event) {
        console.error(`[native:${accountId.slice(0, 8)}] 已拒绝无效桥接事件`)
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端发送了无效桥接事件')
        return
      }

      if (event.type === 'bridge.ready') {
        useStore.getState().setNativeBridgeConnection(accountId, 'ready')
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
      if (event.type === 'context.changed') {
        const currentContext = useStore.getState().nativeBridgeByAccount[accountId]?.context
        if (event.contextRevision < lastContextRevisionRef.current) return
        if (event.contextRevision === lastContextRevisionRef.current) {
          const incomingConversationId = event.context?.platformConversationId ?? null
          const currentConversationId = currentContext?.platformConversationId ?? null
          if (incomingConversationId !== currentConversationId) {
            useStore.getState().setNativeBridgeConnection(
              accountId,
              'failed',
              '原生客户端复用了当前会话 revision',
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
        const pendingContext = {
          ...context,
          contextRevision: event.contextRevision,
          conversationId: null,
        }
        useStore.getState().setNativeContext(accountId, pendingContext)
        void api.syncNativeContext(accountId, context).then(({ conversationId }) => {
          if (disposed) return
          // UUID 一旦解析成功就立即落到当前 context。会话列表刷新只是为了右栏
          // 展示资料，不能让它的瞬时网络失败阻断输入坞整次会话解析。
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
          const current = useStore.getState().nativeBridgeByAccount[accountId]?.context
          if (current?.contextRevision === event.contextRevision
            && current.platformConversationId === context.platformConversationId) {
            useStore.getState().setNativeBridgeConnection(accountId, 'ready', '当前会话同步到服务端失败')
          }
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

      void api.reportNativeEvent(accountId, event as NativeServerEvent).then(() => {
        if (disposed) return
        const bridge = useStore.getState().nativeBridgeByAccount[accountId]
        if (bridge?.error === '消息回传失败，正在等待客户端重试') {
          useStore.getState().setNativeBridgeConnection(accountId, 'ready')
        }
        sendEventAck({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'event.ack', eventId: event.eventId, accepted: true, retryable: false,
        })
      }).catch((error: unknown) => {
        if (disposed) return
        const retryableHttpStatus = error instanceof HttpError
          && (error.status === 408
            || error.status === 409
            || error.status === 425
            || error.status === 429
            || error.status >= 500)
        // 只有明确的永久 4xx 才让 outbox 放弃。401 会同时触发外壳
        // 登出，但事件必须留在 guest，下次登录后才能补报存档。
        const retryable = error instanceof NetworkError
          || error instanceof UnauthorizedError
          || retryableHttpStatus
          || !(error instanceof HttpError)
        useStore.getState().setNativeBridgeConnection(
          accountId,
          retryable ? 'ready' : 'failed',
          retryable ? '消息回传失败，正在等待客户端重试' : '消息回传被服务端拒绝',
        )
        sendEventAck({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'event.ack', eventId: event.eventId, accepted: false, retryable,
        })
      })
    }
    const commandTarget = el as unknown as { send(channel: string, ...args: unknown[]): void }
    function sendEventAck(command: {
      protocolVersion: typeof NATIVE_BRIDGE_PROTOCOL_VERSION
      type: 'event.ack'
      eventId: string
      accepted: boolean
      retryable: boolean
    }): void {
      try {
        commandTarget.send(NATIVE_COMMAND_CHANNEL, command)
      } catch {
        useStore.getState().setNativeBridgeConnection(accountId, 'failed', '原生客户端桥接已断开')
      }
    }
    const unregisterTarget = registerNativeCommandTarget(accountId, commandTarget)
    el.addEventListener('did-start-loading', onStartLoading)
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    el.addEventListener('ipc-message', onIpcMessage)
    return () => {
      disposed = true
      unregisterTarget()
      el.removeEventListener('did-start-loading', onStartLoading)
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
      el.removeEventListener('ipc-message', onIpcMessage)
    }
  }, [accountId])

  function openDevTools(): void {
    const el = ref.current as unknown as { openDevTools?(): void } | null
    el?.openDevTools?.()
  }

  return (
    <div style={{
      position: 'absolute', inset: 0,
      // 用 display 切换而不是卸载：重新加载一次要重连、重拉会话、丢滚动位置
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
      {/* guest DevTools 只在开发构建开放，生产外壳不能让普通用户直接执行页面脚本。 */}
      {import.meta.env.DEV && (
        <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3, opacity: .85 }}>
          <IconButton onClick={openDevTools} label="打开这个账号的调试控制台">⌘</IconButton>
        </div>
      )}
      <webview
        ref={ref as never}
        src={src}
        // 登录态隔离就靠它：一个账号一个 partition，等于一个独立浏览器
        partition={`persist:native-${accountId}`}
        preload={nativePreload}
        allowpopups
        style={{ width: '100%', height: '100%', border: 'none', display: 'inline-flex' }}
      />
    </div>
  )
}
