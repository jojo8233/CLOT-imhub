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
    composer: { conversations: { 'local-conversation-id': { sendCounter: 2 } } },
  }
  const storeListeners = new Set<() => void>()
  const onEditorStateChange = vi.fn((input: { messageText: string }) => {
    attributes.draft = input.messageText
    for (const listener of storeListeners) listener()
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
          onEditorStateChange,
        },
      },
    },
    attributes,
    onEditorStateChange,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  electron.listeners.clear()
  electron.send.mockClear()
  for (const value of Object.values(outbox)) value.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Signal preload composer bridge', () => {
  it('重放规范当前会话与不可自动发送的 composer 状态', async () => {
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

  it('草稿命令写入 Signal action，自动发送命令明确拒绝', async () => {
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
    expect(current.onEditorStateChange).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'local-conversation-id',
      messageText: 'translated text',
      sendCounter: 2,
    }))
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
        type: 'composer.state', draft: 'translated text', canSend: false,
      }),
    ]))

    command({
      protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
      type: 'composer.send',
      requestId: 'send-1',
      contextRevision: 1,
      platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
      attemptId: 'attempt-1',
    })
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.result',
        requestId: 'send-1',
        command: 'composer.send',
        attemptId: 'attempt-1',
        ok: false,
        error: expect.objectContaining({ code: 'signal_send_not_enabled' }),
      }),
    ]))
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
    expect(current.onEditorStateChange).not.toHaveBeenCalled()
    expect(events()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'command.result', requestId: 'stale-1', ok: false,
        error: expect.objectContaining({ code: 'stale_signal_context' }),
      }),
    ]))
  })
})
