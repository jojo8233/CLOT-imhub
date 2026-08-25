import { useEffect, useRef, useState } from 'react'
import { getServerUrl, getSessionToken } from '../api/client.js'
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

export function nativeClientSupported(platform: string): boolean {
  return platform in WEB_CLIENT
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

  // 已经建过 webview 的账号。建过就一直留着，只切显隐
  const [mounted, setMounted] = useState<string[]>([])

  const active = accounts.find(a => a.id === activeAccountId) ?? null

  useEffect(() => {
    if (!active || !nativeClientSupported(active.platform)) return
    setMounted(prev => prev.includes(active.id) ? prev : [...prev, active.id])
  }, [active])

  if (!webviewSupported()) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.color.chat }}>
        <EmptyHint>
          原生界面只能在桌面客户端里打开。
          <br />
          当前这个窗口是浏览器，浏览器里没有 webview 这个东西。
          <br />
          <span style={{ color: theme.color.textMuted }}>
            请切换到 im-hub 应用窗口（Cmd+Tab），或点 Dock 里的图标。
          </span>
        </EmptyHint>
      </div>
    )
  }

  if (!active) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.color.chat }}>
        <EmptyHint>从顶栏选一个账号<br />这里会打开它的原生界面</EmptyHint>
      </div>
    )
  }

  if (!nativeClientSupported(active.platform)) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.color.chat }}>
        <EmptyHint>
          {PLATFORM_LABEL[active.platform] ?? active.platform} 没有网页版，嵌不进来。
          <br />
          这个平台只能走「会话工作台」，或者单独做补丁版桌面端。
        </EmptyHint>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', background: theme.color.chat }}>
      {mounted.map(id => {
        const acc = accounts.find(a => a.id === id)
        if (!acc || !nativeClientSupported(acc.platform)) return null
        return (
          <WebviewPane key={id} accountId={id} src={WEB_CLIENT[acc.platform]!} visible={id === active.id} />
        )
      })}
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
  tokenRef.current = getSessionToken() ?? ''
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [detail, setDetail] = useState<string>('')

  // 超时兜底：转圈转到天荒地老是最没用的状态，用户不知道该等还是该重来
  useEffect(() => {
    if (state !== 'loading') return
    const timer = setTimeout(() => {
      setState('failed')
      setDetail('等了 20 秒还没加载出来。确认 telegram-tt 的开发服务器在跑（代码/telegram-tt 目录下 npm run dev），然后点右下角 ⌘ 看控制台')
    }, READY_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [state])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onReady = (): void => {
      setState('ready')
      // 把服务端地址与登录态注入补丁版客户端，它据此调 /api/translate/batch。
      //
      // 用 executeJavaScript 而不是 <webview preload>：preload 要单独走一遍
      // 构建配置，而这里注入的时机（dom-ready）远早于用户点开会话触发翻译，
      // 够用。将来要在页面脚本之前注入别的东西时再改成 preload。
      const cfg = JSON.stringify({ serverUrl: serverUrlRef.current, token: tokenRef.current })
      void (el as unknown as { executeJavaScript(code: string): Promise<unknown> })
        .executeJavaScript(`window.__IM_HUB__ = ${cfg}`)
        .catch((err: unknown) => { console.error('[native] 注入 im-hub 配置失败', err) })
    }
    const onFail = (e: Event): void => {
      const err = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // 子资源加载失败很常见（广告、统计、被墙的 CDN），只有主框架失败才算真挂了
      if (err.isMainFrame === false) return
      setState('failed')
      setDetail(`${err.errorDescription ?? '未知错误'}（${String(err.errorCode ?? '')}）`)
    }
    // webview 是独立的渲染进程，它的 console 不会出现在外层 DevTools 里。
    // 不转发的话，里面报什么错在外面完全看不见——只能靠猜。
    const onConsole = (e: Event): void => {
      const m = e as Event & { level?: number; message?: string; line?: number; sourceId?: string }
      const tag = `[tg:${accountId.slice(0, 8)}]`
      const where = m.sourceId ? ` (${m.sourceId}:${String(m.line ?? '')})` : ''
      // level 2=warning 3=error，只把这两类抬到 error，其余保持 log 免得刷屏
      if ((m.level ?? 0) >= 2) console.error(tag, m.message, where)
      else console.log(tag, m.message)
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
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
      {/* 调试入口。webview 出问题时这是唯一能看到里面发生什么的地方 */}
      <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 3, opacity: .85 }}>
        <IconButton onClick={openDevTools} label="打开这个账号的调试控制台">⌘</IconButton>
      </div>
      <webview
        ref={ref as never}
        src={src}
        // 登录态隔离就靠它：一个账号一个 partition，等于一个独立浏览器
        partition={`persist:native-${accountId}`}
        allowpopups
        style={{ width: '100%', height: '100%', border: 'none', display: 'inline-flex' }}
      />
    </div>
  )
}
