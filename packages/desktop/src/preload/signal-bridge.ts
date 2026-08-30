import { ipcRenderer } from 'electron'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeComposerCommand,
  type NativeCommandResultEvent,
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
} from '../signal-desktop-message.js'
import {
  readSignalDesktopComposerSnapshot,
  SignalDesktopComposerError,
  signalComposerSnapshotMatches,
  writeSignalDesktopDraft,
  type SignalDesktopComposerSnapshot,
  type SignalDesktopComposerWindowLike,
  type SignalDesktopReduxStoreLike,
} from '../signal-desktop-composer.js'
import {
  createIndexedDbSignalOutboxStorage,
  createSignalDesktopOutbox,
  type SignalOutboxEvent,
} from '../signal-desktop-outbox.js'

const COMMAND_CHANNEL = 'imhub:native-command'
const BOOTSTRAP_CHANNEL = 'imhub:signal-bridge-bootstrap'
const IDENTITY_INTERVAL_MS = 2_000
const IDENTITY_GRACE_MS = 15_000
const COMPOSER_WATCH_INTERVAL_MS = 250

interface SignalBridgeWindow extends SignalDesktopComposerWindowLike {
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
  let composerStore: SignalDesktopReduxStoreLike | null = null
  let unsubscribeComposer: (() => void) | null = null
  let currentComposer: SignalDesktopComposerSnapshot | null = null
  let contextRevision = 0
  let lastPlatformConversationId: string | null | undefined
  let lastDraft: string | undefined

  const accountIdentity = (): string => {
    const accountExternalId = lastIdentity ?? readSignalDesktopAci(signalWindow)
    if (!accountExternalId) throw new Error('Signal identity unavailable')
    if (lastIdentity !== accountExternalId) {
      lastIdentity = accountExternalId
      outbox.activate(accountExternalId, emit)
    }
    return accountExternalId
  }

  const enqueue = async (event: SignalOutboxEvent | null): Promise<boolean> => {
    if (!event) return false
    const queued = await outbox.enqueue(accountIdentity(), event)
    if (queued) console.info('[signal-bridge] inbound event persisted')
    return queued
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

  const emitComposerState = (
    snapshot: SignalDesktopComposerSnapshot,
    force: boolean,
  ): void => {
    if (!force && lastDraft === snapshot.draft) return
    lastDraft = snapshot.draft
    emit({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.state',
      contextRevision,
      platformConversationId: snapshot.context.platformConversationId,
      draft: snapshot.draft,
      // 本 checkpoint 只开放草稿读写；自动发送必须在稳定 attempt 幂等完成后单独启用。
      canSend: false,
    })
  }

  const refreshComposer = (force = false): SignalDesktopComposerSnapshot | null => {
    let snapshot: SignalDesktopComposerSnapshot | null
    try {
      snapshot = readSignalDesktopComposerSnapshot(signalWindow)
    } catch (error) {
      const composerError = error instanceof SignalDesktopComposerError ? error : null
      emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'bridge.error',
        code: composerError?.code ?? 'signal_composer_state_unavailable',
        message: composerError?.safeMessage ?? 'Signal 原生输入框状态暂时不可用',
      })
      currentComposer = null
      return null
    }

    const platformConversationId = snapshot?.context.platformConversationId ?? null
    const contextChanged = lastPlatformConversationId === undefined
      || platformConversationId !== lastPlatformConversationId
    if (contextChanged) {
      contextRevision += 1
      lastPlatformConversationId = platformConversationId
      lastDraft = undefined
    }
    currentComposer = snapshot
    if (contextChanged || force) {
      emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'context.changed',
        contextRevision,
        context: snapshot?.context ?? null,
      })
    }
    if (snapshot) emitComposerState(snapshot, contextChanged || force)
    return snapshot
  }

  const ensureComposerWatcher = (): boolean => {
    const store = signalWindow.reduxStore
    if (!store) return false
    if (composerStore === store && unsubscribeComposer) return true
    unsubscribeComposer?.()
    composerStore = store
    unsubscribeComposer = store.subscribe(() => { refreshComposer() })
    return true
  }

  const commandResult = (
    command: NativeComposerCommand,
    ok: boolean,
    value?: { draft?: string; code?: string; message?: string },
  ): NativeCommandResultEvent => ({
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'command.result',
    requestId: command.requestId,
    command: command.type,
    contextRevision: command.contextRevision,
    ok,
    ...(command.type === 'composer.send' ? { attemptId: command.attemptId } : {}),
    ...(value?.draft !== undefined ? { draft: value.draft } : {}),
    ...(!ok ? {
      error: {
        code: value?.code ?? 'signal_composer_command_failed',
        message: value?.message ?? 'Signal 原生输入框命令执行失败',
      },
    } : {}),
  })

  const handleComposerCommand = async (command: NativeComposerCommand): Promise<void> => {
    if (command.type === 'composer.send') {
      emit(commandResult(command, false, {
        code: 'signal_send_not_enabled',
        message: 'Signal 自动发送尚未启用，请在原生输入框中确认后手动发送',
      }))
      return
    }
    const snapshot = refreshComposer()
    if (command.contextRevision !== contextRevision
      || !signalComposerSnapshotMatches(snapshot, command.platformConversationId)) {
      emit(commandResult(command, false, {
        code: 'stale_signal_context',
        message: 'Signal 当前会话已经变化，请重新翻译',
      }))
      return
    }
    if (command.type === 'composer.get-draft') {
      emit(commandResult(command, true, { draft: snapshot.draft }))
      return
    }
    try {
      const updated = await writeSignalDesktopDraft(signalWindow, snapshot, command.text)
      currentComposer = updated
      emit(commandResult(command, true, { draft: updated.draft }))
      emitComposerState(updated, true)
      ipcRenderer.send(BOOTSTRAP_CHANNEL, 'composer-draft-written')
    } catch (error) {
      const composerError = error instanceof SignalDesktopComposerError ? error : null
      emit(commandResult(command, false, {
        code: composerError?.code ?? 'signal_draft_write_failed',
        message: composerError?.safeMessage ?? 'Signal 原生输入框未确认草稿写入，请重试',
      }))
    }
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
        const event = normalizeSignalDesktopReaction(
          targetMessage, reaction, reactorConversation, identity,
        )
        if (!event) return
        if (await enqueue(event)) {
          ipcRenderer.send(
            BOOTSTRAP_CHANNEL,
            event.emoji === null ? 'reaction-remove-persisted' : 'reaction-add-persisted',
          )
        }
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
      ensureComposerWatcher()
      refreshComposer(true)
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
    if (command.type === 'composer.set-draft'
      || command.type === 'composer.get-draft'
      || command.type === 'composer.send') {
      void handleComposerCommand(command)
    }
  })

  emit({ protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION, type: 'bridge.ready' })
  reportIdentity()
  setInterval(reportIdentity, IDENTITY_INTERVAL_MS)
  setInterval(() => {
    if (ensureComposerWatcher()) refreshComposer()
  }, COMPOSER_WATCH_INTERVAL_MS)
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
