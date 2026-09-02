import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeMessageUpsertEvent } from '@im-hub/shared'
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from '@im-hub/shared'
import {
  createSignalDesktopOutbox,
  type SignalDeadLetterRecord,
  type SignalOutboxRecord,
  type SignalOutboxStorage,
} from './signal-desktop-outbox.js'

const ACCOUNT_A = '11111111-2222-3333-aaaa-555555555555'

class MemorySignalOutboxStorage implements SignalOutboxStorage {
  private readonly pending = new Map<string, SignalOutboxRecord>()
  private readonly deadLetters = new Map<string, SignalDeadLetterRecord>()

  async getPending(storageKey: string): Promise<SignalOutboxRecord | undefined> {
    return clone(this.pending.get(storageKey))
  }

  async setPending(record: SignalOutboxRecord): Promise<void> {
    this.pending.set(record.storageKey, clone(record))
  }

  async deletePending(storageKey: string): Promise<void> {
    this.pending.delete(storageKey)
  }

  async listPending(accountExternalId: string): Promise<SignalOutboxRecord[]> {
    return [...this.pending.values()]
      .filter(record => record.accountExternalId === accountExternalId)
      .sort((first, second) => first.createdAt - second.createdAt)
      .map(record => clone(record))
  }

  async getDeadLetter(storageKey: string): Promise<SignalDeadLetterRecord | undefined> {
    return clone(this.deadLetters.get(storageKey))
  }

  async setDeadLetter(record: SignalDeadLetterRecord): Promise<void> {
    this.deadLetters.set(record.storageKey, clone(record))
  }

  async deleteDeadLetter(storageKey: string): Promise<void> {
    this.deadLetters.delete(storageKey)
  }

  async listDeadLetters(accountExternalId: string): Promise<SignalDeadLetterRecord[]> {
    return [...this.deadLetters.values()]
      .filter(record => record.accountExternalId === accountExternalId)
      .sort((first, second) => first.createdAt - second.createdAt)
      .map(record => clone(record))
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function inboundEvent(timestamp: number): NativeMessageUpsertEvent {
  const platformMessageId = `${ACCOUNT_A}:${timestamp}`
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId: `signal-inbound:${platformMessageId}`,
    message: {
      platformConversationId: `u:${ACCOUNT_A}`,
      platformMessageId,
      direction: 'in',
      senderExternalId: ACCOUNT_A,
      senderDisplayName: null,
      conversationDisplayName: null,
      body: 'test message',
      mediaRefs: [],
      replyToPlatformMessageId: null,
      sentAt: new Date(timestamp).toISOString(),
      editedAt: null,
      editVersion: null,
      raw: { source: 'signal-desktop' },
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSignalDesktopOutbox', () => {
  it('进程重建后从持久 pending 使用同一 eventId 重放并在 ACK 后删除', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))
    const storage = new MemorySignalOutboxStorage()
    const event = inboundEvent(1_700_000_000_000)
    const firstEmitted: string[] = []
    const first = createSignalDesktopOutbox(storage)
    first.activate(ACCOUNT_A, frame => {
      if (frame.type === 'message.upsert') firstEmitted.push(frame.eventId)
    })

    await expect(first.enqueue(ACCOUNT_A, event)).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(firstEmitted).toEqual([event.eventId])
    expect(await storage.listPending(ACCOUNT_A)).toHaveLength(1)
    first.deactivate()

    const replayed: string[] = []
    const restarted = createSignalDesktopOutbox(storage)
    restarted.activate(ACCOUNT_A, frame => {
      if (frame.type === 'message.upsert') replayed.push(frame.eventId)
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replayed).toEqual([event.eventId])

    await restarted.acknowledge(event.eventId, true, false)
    expect(await storage.listPending(ACCOUNT_A)).toEqual([])
    restarted.deactivate()
  })

  it('永久拒绝先进入 dead-letter，人工重试时先恢复 pending 再删除失败副本', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))
    const storage = new MemorySignalOutboxStorage()
    const event = inboundEvent(1_700_000_000_001)
    const outbox = createSignalDesktopOutbox(storage)
    outbox.activate(ACCOUNT_A, () => {})

    await outbox.enqueue(ACCOUNT_A, event)
    await vi.advanceTimersByTimeAsync(0)
    await outbox.acknowledge(event.eventId, false, false)
    expect(await storage.listPending(ACCOUNT_A)).toEqual([])
    expect(await storage.listDeadLetters(ACCOUNT_A)).toMatchObject([
      { event: { eventId: event.eventId }, errorCode: 'permanent_rejection' },
    ])

    await expect(outbox.retryDeadLetters()).resolves.toBe(1)
    expect(await storage.listPending(ACCOUNT_A)).toMatchObject([
      { event: { eventId: event.eventId }, attemptCount: 0, nextAttemptAt: 0 },
    ])
    expect(await storage.listDeadLetters(ACCOUNT_A)).toEqual([])
    outbox.deactivate()
  })

  it('相同账号和 eventId 重复入队只保留一份', async () => {
    vi.useFakeTimers()
    const storage = new MemorySignalOutboxStorage()
    const event = inboundEvent(1_700_000_000_002)
    const outbox = createSignalDesktopOutbox(storage)
    outbox.activate(ACCOUNT_A, () => {})

    await expect(outbox.enqueue(ACCOUNT_A, event)).resolves.toBe(true)
    await expect(outbox.enqueue(ACCOUNT_A, event)).resolves.toBe(false)
    expect(await storage.listPending(ACCOUNT_A)).toHaveLength(1)
    outbox.deactivate()
  })
})
