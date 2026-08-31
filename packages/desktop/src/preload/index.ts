import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  NativeControlGrantResponse,
  NativeControlStateUpdate,
  NativeConversationContext,
  NativeGuestEvent,
  NativeHostCommand,
} from '@im-hub/shared'
import {
  NATIVE_CONTROL_CONFIGURE_CHANNEL,
  NATIVE_CONTROL_EVENT_CHANNEL,
  NATIVE_CONTROL_RELEASE_ALL_CHANNEL,
  NATIVE_CONTROL_RELEASE_CHANNEL,
  NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL,
  NATIVE_CONTROL_REPORT_EVENT_CHANNEL,
  NATIVE_CONTROL_SEND_COMMAND_CHANNEL,
  NATIVE_CONTROL_STATE_CHANNEL,
  NATIVE_CONTROL_SYNC_CONTEXT_CHANNEL,
} from '../native-control-ipc.js'
import {
  SIGNAL_DESKTOP_RELEASE_ALL_CHANNEL,
  SIGNAL_DESKTOP_RELEASE_CHANNEL,
  SIGNAL_DESKTOP_STATE_CHANNEL,
  SIGNAL_DESKTOP_SYNC_CHANNEL,
  type SignalDesktopRect,
  type SignalDesktopStateUpdate,
} from '../signal-desktop-ipc.js'

interface SessionPayload {
  token: string
  user: { id: string; role: string; displayName: string }
}

interface NativeControlTarget {
  accountId: string
  guestWebContentsId: number
}

interface NativeControlEventEnvelope {
  accountId: string
  event: NativeGuestEvent
}

function onIpc<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => { listener(value) }
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

/**
 * 可信渲染进程的普通业务仍直接跟服务端 HTTP/WS 通信；平台 guest 的控制与翻译
 * 则只能经 nativeControl 进入主进程边界。
 * session 这三个方法只做"存/取/删一份 { token, user } JSON"，不暴露文件路径、
 * 不暴露 safeStorage 本身、不暴露任意读写文件的能力——渲染层拿不到比
 * "保存/恢复/清除登录态"更大的权限。
 */
contextBridge.exposeInMainWorld('imHub', {
  platform: process.platform,
  serverUrl: process.env.IM_HUB_SERVER_URL ?? 'http://localhost:4000',
  // 只给可信的外壳渲染进程。主进程在 will-attach-webview 里会再次覆盖并校验
  // preload，不能把页面传来的 preload 属性当成安全边界。
  nativeBridgePreload: pathToFileURL(join(import.meta.dirname, 'native-bridge.mjs')).toString(),
  session: {
    save: (payload: SessionPayload): Promise<boolean> => ipcRenderer.invoke('session:save', payload),
    load: (): Promise<SessionPayload | null> => ipcRenderer.invoke('session:load'),
    clear: (): Promise<void> => ipcRenderer.invoke('session:clear'),
  },
  external: {
    open: (url: string): Promise<void> => ipcRenderer.invoke('external:open', url),
  },
  nativeControl: {
    configure: (target: NativeControlTarget, grant: NativeControlGrantResponse): Promise<NativeControlStateUpdate> =>
      ipcRenderer.invoke(NATIVE_CONTROL_CONFIGURE_CHANNEL, { ...target, grant: grant.grant }),
    release: (target: NativeControlTarget): Promise<void> =>
      ipcRenderer.invoke(NATIVE_CONTROL_RELEASE_CHANNEL, target),
    releaseAll: (): Promise<void> => ipcRenderer.invoke(NATIVE_CONTROL_RELEASE_ALL_CHANNEL),
    removeAccount: (accountId: string): Promise<void> =>
      ipcRenderer.invoke(NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL, { accountId }),
    sendCommand: (target: NativeControlTarget, command: NativeHostCommand): Promise<void> =>
      ipcRenderer.invoke(NATIVE_CONTROL_SEND_COMMAND_CHANNEL, { ...target, command }),
    syncContext: (target: NativeControlTarget, context: NativeConversationContext): Promise<{ conversationId: string }> =>
      ipcRenderer.invoke(NATIVE_CONTROL_SYNC_CONTEXT_CHANNEL, { ...target, value: context }),
    reportEvent: (target: NativeControlTarget, event: NativeGuestEvent): Promise<{ accepted: boolean; duplicate?: boolean }> =>
      ipcRenderer.invoke(NATIVE_CONTROL_REPORT_EVENT_CHANNEL, { ...target, value: event }),
    onEvent: (listener: (value: NativeControlEventEnvelope) => void): (() => void) =>
      onIpc(NATIVE_CONTROL_EVENT_CHANNEL, listener),
    onState: (listener: (value: NativeControlStateUpdate) => void): (() => void) =>
      onIpc(NATIVE_CONTROL_STATE_CHANNEL, listener),
  },
  signalDesktop: process.env.IM_HUB_SIGNAL_INTEGRATED === '1' ? {
    sync: (
      accountId: string,
      rect: SignalDesktopRect,
      visible: boolean,
    ): Promise<SignalDesktopStateUpdate> =>
      ipcRenderer.invoke(SIGNAL_DESKTOP_SYNC_CHANNEL, { accountId, rect, visible }),
    release: (accountId: string): Promise<void> =>
      ipcRenderer.invoke(SIGNAL_DESKTOP_RELEASE_CHANNEL, { accountId }),
    releaseAll: (): Promise<void> => ipcRenderer.invoke(SIGNAL_DESKTOP_RELEASE_ALL_CHANNEL),
    onState: (listener: (value: SignalDesktopStateUpdate) => void): (() => void) =>
      onIpc(SIGNAL_DESKTOP_STATE_CHANNEL, listener),
  } : undefined,
})
