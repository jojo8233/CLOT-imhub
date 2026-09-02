export const SIGNAL_DESKTOP_SYNC_CHANNEL = 'imhub:signal-desktop-sync'
export const SIGNAL_DESKTOP_RELEASE_CHANNEL = 'imhub:signal-desktop-release'
export const SIGNAL_DESKTOP_RELEASE_ALL_CHANNEL = 'imhub:signal-desktop-release-all'
export const SIGNAL_DESKTOP_STATE_CHANNEL = 'imhub:signal-desktop-state'

export interface SignalDesktopRect {
  x: number
  y: number
  width: number
  height: number
}

export type SignalDesktopState = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

export interface SignalDesktopStateUpdate {
  accountId: string
  state: SignalDesktopState
  message: string | null
  /** Signal guest 只暴露不可复用的 Electron 运行时 id，供可信外壳配置短时 grant。 */
  guestWebContentsId: number | null
}

export interface SignalDesktopSyncRequest {
  accountId: string
  rect: SignalDesktopRect
  visible: boolean
}
