import { ipcRenderer } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'
import { NATIVE_GUEST_EVENT_CHANNEL } from '../native-control-ipc.js'
import {
  normalizeSignalDesktopDelete,
  normalizeSignalDesktopEdit,
  normalizeSignalDesktopInbound,
  normalizeSignalDesktopReaction,
  readSignalDesktopAci,
  SignalDesktopInboundError,
  type SignalDesktopModelLike,
  type SignalDesktopWindowLike,
} from '../signal-desktop-message.js'
import {
  createIndexedDbSignalOutboxStorage,
  createSignalDesktopOutbox,
  type SignalOutboxEvent,
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
    onMessageEdited(
      conversation: SignalDesktopModelLike,
      message: SignalDesktopModelLike,
      senderConversation: SignalDesktopModelLike | null,
    ): Promise<void>
    onMessageDeleted(message: SignalDesktopModelLike, deleteDetails: unknown): Promise<void>
    onReaction(
      targetMessage: SignalDesktopModelLike,
      reaction: unknown,
      reactorConversation: SignalDesktopModelLike | null,
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

  const accountIdentity = (): string => {
    const accountExternalId = lastIdentity ?? readSignalDesktopAci(signalWindow)
    if (!accountExternalId) throw new Error('Signal identity unavailable')
    if (lastIdentity !== accountExternalId) {
      lastIdentity = accountExternalId
      outbox.activate(accountExternalId, emit)
    }
    return accountExternalId
  }

  const enqueue = async (event: SignalOutboxEvent | null): Promise<void> => {
    if (!event) return
    const queued = await outbox.enqueue(accountIdentity(), event)
    if (queued) console.info('[signal-bridge] inbound event persisted')
  }

  const reportInboundError = (error: unknown): void => {
    const inboundError = error instanceof SignalDesktopInboundError ? error : null
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'bridge.error',
      code: inboundError?.code ?? 'invalid_signal_inbound',
      message: inboundError?.safeMessage ?? 'Signal 入站事件无法安全归一化，已拒绝回传',
    })
  }

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
        await enqueue(normalizeSignalDesktopInbound(conversation, message, senderConversation))
      } catch (error) {
        reportInboundError(error)
      }
    },
    async onMessageEdited(conversation, message, senderConversation): Promise<void> {
      try {
        await enqueue(normalizeSignalDesktopEdit(conversation, message, senderConversation))
      } catch (error) {
        reportInboundError(error)
      }
    },
    async onMessageDeleted(message, deleteDetails): Promise<void> {
      try {
        await enqueue(normalizeSignalDesktopDelete(message, deleteDetails))
      } catch (error) {
        reportInboundError(error)
      }
    },
    async onReaction(targetMessage, reaction, reactorConversation): Promise<void> {
      try {
        const identity = accountIdentity()
        await enqueue(normalizeSignalDesktopReaction(
          targetMessage, reaction, reactorConversation, identity,
        ))
      } catch (error) {
        reportInboundError(error)
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
