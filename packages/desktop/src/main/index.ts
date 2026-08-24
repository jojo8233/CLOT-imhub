import { join } from 'node:path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { BrowserWindow, app, ipcMain, safeStorage } from 'electron'

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
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    // 开发模式自动开 DevTools：渲染进程的报错否则完全看不见
    win.webContents.openDevTools({ mode: 'right' })
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
