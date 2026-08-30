import { ipcRenderer } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'
import { NATIVE_GUEST_EVENT_CHANNEL } from '../native-control-ipc.js'
import {
  normalizeSignalDesktopInbound,
  readSignalDesktopAci,
  type SignalDesktopModelLike,
  type SignalDesktopWindowLike,
} from '../signal-desktop-message.js'
import {
  createIndexedDbSignalOutboxStorage,
  createSignalDesktopOutbox,
} from '../signal-desktop-outbox.js'

const COMMAND_CHANNEL = 'imhub:native-command'
const IDENTITY_INTERVAL_MS = 2_000
const IDENTITY_GRACE_MS = 15_000

interface SignalBridgeWindow extends SignalDesktopWindowLike {
  __imHubSignalBridge?: {
    onNewMessage(
      conversation: SignalDesktopModelLike,
      message: SignalDesktopModelLike,
      senderConversation: SignalDesktopModelLike | null,
    ): Promise<void>
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
  const outbox = createSignalDesktopOutbox(
    createIndexedDbSignalOutboxStorage(globalThis.indexedDB),
  )
  let lastIdentity: string | null = null

  const reportIdentity = (): boolean => {
    const normalized = readSignalDesktopAci(signalWindow)
    if (!normalized) return false
    const identityChanged = lastIdentity !== normalized
    lastIdentity = normalized
    if (identityChanged) {
      console.info('[signal-bridge] identity ready')
      outbox.activate(normalized, emit)
    }
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'account.identity',
      platformAccountExternalId: normalized,
    })
    return true
  }

  signalWindow.__imHubSignalBridge = {
    async onNewMessage(conversation, message, senderConversation): Promise<void> {
      try {
        const event = normalizeSignalDesktopInbound(conversation, message, senderConversation)
        if (!event) return
        const accountExternalId = lastIdentity ?? readSignalDesktopAci(signalWindow)
        if (!accountExternalId) throw new Error('Signal identity unavailable')
        if (lastIdentity !== accountExternalId) {
          lastIdentity = accountExternalId
          outbox.activate(accountExternalId, emit)
        }
        const queued = await outbox.enqueue(accountExternalId, event)
        if (queued) console.info('[signal-bridge] inbound text persisted')
      } catch {
        emit({
          protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
          type: 'bridge.error',
          code: 'invalid_signal_inbound',
          message: 'Signal 入站文字缺少稳定身份，已拒绝回传',
        })
      }
    },
  }

  ipcRenderer.on(COMMAND_CHANNEL, (_event, command: NativeHostCommand) => {
    if (command.type === 'bridge.request-state') {
      emit({ protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'bridge.ready' })
      lastIdentity = null
      reportIdentity()
      outbox.replay()
      return
    }
    if (command.type === 'event.ack') {
      void outbox.acknowledge(command.eventId, command.accepted, command.retryable)
      return
    }
    if (command.type === 'outbox.retry-dead-letters') {
      void outbox.retryDeadLetters()
      return
    }
    if (command.type === 'outbox.discard-dead-letters') void outbox.discardDeadLetters()
  })

  emit({ protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'bridge.ready' })
  reportIdentity()
  setInterval(reportIdentity, IDENTITY_INTERVAL_MS)
  setTimeout(() => {
    if (lastIdentity || reportIdentity()) return
    console.error('[signal-bridge] identity unavailable after grace period')
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.error',
      code: 'signal_identity_unavailable',
      message: 'Signal 登录身份在等待期内仍不可用；请确认已关联账号并重新打开测试包',
    })
  }, IDENTITY_GRACE_MS)
}
