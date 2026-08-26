import { contextBridge, ipcRenderer } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'

const HOST_EVENT_CHANNEL = 'imhub:native-event'
const COMMAND_CHANNEL = 'imhub:native-command'
const MAX_EVENT_BYTES = 900_000

type CommandListener = (command: NativeHostCommand) => void

// 页面热更新或组件重挂时可能重复调用 onCommand。ipcRenderer 只注册一个底层
// listener，页面侧后注册者替换旧者，避免一次 composer.send 被多个 handler 执行。
let commandListener: CommandListener | null = null
ipcRenderer.on(COMMAND_CHANNEL, (_event, command: NativeHostCommand) => {
  commandListener?.(command)
})

/**
 * 运行在平台 webview 的隔离 preload 中。
 *
 * 这份 typed bridge 只能发送声明过的事件、接收声明过的命令；它不暴露外壳的
 * window.imHub、JWT、ipcRenderer 或 Node.js。Telegram 页面仍有 M3 待移除的
 * window.__IM_HUB__ 历史 JWT 通道，因此页面整体始终按不可信内容处理，外壳也会
 * 对所有入站值做运行时校验。
 */
contextBridge.exposeInMainWorld('imHubNativeBridge', {
  protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
  emit(event: NativeGuestEvent): void {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
      if (bytes > MAX_EVENT_BYTES) throw new Error('frame too large')
    } catch {
      ipcRenderer.sendToHost(HOST_EVENT_CHANNEL, {
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'bridge.error',
        code: 'invalid_event_frame',
        message: '原生客户端产生了过大或无法序列化的桥接事件',
      } satisfies NativeGuestEvent)
      return
    }
    ipcRenderer.sendToHost(HOST_EVENT_CHANNEL, event)
  },
  onCommand(listener: CommandListener): void {
    commandListener = listener
  },
})
