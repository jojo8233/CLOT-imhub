import { contextBridge } from 'electron'

/** P0 的渲染进程直接跟服务端 HTTP/WS 通信，preload 只暴露最小信息。 */
contextBridge.exposeInMainWorld('imHub', {
  platform: process.platform,
  serverUrl: process.env.IM_HUB_SERVER_URL ?? 'http://localhost:4000',
})
