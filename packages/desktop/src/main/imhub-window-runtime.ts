import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BrowserWindow, app, ipcMain, safeStorage, shell, type WebContents } from 'electron'

import {
  nativeAccountIdFromPartition,
  nativeClientBridgeAllowed,
  nativeClientPermissionAllowed,
  nativeClientUrlAllowed,
  nativePartitionAllowed,
} from './native-host-policy.js'
import { NativeControlHost } from './native-control-host.js'

interface PendingNativeAccount {
  accountId: string
  bridgeEnabled: boolean
}

interface SessionPayload {
  token: string
  user: { id: string; role: string; displayName: string }
}

export interface ImHubWindowRuntimeOptions {
  /** 由实际入口解析；共享 chunk 自己的 import.meta.dirname 不等于 out/main。 */
  nativeBridgePreload: string
  /** Signal 与 im-hub 共进程时，将外壳会话文件放进独立子目录。 */
  sessionNamespace?: string
}

const nativeControlHost = new NativeControlHost(
  process.env.IM_HUB_SERVER_URL ?? 'http://localhost:4000',
)
const pendingNativeAccountsByHost = new Map<number, PendingNativeAccount[]>()
const trustedHostIds = new Set<number>()

let installed = false
let sessionNamespace: string | undefined

function tokenFile(): string {
  const root = app.getPath('userData')
  return sessionNamespace ? join(root, sessionNamespace, 'session.bin') : join(root, 'session.bin')
}

function requireTrustedHost(sender: WebContents): void {
  if (!trustedHostIds.has(sender.id)) throw new Error('未授权的宿主调用')
}

function installRuntime(options: ImHubWindowRuntimeOptions): void {
  if (installed) {
    if (options.sessionNamespace !== sessionNamespace) {
      throw new Error('im-hub 宿主会话命名空间不能在同一进程内切换')
    }
    return
  }
  installed = true
  sessionNamespace = options.sessionNamespace
  nativeControlHost.install()

  /** token 只经 safeStorage 加密后落盘；没有系统密钥环时不做明文兜底。 */
  ipcMain.handle('session:save', (event, payload: SessionPayload) => {
    requireTrustedHost(event.sender)
    if (!safeStorage.isEncryptionAvailable()) return false
    const file = tokenFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(JSON.stringify(payload)))
    return true
  })

  ipcMain.handle('session:load', (event): SessionPayload | null => {
    requireTrustedHost(event.sender)
    try {
      const file = tokenFile()
      if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null
      const raw = safeStorage.decryptString(readFileSync(file))
      return JSON.parse(raw) as SessionPayload
    } catch {
      return null
    }
  })

  ipcMain.handle('session:clear', event => {
    requireTrustedHost(event.sender)
    rmSync(tokenFile(), { force: true })
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    // guest 始终是不可信页面。只给 WhatsApp 精确主框架开放持久存储。
    contents.session.setPermissionCheckHandler((requestingContents, permission, requestingOrigin, details) => {
      return requestingContents?.id === contents.id
        && nativeClientPermissionAllowed(requestingOrigin, permission, details.isMainFrame)
    })
    contents.session.setPermissionRequestHandler((requestingContents, permission, callback, details) => {
      callback(
        requestingContents.id === contents.id
        && nativeClientPermissionAllowed(details.requestingUrl, permission, details.isMainFrame),
      )
    })

    const blockUntrustedNavigation = (event: Electron.Event, url: string): void => {
      if (!nativeClientUrlAllowed(url)) event.preventDefault()
    }
    contents.on('will-navigate', blockUntrustedNavigation)
    contents.on('will-redirect', blockUntrustedNavigation)
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
      } catch {
        // 非法 URL 直接拒绝，不把原始值写入日志。
      }
      return { action: 'deny' }
    })
  })
}

export function attachImHubWindowRuntime(
  win: BrowserWindow,
  options: ImHubWindowRuntimeOptions,
): void {
  installRuntime(options)
  const hostId = win.webContents.id
  trustedHostIds.add(hostId)
  nativeControlHost.attachHost(win.webContents)
  win.webContents.once('destroyed', () => {
    trustedHostIds.delete(hostId)
    pendingNativeAccountsByHost.delete(hostId)
  })

  // webview 属性来自渲染进程，真正附着前再次校验来源与 partition。
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!nativeClientUrlAllowed(params.src) || !nativePartitionAllowed(params.partition ?? '')) {
      event.preventDefault()
      console.error('[native-host] 已阻止非法 webview 来源或 partition')
      return
    }
    const accountId = nativeAccountIdFromPartition(params.partition ?? '')
    if (!accountId) {
      event.preventDefault()
      console.error('[native-host] 已阻止无法解析账号的 webview partition')
      return
    }
    const pending = pendingNativeAccountsByHost.get(hostId) ?? []
    const bridgeEnabled = nativeClientBridgeAllowed(params.src)
    pending.push({ accountId, bridgeEnabled })
    pendingNativeAccountsByHost.set(hostId, pending)
    if (bridgeEnabled) {
      webPreferences.preload = options.nativeBridgePreload
    } else {
      delete webPreferences.preload
    }
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.webviewTag = false
    webPreferences.sandbox = false
  })

  win.webContents.on('did-attach-webview', (_event, contents) => {
    const pending = pendingNativeAccountsByHost.get(hostId) ?? []
    const target = pending.shift()
    if (pending.length === 0) pendingNativeAccountsByHost.delete(hostId)
    if (!target) {
      contents.close()
      console.error('[native-host] 已关闭缺少账号绑定的 webview')
      return
    }
    if (target.bridgeEnabled) {
      nativeControlHost.registerGuest(contents, target.accountId, hostId)
    }
  })
}

/**
 * Signal Desktop 与外壳同进程时没有 did-attach-webview 事件，由同窗口宿主在账号
 * UUID 已绑定后显式登记。后续授权、事件代理和 ACK 仍走同一个 NativeControlHost。
 */
export function registerIntegratedNativeGuest(
  hostContents: WebContents,
  guestContents: WebContents,
  accountId: string,
): void {
  requireTrustedHost(hostContents)
  nativeControlHost.registerGuest(guestContents, accountId, hostContents.id)
  console.info('[signal-bridge] integrated guest registered')
}
