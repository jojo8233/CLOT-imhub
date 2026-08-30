import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'
import { NATIVE_GUEST_EVENT_CHANNEL } from '../native-control-ipc.js'

const electron = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, command: NativeHostCommand) => void>(),
  send: vi.fn(),
}))

const outbox = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  activate: vi.fn(),
  discardDeadLetters: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(true),
  replay: vi.fn(),
  retryDeadLetters: vi.fn(),
}))

const sendLedger = vi.hoisted(() => ({
  acknowledge: vi.fn().mockResolvedValue(undefined),
  activate: vi.fn(),
  onOutgoingMessagePersisted: vi.fn().mockResolvedValue(undefined),
  onOutgoingMessagePrepared: vi.fn().mockResolvedValue(undefined),
  recover: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue('signal-final-message'),
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, command: NativeHostCommand) => void) => {
      electron.listeners.set(channel, listener)
    },
    send: electron.send,
  },
}))

vi.mock('../signal-desktop-outbox.js', () => ({
  createIndexedDbSignalOutboxStorage: vi.fn(() => ({})),
  createSignalDesktopOutbox: vi.fn(() => outbox),
}))

vi.mock('../signal-desktop-send.js', () => ({
  createIndexedDbSignalSendAttemptStorage: vi.fn(() => ({})),
  createSignalDesktopSendLedger: vi.fn(() => sendLedger),
  SignalDesktopSendError: class extends Error {},
}))

import { installSignalPreloadBridge } from './signal-bridge.js'

function events(): NativeGuestEvent[] {
  return electron.send.mock.calls
    .filter(([channel]) => channel === NATIVE_GUEST_EVENT_CHANNEL)
    .map(([, event]) => event as NativeGuestEvent)
}

function command(command: NativeHostCommand): void {
  const listener = electron.listeners.get('imhub:native-command')
  if (!listener) throw new Error('expected command listener')
  listener({}, command)
}

function signalWindow() {
  const attributes: Record<string, unknown> = {
    serviceId: '99999999-2222-3333-aaaa-555555555555',
    draft: '',
  }
  const conversation = {
    attributes,
    get: (key: string) => attributes[key],
    getAci: () => attributes.serviceId,
    getTitle: () => 'Alice',
  }
  const state = {
    nav: { selectedLocation: { tab: 'Chats', details: { conversationId: 'local-conversation-id' } } },
    composer: {
      conversations: {
        'local-conversation-id': { sendCounter: 2, attachments: [], isViewOnce: false },
      },
    },
  }
  const storeListeners = new Set<() => void>()
  let visibleDraft = ''
  const setVisibleDraft = vi.fn((text: string) => {
    visibleDraft = text
    attributes.draft = text
    for (const listener of storeListeners) listener()
    return true
  })
  return {
    value: {
      ConversationController: {
        get: (id: string) => id === 'local-conversation-id' ? conversation : undefined,
        getOurConversationOrThrow: () => ({
          getAci: () => '11111111-2222-3333-aaaa-555555555555',
        }),
      },
      reduxStore: {
        getState: () => state,
        subscribe: (listener: () => void) => {
          storeListeners.add(listener)
          return () => { storeListeners.delete(listener) }
        },
      },
      reduxActions: {
        composer: {
          setComposerFocus: vi.fn(),
        },
      },
      __imHubSignalComposerEditor: {
        conversationId: 'local-conversation-id',
        readDraft: () => visibleDraft,
        setDraft: setVisibleDraft,
        submit: vi.fn(() => true),
      },
    },
    attributes,
    setVisibleDraft,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  electron.listeners.clear()
  electron.send.mockClear()
  for (const value of Object.values(outbox)) value.mockClear()
  for (const value of Object.values(sendLedger)) value.mockClear()
  sendLedger.recover.mockResolvedValue(undefined)
  sendLedger.send.mockResolvedValue('signal-final-message')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Signal preload composer bridge', () => {
  it('重放规范当前会话与纯文字 composer 状态', async () => {
    const current = signalWindow()
    installSignalPreloadBridge(current.value)
    await vi.advanceTimersByTimeAsync(250)

    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'context.changed',
        contextRevision: 1,
        context: {
          platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
          contactExternalId: '99999999-2222-3333-aaaa-555555555555',
          contactDisplayName: 'Alice',
        },
      }),
      expect.objectContaining({
        type: 'composer.state',
        contextRevision: 1,
        platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
        draft: '',
        canSend: false,
      }),
    ]))
    expect(JSON.stringify(events())).not.toContain('local-conversation-id')
  })

  it('草稿命令写入 Signal action，发送命令等待账本确认最终消息 ID', async () => {
    const current = signalWindow()
    installSignalPreloadBridge(current.value)
    await vi.advanceTimersByTimeAsync(250)
    electron.send.mockClear()

    command({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.set-draft',
      requestId: 'set-1',
      contextRevision: 1,
      platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
      text: 'translated text',
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(current.setVisibleDraft).toHaveBeenCalledWith('translated text')
    expect(current.attributes.draft).toBe('translated text')
    expect(electron.send).toHaveBeenCalledWith(
      'imhub:signal-bridge-bootstrap',
      'composer-draft-written',
    )
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.result', requestId: 'set-1', command: 'composer.set-draft', ok: true,
      }),
      expect.objectContaining({
        type: 'composer.state', draft: 'translated text', canSend: true,
      }),
    ]))

    command({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.send',
      requestId: 'send-1',
      contextRevision: 1,
      platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
      attemptId: 'attempt-1',
      attemptContextRevision: 1,
      draftFingerprint: 'a'.repeat(64),
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(sendLedger.send).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1', draftFingerprint: 'a'.repeat(64) }),
      expect.objectContaining({ draft: 'translated text' }),
    )
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.result',
        requestId: 'send-1',
        command: 'composer.send',
        attemptId: 'attempt-1',
        ok: true,
        platformMessageId: 'signal-final-message',
      }),
    ]))

    command({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.ack-send',
      attemptId: 'attempt-1',
      platformMessageId: 'signal-final-message',
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(sendLedger.acknowledge).toHaveBeenCalledWith(
      'attempt-1',
      'signal-final-message',
    )
  })

  it('旧 revision 的草稿命令不会跨会话写入', async () => {
    const current = signalWindow()
    installSignalPreloadBridge(current.value)
    await vi.advanceTimersByTimeAsync(250)
    electron.send.mockClear()

    command({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.set-draft',
      requestId: 'stale-1',
      contextRevision: 0,
      platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
      text: 'must not write',
    })
    expect(current.setVisibleDraft).not.toHaveBeenCalled()
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.result', requestId: 'stale-1', ok: false,
        error: expect.objectContaining({ code: 'stale_signal_context' }),
      }),
    ]))
  })
})
