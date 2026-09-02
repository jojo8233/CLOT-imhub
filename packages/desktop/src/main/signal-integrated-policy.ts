import type { SignalDesktopRect } from '../signal-desktop-ipc.js'

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function signalIntegratedAccountIdAllowed(accountId: string): boolean {
  return ACCOUNT_ID.test(accountId)
}

export function signalIntegratedServerOrigins(raw: string): {
  httpOrigin: string
  wsOrigin: string
} | null {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== '') return null
    const websocket = new URL(url.origin)
    websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return { httpOrigin: url.origin, wsOrigin: websocket.origin }
  } catch {
    return null
  }
}

/** WebContentsView 使用窗口内容区坐标，不叠加屏幕绝对坐标。 */
export function signalIntegratedBounds(
  rect: SignalDesktopRect,
  hostWidth: number,
  hostHeight: number,
): SignalDesktopRect | null {
  if (![rect.x, rect.y, rect.width, rect.height, hostWidth, hostHeight].every(Number.isFinite)) {
    return null
  }
  if (rect.width < 1 || rect.height < 1 || hostWidth < 1 || hostHeight < 1) return null

  const left = Math.max(0, Math.min(hostWidth, Math.round(rect.x)))
  const top = Math.max(0, Math.min(hostHeight, Math.round(rect.y)))
  const right = Math.max(left, Math.min(hostWidth, Math.round(rect.x + rect.width)))
  const bottom = Math.max(top, Math.min(hostHeight, Math.round(rect.y + rect.height)))
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
