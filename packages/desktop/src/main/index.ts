import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { BrowserWindow, app, ipcMain, safeStorage, shell } from 'electron'
import {
  nativeAccountIdFromPartition,
  nativeClientBridgeAllowed,
  nativeClientUrlAllowed,
  nativePartitionAllowed,
} from './native-host-policy.js'
import { NativeControlHost } from './native-control-host.js'

const nativeControlHost = new NativeControlHost(
  process.env.IM_HUB_SERVER_URL ?? 'http://localhost:4000',
)
nativeControlHost.install()
interface PendingNativeAccount {
  accountId: string
  bridgeEnabled: boolean
}

const pendingNativeAccountsByHost = new Map<number, PendingNativeAccount[]>()

const tokenFile = (): string => join(app.getPath('userData'), 'session.bin')

interface SessionPayload {
  token: string
  user: { id: string; role: string; displayName: string }
}

/**
 * token 走 OS 钥匙串加密（safeStorage），不落明文。存的不只是裸 token，而是
 * { token, user } 这个 JSON——user（id/role/displayName）来自登录响应，不是新的
 * 敏感信息，一起加密存起来是为了重启后免登录时不用再打一次服务端就能在角落里
 * 显示"当前登录：XXX"。整体依然只经过 safeStorage.encryptString，没有明文落盘路径。
 *
 * safeStorage 在 Linux 上可能没有可用的后端（没装 gnome-keyring/kwallet 等），
 * isEncryptionAvailable() 会返回 false——这种情况下明确拒绝持久化，退化成
 * "每次重启都要重新登录"，绝不退回明文存储。
 */
ipcMain.handle('session:save', (_e, payload: SessionPayload) => {
  if (!safeStorage.isEncryptionAvailable()) return false
  writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify(payload)))
  return true
})

ipcMain.handle('session:load', (): SessionPayload | null => {
  try {
    if (!existsSync(tokenFile()) || !safeStorage.isEncryptionAvailable()) return null
    const raw = safeStorage.decryptString(readFileSync(tokenFile()))
    return JSON.parse(raw) as SessionPayload
  } catch {
    return null // 钥匙串换了、文件损坏、内容对不上——当成没登录过，不要崩
  }
})

ipcMain.handle('session:clear', () => {
  rmSync(tokenFile(), { force: true })
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    // 会话页是"功能中心 + 会话列表 + 聊天区"三栏并排。再窄下去只能开始收栏，
    // 一旦收掉会话列表，选中会话之后就没有入口再换一个会话了。与其做一堆
    // 折叠态的兜底交互，不如从窗口层面挡住——桌面端本来也没有更窄的场景。
    minWidth: 940,
    minHeight: 620,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload（.mjs）在沙箱模式下不会被加载，而 contextIsolation 为 true 时
      // sandbox 默认也是 true——两者叠加会让 preload 静默失效、window.imHub 为
      // undefined、渲染进程白屏且无任何提示。真正的隔离由上面两项保证。
      sandbox: false,
      // 套壳原生客户端需要 <webview>：每个平台账号一个独立 partition 的
      // webview，登录态彼此隔离，这就是"多开"的实现方式。
      //
      // webview 里加载的是第三方站点，必须当作不可信内容：它自己的 preload
      // 只暴露翻译相关的最小接口，绝不把 window.imHub 或 node 能力带进去。
      webviewTag: true,
    },
  })
  nativeControlHost.attachHost(win.webContents)

  // webview 属性来自渲染进程，不能直接信任。真正附着 guest WebContents 前，主进程
  // 再校验来源与 partition，并强制使用我们构建的受控 preload。
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
    const pending = pendingNativeAccountsByHost.get(win.webContents.id) ?? []
    const bridgeEnabled = nativeClientBridgeAllowed(params.src)
    pending.push({ accountId, bridgeEnabled })
    pendingNativeAccountsByHost.set(win.webContents.id, pending)
    if (bridgeEnabled) {
      webPreferences.preload = join(import.meta.dirname, '../preload/native-bridge.mjs')
    } else {
      // Official shell-only pages must not see the im-hub bridge until their
      // platform-specific identity and event contract is implemented.
      delete webPreferences.preload
    }
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.webviewTag = false
    // 与外壳 preload 相同：当前 ESM preload 在 sandbox 下不会加载。
    webPreferences.sandbox = false
  })

  win.webContents.on('did-attach-webview', (_event, contents) => {
    const pending = pendingNativeAccountsByHost.get(win.webContents.id) ?? []
    const target = pending.shift()
    if (pending.length === 0) pendingNativeAccountsByHost.delete(win.webContents.id)
    if (!target) {
      contents.close()
      console.error('[native-host] 已关闭缺少账号绑定的 webview')
      return
    }
    if (target.bridgeEnabled) {
      nativeControlHost.registerGuest(contents, target.accountId, win.webContents.id)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    // 开发模式自动开 DevTools：渲染进程的报错否则完全看不见
    win.webContents.openDevTools({ mode: 'right' })
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return

  // Electron 默认可能批准部分权限请求。guest 始终按不可信页面处理，M2
  // 默认拒绝相机/麦克风/定位/通知/剪贴板等权限；未来平台确有需要时，
  // 必须按 origin + 明确用户动作单独开口。
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  const blockUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (!nativeClientUrlAllowed(url)) event.preventDefault()
  }
  contents.on('will-navigate', blockUntrustedNavigation)
  // Electron 对服务端 30x 单独发 will-redirect，不会经过 will-navigate。两者必须
  // 使用同一白名单，否则 localhost 客户端可把 guest 重定向到任意远端页面。
  contents.on('will-redirect', blockUntrustedNavigation)
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
    } catch {
      // 非法 URL 直接拒绝，不把原始值写日志。
    }
    return { action: 'deny' }
  })
})

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
