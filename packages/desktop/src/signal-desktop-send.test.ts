import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  type NativeSendCommand,
} from '@im-hub/shared'
import { nativeDraftFingerprint } from './native-draft-fingerprint.js'
import { readSignalDesktopComposerSnapshot } from './signal-desktop-composer.js'
import {
  createSignalDesktopSendLedger,
  SignalDesktopSendError,
  type SignalDesktopSendWindowLike,
  type SignalOutgoingMessageLike,
  type SignalSendAttemptRecord,
  type SignalSendAttemptStorage,
} from './signal-desktop-send.js'

const ACCOUNT = '11111111-2222-3333-aaaa-555555555555'
const PEER = '99999999-2222-3333-aaaa-555555555555'
const PLATFORM_CONVERSATION = `u:${PEER}`
const LOCAL_CONVERSATION = 'local-conversation'

class MemorySendAttemptStorage implements SignalSendAttemptStorage {
  private readonly records = new Map<string, SignalSendAttemptRecord>()

  async getAttempt(storageKey: string): Promise<SignalSendAttemptRecord | undefined> {
    return clone(this.records.get(storageKey))
  }

  async setAttempt(record: SignalSendAttemptRecord): Promise<void> {
    this.records.set(record.storageKey, clone(record))
  }

  async deleteAttempt(storageKey: string): Promise<void> {
    this.records.delete(storageKey)
  }

  async listAttempts(accountExternalId: string): Promise<SignalSendAttemptRecord[]> {
    return [...this.records.values()]
      .filter(record => record.accountExternalId === accountExternalId)
      .sort((first, second) => first.createdAt - second.createdAt)
      .map(record => clone(record))
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function createWindow(body: string): {
  signalWindow: SignalDesktopSendWindowLike
  attributes: Record<string, unknown>
  setVisibleDraft(value: string): void
} {
  const attributes: Record<string, unknown> = {
    serviceId: PEER,
    draft: body,
    draftAttachments: [],
  }
  let visibleDraft = body
  const conversation = {
    attributes,
    get: (key: string) => attributes[key],
    getAci: () => PEER,
    getTitle: () => 'Alice',
  }
  const state = {
    nav: {
      selectedLocation: {
        tab: 'Chats',
        details: { conversationId: LOCAL_CONVERSATION },
      },
    },
    composer: {
      conversations: {
        [LOCAL_CONVERSATION]: {
          sendCounter: 1,
          attachments: [],
          isViewOnce: false,
        },
      },
    },
  }
  const signalWindow: SignalDesktopSendWindowLike = {
    ConversationController: {
      get: id => id === LOCAL_CONVERSATION ? conversation : undefined,
    },
    reduxStore: {
      getState: () => state,
      subscribe: () => () => {},
    },
    __imHubSignalComposerEditor: {
      conversationId: LOCAL_CONVERSATION,
      readDraft: () => visibleDraft,
      setDraft: () => false,
      submit: () => false,
    },
  }
  return {
    signalWindow,
    attributes,
    setVisibleDraft(value) {
      visibleDraft = value
      attributes.draft = value
    },
  }
}

function snapshot(signalWindow: SignalDesktopSendWindowLike) {
  const result = readSignalDesktopComposerSnapshot(signalWindow)
  if (!result) throw new Error('expected Signal composer snapshot')
  return result
}

async function command(body: string, attemptId = 'attempt-1'): Promise<NativeSendCommand> {
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'composer.send',
    requestId: `request-${attemptId}`,
    contextRevision: 7,
    platformConversationId: PLATFORM_CONVERSATION,
    attemptId,
    attemptContextRevision: 7,
    draftFingerprint: await nativeDraftFingerprint(body),
  }
}

function outgoing(body: string, submittedAt: number, id = 'local-message'): SignalOutgoingMessageLike {
  const attributes = {
    id,
    type: 'outgoing',
    conversationId: LOCAL_CONVERSATION,
    sent_at: submittedAt,
    body,
  }
  return {
    id,
    attributes,
    get: key => attributes[key as keyof typeof attributes],
  }
}

describe('Signal Desktop send attempt ledger', () => {
  it('只在 Signal 消息与发送 job 持久化后返回最终规范消息 ID', async () => {
    const storage = new MemorySendAttemptStorage()
    const current = createWindow('translated text')
    const ledger = createSignalDesktopSendLedger(storage, current.signalWindow)
    ledger.activate(ACCOUNT)
    const prepared: string[] = []
    current.signalWindow.__imHubSignalComposerEditor!.submit = async submittedAt => {
      const message = outgoing('translated text', submittedAt)
      await ledger.onOutgoingMessagePrepared(message)
      prepared.push('prepared')
      await ledger.onOutgoingMessagePersisted(message)
      prepared.push('persisted')
      return true
    }

    const platformMessageId = await ledger.send(
      await command('translated text'),
      snapshot(current.signalWindow),
    )

    expect(prepared).toEqual(['prepared', 'persisted'])
    expect(platformMessageId).toMatch(new RegExp(`^${ACCOUNT}:\\d+$`))
    expect(await storage.listAttempts(ACCOUNT)).toMatchObject([
      {
        attemptId: 'attempt-1',
        draftFingerprint: await nativeDraftFingerprint('translated text'),
        localMessageId: 'local-message',
        platformMessageId,
      },
    ])
    expect(JSON.stringify(await storage.listAttempts(ACCOUNT))).not.toContain('translated text')
  })

  it('双击的同一 attempt 只调用一次 CompositionInput.submit', async () => {
    const storage = new MemorySendAttemptStorage()
    const current = createWindow('double click')
    const ledger = createSignalDesktopSendLedger(storage, current.signalWindow)
    ledger.activate(ACCOUNT)
    const submit = vi.fn(async (submittedAt: number) => {
      const message = outgoing('double click', submittedAt)
      await ledger.onOutgoingMessagePrepared(message)
      await ledger.onOutgoingMessagePersisted(message)
      return true
    })
    current.signalWindow.__imHubSignalComposerEditor!.submit = submit
    const sendCommand = await command('double click')

    const [first, second] = await Promise.all([
      ledger.send(sendCommand, snapshot(current.signalWindow)),
      ledger.send({ ...sendCommand, requestId: 'request-second-click' }, snapshot(current.signalWindow)),
    ])

    expect(first).toBe(second)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('命令排队期间切会话或用户改稿都不会提交旧 attempt', async () => {
    const storage = new MemorySendAttemptStorage()
    const current = createWindow('before edit')
    const ledger = createSignalDesktopSendLedger(storage, current.signalWindow)
    ledger.activate(ACCOUNT)
    const submit = vi.fn(() => true)
    current.signalWindow.__imHubSignalComposerEditor!.submit = submit
    const before = snapshot(current.signalWindow)
    const sendCommand = await command('before edit')
    current.setVisibleDraft('after edit')

    await expect(ledger.send(sendCommand, before)).rejects.toEqual(
      expect.objectContaining<Partial<SignalDesktopSendError>>({
        code: 'signal_send_draft_changed',
      }),
    )
    expect(submit).not.toHaveBeenCalled()

    await expect(ledger.send(
      { ...sendCommand, attemptId: 'attempt-stale', platformConversationId: `u:${ACCOUNT}` },
      before,
    )).rejects.toEqual(expect.objectContaining<Partial<SignalDesktopSendError>>({
      code: 'signal_send_attempt_mismatch',
    }))
    expect(submit).not.toHaveBeenCalled()

    await expect(ledger.send(
      {
        ...sendCommand,
        requestId: 'request-new-revision',
        attemptId: 'attempt-new-revision',
        contextRevision: 8,
        attemptContextRevision: 8,
      },
      before,
    )).rejects.toEqual(expect.objectContaining<Partial<SignalDesktopSendError>>({
      code: 'signal_send_attempt_conflict',
    }))
  })

  it('结果事件丢失并重建进程后按同一 attempt 返回已确认消息，不二次 submit', async () => {
    const storage = new MemorySendAttemptStorage()
    const firstWindow = createWindow('restart recovery')
    const firstLedger = createSignalDesktopSendLedger(storage, firstWindow.signalWindow)
    firstLedger.activate(ACCOUNT)
    firstWindow.signalWindow.__imHubSignalComposerEditor!.submit = async submittedAt => {
      const message = outgoing('restart recovery', submittedAt)
      await firstLedger.onOutgoingMessagePrepared(message)
      await firstLedger.onOutgoingMessagePersisted(message)
      return true
    }
    const sendCommand = await command('restart recovery')
    const confirmed = await firstLedger.send(sendCommand, snapshot(firstWindow.signalWindow))

    const restartedWindow = createWindow('')
    const restartedSubmit = vi.fn(() => true)
    restartedWindow.signalWindow.__imHubSignalComposerEditor!.submit = restartedSubmit
    const restarted = createSignalDesktopSendLedger(storage, restartedWindow.signalWindow)
    restarted.activate(ACCOUNT)

    await expect(restarted.recover(PLATFORM_CONVERSATION)).resolves.toMatchObject({
      attemptId: sendCommand.attemptId,
      platformMessageId: confirmed,
    })
    await expect(restarted.send(
      { ...sendCommand, requestId: 'request-after-restart', contextRevision: 1 },
      snapshot(restartedWindow.signalWindow),
    ))
      .resolves.toBe(confirmed)
    expect(restartedSubmit).not.toHaveBeenCalled()

    await expect(restarted.send(
      {
        ...sendCommand,
        requestId: 'request-wrong-attempt-revision',
        contextRevision: 1,
        attemptContextRevision: 1,
      },
      snapshot(restartedWindow.signalWindow),
    )).rejects.toEqual(expect.objectContaining<Partial<SignalDesktopSendError>>({
      code: 'signal_send_attempt_mismatch',
    }))
  })

  it('进程在 Signal 持久化后、回调结果前退出时按本地消息 id 恢复最终结果', async () => {
    const storage = new MemorySendAttemptStorage()
    const firstWindow = createWindow('persisted before crash')
    const firstLedger = createSignalDesktopSendLedger(storage, firstWindow.signalWindow)
    firstLedger.activate(ACCOUNT)
    let persistedMessage: SignalOutgoingMessageLike | null = null
    firstWindow.signalWindow.__imHubSignalComposerEditor!.submit = async submittedAt => {
      persistedMessage = outgoing('persisted before crash', submittedAt)
      await firstLedger.onOutgoingMessagePrepared(persistedMessage)
      // 模拟 Signal 数据库已提交，但 preload 尚未来得及执行 persisted hook 就退出。
      return true
    }
    void firstLedger.send(
      await command('persisted before crash'),
      snapshot(firstWindow.signalWindow),
    )
    await vi.waitFor(() => {
      expect(persistedMessage).not.toBeNull()
    })

    const restartedWindow = createWindow('')
    restartedWindow.signalWindow.__imHubSignalResolveOutgoingMessage = async () => persistedMessage
    const restarted = createSignalDesktopSendLedger(storage, restartedWindow.signalWindow)
    restarted.activate(ACCOUNT)

    await expect(restarted.recover(PLATFORM_CONVERSATION)).resolves.toMatchObject({
      attemptId: 'attempt-1',
      platformMessageId: expect.stringMatching(new RegExp(`^${ACCOUNT}:\\d+$`)),
    })
  })

  it('只有最终消息 ID 完全匹配的 ACK 才清理 attempt', async () => {
    const storage = new MemorySendAttemptStorage()
    const current = createWindow('ack result')
    const ledger = createSignalDesktopSendLedger(storage, current.signalWindow)
    ledger.activate(ACCOUNT)
    current.signalWindow.__imHubSignalComposerEditor!.submit = async submittedAt => {
      const message = outgoing('ack result', submittedAt)
      await ledger.onOutgoingMessagePrepared(message)
      await ledger.onOutgoingMessagePersisted(message)
      return true
    }
    const result = await ledger.send(await command('ack result'), snapshot(current.signalWindow))

    await expect(ledger.acknowledge('attempt-1', 'wrong-result')).rejects.toEqual(
      expect.objectContaining<Partial<SignalDesktopSendError>>({
        code: 'signal_send_attempt_mismatch',
      }),
    )
    expect(await storage.listAttempts(ACCOUNT)).toHaveLength(1)

    await ledger.acknowledge('attempt-1', result)
    expect(await storage.listAttempts(ACCOUNT)).toEqual([])
  })
})
