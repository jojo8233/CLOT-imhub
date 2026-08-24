import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { EmptyHint } from './ui.js'

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

/** 各平台的网页版地址。没有网页版的平台不在这里，只能走别的路。 */
const WEB_CLIENT: Record<string, string> = {
  telegram: 'https://web.telegram.org/k/',
}

export function nativeClientSupported(platform: string): boolean {
  return platform in WEB_CLIENT
}

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
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [detail, setDetail] = useState<string>('')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onReady = (): void => { setState('ready') }
    const onFail = (e: Event): void => {
      const err = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // 子资源加载失败很常见（广告、统计、被墙的 CDN），只有主框架失败才算真挂了
      if (err.isMainFrame === false) return
      setState('failed')
      setDetail(`${err.errorDescription ?? '未知错误'}（${String(err.errorCode ?? '')}）`)
    }
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [])

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
