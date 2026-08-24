import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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
