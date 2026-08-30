import { ipcRenderer } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeGuestEvent,
  type NativeHostCommand,
  type NativeMessageUpsertEvent,
} from '@im-hub/shared'
import { NATIVE_GUEST_EVENT_CHANNEL } from '../native-control-ipc.js'
import {
  normalizeSignalDesktopInbound,
  readSignalDesktopAci,
  type SignalDesktopModelLike,
  type SignalDesktopWindowLike,
} from '../signal-desktop-message.js'

const COMMAND_CHANNEL = 'imhub:native-command'
const RETRY_INTERVAL_MS = 2_000
const IDENTITY_INTERVAL_MS = 2_000
const IDENTITY_GRACE_MS = 15_000
const MAX_PENDING_EVENTS = 1_000

interface SignalBridgeWindow extends SignalDesktopWindowLike {
  __imHubSignalBridge?: {
    onNewMessage(
      conversation: SignalDesktopModelLike,
      message: SignalDesktopModelLike,
      senderConversation: SignalDesktopModelLike | null,
    ): void
  }
}

function emit(event: NativeGuestEvent): void {
  ipcRenderer.send(NATIVE_GUEST_EVENT_CHANNEL, event)
}

/**
 * 运行在 Signal 自带 preload 的隔离世界中。Signal 不接触 accountId、用户 JWT 或
 * control grant；这些都由主进程按实际 WebContentsView 绑定和复核。
 */
export function installSignalPreloadBridge(signalWindow: SignalBridgeWindow): void {
  if (signalWindow.__imHubSignalBridge) return
  console.info('[signal-bridge] preload installed')
  const pending = new Map<string, NativeMessageUpsertEvent>()
  let isSending = false
  let lastErrorCode: string | null = null
  let lastIdentity: string | null = null

  const status = (): void => {
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'outbox.status',
      pendingCount: pending.size,
      deadLetterCount: 0,
      isSending,
      lastErrorCode,
    })
  }

  const sendPending = (): void => {
    if (pending.size === 0) return
    isSending = true
    for (const event of pending.values()) emit(event)
    isSending = false
    status()
  }

  const reportIdentity = (): boolean => {
    const normalized = readSignalDesktopAci(signalWindow)
    if (!normalized) return false
    const identityChanged = lastIdentity !== normalized
    lastIdentity = normalized
    if (identityChanged) console.info('[signal-bridge] identity ready')
    if (lastErrorCode === 'signal_identity_unavailable') lastErrorCode = null
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: normalized,
    })
    return true
  }

  signalWindow.__imHubSignalBridge = {
    onNewMessage(conversation, message, senderConversation): void {
      try {
        const event = normalizeSignalDesktopInbound(conversation, message, senderConversation)
        if (!event) return
        if (!pending.has(event.eventId) && pending.size >= MAX_PENDING_EVENTS) {
          lastErrorCode = 'signal_outbox_full'
          emit({
            protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
            type: 'bridge.error',
            code: lastErrorCode,
            message: 'Signal 入站桥接队列已满，已停止接收新的回传事件',
          })
          status()
          return
        }
        pending.set(event.eventId, event)
        console.info('[signal-bridge] inbound text queued')
        lastErrorCode = null
        emit(event)
        status()
      } catch {
        lastErrorCode = 'invalid_signal_inbound'
        emit({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'bridge.error',
          code: lastErrorCode,
          message: 'Signal 入站文字缺少稳定身份，已拒绝回传',
        })
        status()
      }
    },
  }

  ipcRenderer.on(COMMAND_CHANNEL, (_event, command: NativeHostCommand) => {
    if (command.type === 'bridge.request-state') {
      emit({ protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'bridge.ready' })
      lastIdentity = null
      reportIdentity()
      sendPending()
      return
    }
    if (command.type !== 'event.ack') return
    if (command.accepted || !command.retryable) pending.delete(command.eventId)
    if (!command.accepted && !command.retryable) lastErrorCode = 'signal_event_rejected'
    status()
  })

  emit({ protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'bridge.ready' })
  reportIdentity()
  status()
  setInterval(reportIdentity, IDENTITY_INTERVAL_MS)
  setInterval(sendPending, RETRY_INTERVAL_MS)
  setTimeout(() => {
    if (lastIdentity || reportIdentity()) return
    lastErrorCode = 'signal_identity_unavailable'
    console.error('[signal-bridge] identity unavailable after grace period')
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.error',
      code: lastErrorCode,
      message: 'Signal 登录身份在等待期内仍不可用；请确认已关联账号并重新打开测试包',
    })
    status()
  }, IDENTITY_GRACE_MS)
}
