import type {
  NativeMessageDeletedEvent,
  NativeMessageIdRemappedEvent,
  NativeMessageUpsertEvent,
  NativeOutboxStatusEvent,
} from '@im-hub/shared'
import { NATIVE_BRIDGE_PROTOCOL_VERSION } from '@im-hub/shared'

export type SignalOutboxEvent =
  | NativeMessageUpsertEvent
  | NativeMessageDeletedEvent
  | NativeMessageIdRemappedEvent

export interface SignalOutboxRecord {
  storageKey: string
  accountExternalId: string
  event: SignalOutboxEvent
  createdAt: number
  attemptCount: number
  nextAttemptAt: number
}

export interface SignalDeadLetterRecord extends SignalOutboxRecord {
  failedAt: number
  errorCode: string
}

export interface SignalOutboxStorage {
  getPending(storageKey: string): Promise<SignalOutboxRecord | undefined>
  setPending(record: SignalOutboxRecord): Promise<void>
  deletePending(storageKey: string): Promise<void>
  listPending(accountExternalId: string): Promise<SignalOutboxRecord[]>
  getDeadLetter(storageKey: string): Promise<SignalDeadLetterRecord | undefined>
  setDeadLetter(record: SignalDeadLetterRecord): Promise<void>
  deleteDeadLetter(storageKey: string): Promise<void>
  listDeadLetters(accountExternalId: string): Promise<SignalDeadLetterRecord[]>
}

export interface SignalDesktopOutbox {
  activate(accountExternalId: string, emit: (event: SignalOutboxEvent | NativeOutboxStatusEvent) => void): void
  deactivate(): void
  replay(): void
  enqueue(accountExternalId: string, event: SignalOutboxEvent): Promise<boolean>
  acknowledge(eventId: string, accepted: boolean, retryable: boolean): Promise<void>
  retryDeadLetters(): Promise<number>
  discardDeadLetters(): Promise<number>
}

const DATABASE_NAME = 'imhub-signal-outbox'
const DATABASE_VERSION = 1
const PENDING_STORE = 'pending-events'
const DEAD_LETTER_STORE = 'dead-letter-events'
const MAX_PENDING_EVENTS = 1_000
const MAX_DEAD_LETTER_EVENTS = 1_000
const ACK_TIMEOUT_MS = 10_000
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 60_000
const SEND_INTERVAL_MS = 100

/**
 * Signal 自己先持久化消息，再调用 bridge。这里把尚未获 ACK 的标准事件写入独立
 * IndexedDB；进程退出后重新创建 bridge 时仍按原 eventId 重放。
 */
export function createSignalDesktopOutbox(storage: SignalOutboxStorage): SignalDesktopOutbox {
  let activeAccountExternalId: string | undefined
  let emitOutboxEvent: ((event: SignalOutboxEvent | NativeOutboxStatusEvent) => void) | undefined
  let activeEventId: string | undefined
  let pumpTimer: ReturnType<typeof setTimeout> | undefined
  let ackTimer: ReturnType<typeof setTimeout> | undefined
  let isPumping = false
  let requestedPumpDelay: number | undefined
  let lastErrorCode: string | undefined
  let storageQueue = Promise.resolve<unknown>(undefined)

  function activate(
    accountExternalId: string,
    emit: (event: SignalOutboxEvent | NativeOutboxStatusEvent) => void,
  ): void {
    if (activeAccountExternalId !== accountExternalId) {
      resetDeliveryState()
      lastErrorCode = undefined
    }
    activeAccountExternalId = accountExternalId
    emitOutboxEvent = emit
    void reportStatus()
    schedulePump(0)
  }

  function deactivate(): void {
    activeAccountExternalId = undefined
    emitOutboxEvent = undefined
    lastErrorCode = undefined
    resetDeliveryState()
  }

  function replay(): void {
    void reportStatus()
    schedulePump(0)
  }

  async function enqueue(accountExternalId: string, event: SignalOutboxEvent): Promise<boolean> {
    try {
      const stored = await queueStorageOperation(async () => {
        const storageKey = buildStorageKey(accountExternalId, event.eventId)
        if (await storage.getPending(storageKey) || await storage.getDeadLetter(storageKey)) return false

        const pending = await storage.listPending(accountExternalId)
        const lastCreatedAt = pending.at(-1)?.createdAt ?? 0
        const record: SignalOutboxRecord = {
          storageKey,
          accountExternalId,
          event,
          createdAt: Math.max(Date.now(), lastCreatedAt + 1),
          attemptCount: 0,
          nextAttemptAt: 0,
        }
        if (pending.length >= MAX_PENDING_EVENTS) {
          const deadLetterStored = await storeDeadLetter(record, 'outbox_capacity')
          lastErrorCode = deadLetterStored ? 'outbox_capacity' : 'dead_letter_capacity'
          return false
        }
        await storage.setPending(record)
        lastErrorCode = undefined
        return true
      })
      void reportStatus()
      schedulePump(0)
      return stored
    } catch {
      lastErrorCode = 'outbox_storage_failed'
      void reportStatus()
      return false
    }
  }

  async function acknowledge(eventId: string, accepted: boolean, retryable: boolean): Promise<void> {
    const accountExternalId = activeAccountExternalId
    if (!accountExternalId) return
    const storageKey = buildStorageKey(accountExternalId, eventId)

    try {
      await queueStorageOperation(async () => {
        const record = await storage.getPending(storageKey)
        if (!record) return
        if (accepted) {
          await storage.deletePending(storageKey)
          lastErrorCode = undefined
          return
        }
        if (retryable) {
          record.nextAttemptAt = Date.now() + calculateRetryDelay(record.attemptCount)
          await storage.setPending(record)
          lastErrorCode = 'retryable_rejection'
          return
        }
        const deadLetterStored = await storeDeadLetter(record, 'permanent_rejection')
        if (deadLetterStored) {
          await storage.deletePending(storageKey)
          lastErrorCode = 'permanent_rejection'
          return
        }
        // dead-letter 满时保留 pending 证据，等待明确的运维处理。
        record.nextAttemptAt = Date.now() + RETRY_MAX_DELAY_MS
        await storage.setPending(record)
        lastErrorCode = 'dead_letter_capacity'
      })
      if (activeEventId === eventId) resetActiveEvent()
      void reportStatus()
      schedulePump(SEND_INTERVAL_MS)
    } catch {
      lastErrorCode = 'outbox_storage_failed'
      if (activeEventId === eventId) resetActiveEvent()
      void reportStatus()
      schedulePump(RETRY_BASE_DELAY_MS)
    }
  }

  async function retryDeadLetters(): Promise<number> {
    const accountExternalId = activeAccountExternalId
    if (!accountExternalId) return 0
    try {
      const moved = await queueStorageOperation(async () => {
        const pending = await storage.listPending(accountExternalId)
        const deadLetters = await storage.listDeadLetters(accountExternalId)
        let available = Math.max(0, MAX_PENDING_EVENTS - pending.length)
        let count = 0
        for (const record of deadLetters.sort((first, second) => first.createdAt - second.createdAt)) {
          const existing = await storage.getPending(record.storageKey)
          if (existing) {
            await storage.deleteDeadLetter(record.storageKey)
            continue
          }
          if (available === 0) break
          await storage.setPending({
            storageKey: record.storageKey,
            accountExternalId: record.accountExternalId,
            event: record.event,
            createdAt: record.createdAt,
            attemptCount: 0,
            nextAttemptAt: 0,
          })
          await storage.deleteDeadLetter(record.storageKey)
          available -= 1
          count += 1
        }
        const remaining = await storage.listDeadLetters(accountExternalId)
        lastErrorCode = remaining.length ? 'dead_letter_retry_partial' : undefined
        return count
      })
      void reportStatus()
      schedulePump(0)
      return moved
    } catch {
      lastErrorCode = 'outbox_storage_failed'
      void reportStatus()
      return 0
    }
  }

  async function discardDeadLetters(): Promise<number> {
    const accountExternalId = activeAccountExternalId
    if (!accountExternalId) return 0
    try {
      const discarded = await queueStorageOperation(async () => {
        const deadLetters = await storage.listDeadLetters(accountExternalId)
        for (const record of deadLetters) await storage.deleteDeadLetter(record.storageKey)
        lastErrorCode = undefined
        return deadLetters.length
      })
      void reportStatus()
      schedulePump(0)
      return discarded
    } catch {
      lastErrorCode = 'outbox_storage_failed'
      void reportStatus()
      return 0
    }
  }

  function schedulePump(delay: number): void {
    if (!activeAccountExternalId || !emitOutboxEvent) return
    if (activeEventId || isPumping) {
      requestedPumpDelay = requestedPumpDelay === undefined
        ? delay
        : Math.min(requestedPumpDelay, delay)
      return
    }
    if (pumpTimer) clearTimeout(pumpTimer)
    requestedPumpDelay = undefined
    pumpTimer = setTimeout(() => {
      pumpTimer = undefined
      void pumpOutbox()
    }, delay)
  }

  async function pumpOutbox(): Promise<void> {
    const accountExternalId = activeAccountExternalId
    const emit = emitOutboxEvent
    if (!accountExternalId || !emit || activeEventId || isPumping) return
    isPumping = true
    try {
      const now = Date.now()
      const pending = await queueStorageOperation(() => storage.listPending(accountExternalId))
      if (!pending.length) {
        void reportStatus()
        return
      }
      const record = pending[0]
      if (!record) return
      if (record.nextAttemptAt > now) {
        schedulePump(record.nextAttemptAt - now)
        return
      }
      record.attemptCount += 1
      record.nextAttemptAt = now + calculateRetryDelay(record.attemptCount)
      await queueStorageOperation(() => storage.setPending(record))
      if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return

      activeEventId = record.event.eventId
      emit(record.event)
      ackTimer = setTimeout(() => {
        lastErrorCode = 'ack_timeout'
        resetActiveEvent()
        void reportStatus()
        schedulePump(0)
      }, ACK_TIMEOUT_MS)
      void reportStatus()
    } catch {
      lastErrorCode = 'outbox_delivery_failed'
      resetActiveEvent()
      void reportStatus()
      schedulePump(RETRY_BASE_DELAY_MS)
    } finally {
      isPumping = false
      if (requestedPumpDelay !== undefined && !activeEventId) schedulePump(requestedPumpDelay)
    }
  }

  async function reportStatus(): Promise<void> {
    const accountExternalId = activeAccountExternalId
    const emit = emitOutboxEvent
    if (!accountExternalId || !emit) return
    try {
      const [pending, deadLetters] = await Promise.all([
        queueStorageOperation(() => storage.listPending(accountExternalId)),
        queueStorageOperation(() => storage.listDeadLetters(accountExternalId)),
      ])
      if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return
      emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'outbox.status',
        pendingCount: pending.length,
        deadLetterCount: deadLetters.length,
        isSending: activeEventId !== undefined,
        lastErrorCode: lastErrorCode ?? null,
      })
    } catch {
      if (activeAccountExternalId !== accountExternalId || emitOutboxEvent !== emit) return
      emit({
        protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
        type: 'outbox.status',
        pendingCount: 0,
        deadLetterCount: 0,
        isSending: false,
        lastErrorCode: 'outbox_storage_failed',
      })
    }
  }

  async function storeDeadLetter(record: SignalOutboxRecord, errorCode: string): Promise<boolean> {
    if (await storage.getDeadLetter(record.storageKey)) return true
    const deadLetters = await storage.listDeadLetters(record.accountExternalId)
    if (deadLetters.length >= MAX_DEAD_LETTER_EVENTS) return false
    await storage.setDeadLetter({ ...record, failedAt: Date.now(), errorCode })
    return true
  }

  function resetDeliveryState(): void {
    if (pumpTimer) clearTimeout(pumpTimer)
    pumpTimer = undefined
    requestedPumpDelay = undefined
    resetActiveEvent()
  }

  function resetActiveEvent(): void {
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = undefined
    activeEventId = undefined
  }

  function queueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = storageQueue.then(operation, operation)
    storageQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    activate,
    deactivate,
    replay,
    enqueue,
    acknowledge,
    retryDeadLetters,
    discardDeadLetters,
  }
}

export function createIndexedDbSignalOutboxStorage(factory: IDBFactory | undefined): SignalOutboxStorage {
  if (!factory) return unavailableSignalOutboxStorage()
  const database = openDatabase(factory)

  async function read<T>(storeName: string, storageKey: string): Promise<T | undefined> {
    const db = await database
    const transaction = db.transaction(storeName, 'readonly')
    const completed = transactionCompleted(transaction)
    const result = await requestResult<T | undefined>(transaction.objectStore(storeName).get(storageKey))
    await completed
    return result
  }

  async function write<T>(storeName: string, value: T): Promise<void> {
    const db = await database
    const transaction = db.transaction(storeName, 'readwrite')
    const completed = transactionCompleted(transaction)
    await requestResult(transaction.objectStore(storeName).put(value))
    await completed
  }

  async function remove(storeName: string, storageKey: string): Promise<void> {
    const db = await database
    const transaction = db.transaction(storeName, 'readwrite')
    const completed = transactionCompleted(transaction)
    await requestResult(transaction.objectStore(storeName).delete(storageKey))
    await completed
  }

  async function list<T extends { accountExternalId: string }>(
    storeName: string,
    accountExternalId: string,
  ): Promise<T[]> {
    const db = await database
    const transaction = db.transaction(storeName, 'readonly')
    const completed = transactionCompleted(transaction)
    const records = await requestResult<T[]>(transaction.objectStore(storeName).getAll())
    await completed
    return records
      .filter(record => record.accountExternalId === accountExternalId)
      .sort((first, second) => {
        const firstCreatedAt = 'createdAt' in first && typeof first.createdAt === 'number' ? first.createdAt : 0
        const secondCreatedAt = 'createdAt' in second && typeof second.createdAt === 'number' ? second.createdAt : 0
        return firstCreatedAt - secondCreatedAt
      })
  }

  return {
    getPending: storageKey => read(PENDING_STORE, storageKey),
    setPending: record => write(PENDING_STORE, record),
    deletePending: storageKey => remove(PENDING_STORE, storageKey),
    listPending: accountExternalId => list(PENDING_STORE, accountExternalId),
    getDeadLetter: storageKey => read(DEAD_LETTER_STORE, storageKey),
    setDeadLetter: record => write(DEAD_LETTER_STORE, record),
    deleteDeadLetter: storageKey => remove(DEAD_LETTER_STORE, storageKey),
    listDeadLetters: accountExternalId => list(DEAD_LETTER_STORE, accountExternalId),
  }
}

function unavailableSignalOutboxStorage(): SignalOutboxStorage {
  const unavailable = (): Promise<never> => Promise.reject(new Error('Signal outbox IndexedDB unavailable'))
  return {
    getPending: unavailable,
    setPending: unavailable,
    deletePending: unavailable,
    listPending: unavailable,
    getDeadLetter: unavailable,
    setDeadLetter: unavailable,
    deleteDeadLetter: unavailable,
    listDeadLetters: unavailable,
  }
}

function buildStorageKey(accountExternalId: string, eventId: string): string {
  return `${accountExternalId}:${eventId}`
}

function calculateRetryDelay(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 10)
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** exponent), RETRY_MAX_DELAY_MS)
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'storageKey' })
      }
      if (!db.objectStoreNames.contains(DEAD_LETTER_STORE)) {
        db.createObjectStore(DEAD_LETTER_STORE, { keyPath: 'storageKey' })
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close() }
      resolve(request.result)
    }
    request.onerror = () => { reject(request.error ?? new Error('Signal outbox database open failed')) }
    request.onblocked = () => { reject(new Error('Signal outbox database upgrade blocked')) }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Signal outbox request failed')) }
  })
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('Signal outbox transaction failed')) }
    transaction.onabort = () => { reject(transaction.error ?? new Error('Signal outbox transaction aborted')) }
  })
}
