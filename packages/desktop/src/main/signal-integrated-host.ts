import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron'

import {
  SIGNAL_DESKTOP_RELEASE_ALL_CHANNEL,
  SIGNAL_DESKTOP_RELEASE_CHANNEL,
  SIGNAL_DESKTOP_STATE_CHANNEL,
  SIGNAL_DESKTOP_SYNC_CHANNEL,
  type SignalDesktopStateUpdate,
  type SignalDesktopSyncRequest,
} from '../signal-desktop-ipc.js'
import {
  attachImHubWindowRuntime,
  registerIntegratedNativeGuest,
} from './imhub-window-runtime.js'
import {
  signalIntegratedAccountIdAllowed,
  signalIntegratedBounds,
  signalIntegratedServerOrigins,
} from './signal-integrated-policy.js'

const RENDERER_CONTENT_TYPE: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function startRendererServer(connectSources: string): Promise<{ server: Server; url: string }> {
  const rendererRoot = normalize(join(import.meta.dirname, '../renderer'))
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
        const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname
        const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '')
        const file = normalize(join(rendererRoot, relative))
        if (file !== rendererRoot && !file.startsWith(`${rendererRoot}${sep}`)) {
          response.writeHead(404).end()
          return
        }
        const body = await readFile(file)
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self'; connect-src ${connectSources}; frame-src http://localhost:1234 https://web.whatsapp.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
          'Content-Type': RENDERER_CONTENT_TYPE[extname(file)] ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(body)
      } catch {
        response.writeHead(404).end()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('im-hub 本机页面服务启动失败')
  }
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

interface AccountPayload {
  accountId: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSync(value: unknown): SignalDesktopSyncRequest | null {
  if (!record(value)
    || typeof value.accountId !== 'string'
    || typeof value.visible !== 'boolean'
    || !record(value.rect)) return null
  const { x, y, width, height } = value.rect
  if (![x, y, width, height].every(item => typeof item === 'number')) return null
  return {
    accountId: value.accountId,
    visible: value.visible,
    rect: { x: x as number, y: y as number, width: width as number, height: height as number },
  }
}

function parseAccount(value: unknown): AccountPayload | null {
  if (!record(value) || typeof value.accountId !== 'string') return null
  return { accountId: value.accountId }
}

class IntegratedSignalViewHost {
  private accountId: string | null = null
  private nativeGuestRegistered = false
  private ready = false
  private failedMessage: string | null = null

  constructor(
    private readonly hostWindow: BrowserWindow,
    private readonly signalView: WebContentsView,
  ) {}

  install(): void {
    const signalContents = this.signalView.webContents
    signalContents.once('did-finish-load', () => {
      this.ready = true
      this.failedMessage = null
      this.emitCurrentState()
    })
    signalContents.on('render-process-gone', () => {
      this.ready = false
      this.failedMessage = 'Signal Desktop 页面已停止运行；请重新打开集成测试包'
      this.signalView.setVisible(false)
      this.emitCurrentState()
    })

    ipcMain.handle(SIGNAL_DESKTOP_SYNC_CHANNEL, (event, value: unknown) => {
      this.requireHost(event.sender)
      const payload = parseSync(value)
      if (!payload || !signalIntegratedAccountIdAllowed(payload.accountId)) {
        throw new Error('Signal 内嵌视图参数无效')
      }
      if (this.accountId && this.accountId !== payload.accountId) {
        return this.state(payload.accountId, 'failed', '当前原型只允许一个 Signal Desktop 账号')
      }
      this.accountId = payload.accountId
      if (!this.nativeGuestRegistered) {
        registerIntegratedNativeGuest(
          this.hostWindow.webContents,
          this.signalView.webContents,
          payload.accountId,
        )
        this.nativeGuestRegistered = true
      }
      if (!payload.visible) {
        this.signalView.setVisible(false)
        if (this.failedMessage) return this.state(payload.accountId, 'failed', this.failedMessage)
        return this.ready
          ? this.state(payload.accountId, 'ready', null)
          : this.state(payload.accountId, 'starting', '正在打开 Signal Desktop')
      }
      const content = this.hostWindow.getContentBounds()
      const bounds = signalIntegratedBounds(payload.rect, content.width, content.height)
      if (!bounds) {
        this.signalView.setVisible(false)
        return this.state(payload.accountId, 'failed', 'Signal 内嵌区域尺寸无效')
      }
      this.signalView.setBounds(bounds)
      this.signalView.setVisible(this.ready && this.failedMessage === null)
      if (this.failedMessage) return this.state(payload.accountId, 'failed', this.failedMessage)
      return this.ready
        ? this.state(payload.accountId, 'ready', null)
        : this.state(payload.accountId, 'starting', '正在打开 Signal Desktop')
    })

    ipcMain.handle(SIGNAL_DESKTOP_RELEASE_CHANNEL, (event, value: unknown) => {
      this.requireHost(event.sender)
      const payload = parseAccount(value)
      if (!payload || !signalIntegratedAccountIdAllowed(payload.accountId)) {
        throw new Error('Signal 账号参数无效')
      }
      if (payload.accountId === this.accountId) this.signalView.setVisible(false)
    })

    ipcMain.handle(SIGNAL_DESKTOP_RELEASE_ALL_CHANNEL, event => {
      this.requireHost(event.sender)
      this.signalView.setVisible(false)
    })
  }

  private requireHost(sender: WebContents): void {
    if (sender.id !== this.hostWindow.webContents.id) throw new Error('Signal 内嵌宿主来源无效')
  }

  private state(
    accountId: string,
    state: SignalDesktopStateUpdate['state'],
    message: string | null,
  ): SignalDesktopStateUpdate {
    return {
      accountId,
      state,
      message,
      guestWebContentsId: this.nativeGuestRegistered ? this.signalView.webContents.id : null,
    }
  }

  private emitCurrentState(): void {
    if (!this.accountId || this.hostWindow.webContents.isDestroyed()) return
    const update = this.failedMessage
      ? this.state(this.accountId, 'failed', this.failedMessage)
      : this.state(this.accountId, this.ready ? 'ready' : 'starting', this.ready ? null : '正在打开 Signal Desktop')
    this.hostWindow.webContents.send(SIGNAL_DESKTOP_STATE_CHANNEL, update)
  }
}

/**
 * Signal 主进程仍把返回值当作自己的 BrowserWindow；Proxy 只把 webContents 与
 * loadURL 指向 Signal 子视图，其余窗口操作全部落到同一个 im-hub 物理窗口。
 */
export function createHost(signalOptions: BrowserWindowConstructorOptions): BrowserWindow {
  process.env.IM_HUB_SIGNAL_INTEGRATED = '1'
  const serverOrigins = signalIntegratedServerOrigins(
    process.env.IM_HUB_SERVER_URL ?? 'http://127.0.0.1:4000',
  )
  if (!serverOrigins) throw new Error('im-hub 服务端地址无效')
  process.env.IM_HUB_SERVER_URL = serverOrigins.httpOrigin
  const signalWebPreferences = signalOptions.webPreferences
  if (!signalWebPreferences?.preload) throw new Error('Signal 主窗口缺少 preload')

  const hostWindow = new BrowserWindow({
    ...signalOptions,
    show: false,
    width: Math.max(1200, signalOptions.width ?? 0),
    height: Math.max(760, signalOptions.height ?? 0),
    minWidth: 940,
    minHeight: 620,
    title: 'im-hub',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Signal 会给 defaultSession 安装仅允许自身页面的导航过滤器；im-hub
      // 必须使用独立 session，不能靠关闭 webSecurity 绕过。
      partition: 'imhub-shell',
      sandbox: false,
      webviewTag: true,
    },
  })

  Object.defineProperty(hostWindow.webContents, '__imhubHostContents', { value: true })

  const signalView = new WebContentsView({ webPreferences: signalWebPreferences })
  signalView.setVisible(false)
  hostWindow.contentView.addChildView(signalView)

  attachImHubWindowRuntime(hostWindow, {
    nativeBridgePreload: join(import.meta.dirname, '../preload/native-bridge.mjs'),
    sessionNamespace: 'imhub-shell',
  })
  const viewHost = new IntegratedSignalViewHost(hostWindow, signalView)
  viewHost.install()

  const originalFromWebContents = BrowserWindow.fromWebContents.bind(BrowserWindow)
  const integratedFromWebContents = (contents: WebContents): BrowserWindow | null => {
    if (contents.id === signalView.webContents.id) return hostWindow
    return originalFromWebContents(contents)
  }
  Object.defineProperty(BrowserWindow, 'fromWebContents', {
    configurable: true,
    value: integratedFromWebContents,
  })

  let shellLoaded = false
  let rendererServer: Server | null = null
  hostWindow.once('closed', () => {
    rendererServer?.close()
    rendererServer = null
    if (BrowserWindow.fromWebContents === integratedFromWebContents) {
      Object.defineProperty(BrowserWindow, 'fromWebContents', {
        configurable: true,
        value: originalFromWebContents,
      })
    }
  })
  const loadSignal = async (url: string): Promise<void> => {
    await signalView.webContents.loadURL(url)
    if (shellLoaded) return
    shellLoaded = true
    const renderer = await startRendererServer(`${serverOrigins.httpOrigin} ${serverOrigins.wsOrigin}`)
    rendererServer = renderer.server
    await hostWindow.loadURL(renderer.url)
  }

  return new Proxy(hostWindow, {
    get(target, property) {
      if (property === 'webContents') return signalView.webContents
      if (property === 'loadURL') return loadSignal
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    },
  })
}
