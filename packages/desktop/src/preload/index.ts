import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contextBridge, ipcRenderer } from 'electron'

interface SessionPayload {
  token: string
  user: { id: string; role: string; displayName: string }
}

/**
 * P0 的渲染进程直接跟服务端 HTTP/WS 通信，preload 只暴露最小信息。
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
})
