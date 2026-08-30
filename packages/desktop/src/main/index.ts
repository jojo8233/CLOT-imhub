import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'

import { attachImHubWindowRuntime } from './imhub-window-runtime.js'

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
  attachImHubWindowRuntime(win, {
    nativeBridgePreload: join(import.meta.dirname, '../preload/native-bridge.mjs'),
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
