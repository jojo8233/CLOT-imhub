import {
  signalMessageKey,
  type NativeComposerStateEvent,
  type NativeSendCommand,
} from '@im-hub/shared'
import { isNativeDraftFingerprint, nativeDraftFingerprint } from './native-draft-fingerprint.js'
import type {
  SignalDesktopComposerSnapshot,
  SignalDesktopComposerWindowLike,
} from './signal-desktop-composer.js'
import { readSignalDesktopComposerSnapshot as readSignalSnapshot } from './signal-desktop-composer.js'
import type { SignalDesktopModelLike } from './signal-desktop-message.js'

const DATABASE_NAME = 'imhub-signal-send-attempts'
const DATABASE_VERSION = 1
const ATTEMPT_STORE = 'attempts'
const MAX_SEND_ATTEMPTS = 100

export interface SignalSendAttemptRecord {
  storageKey: string
  accountExternalId: string
  attemptId: string
  platformConversationId: string
  /** 只在 Signal guest 内使用，不跨进程上报。 */
  localConversationId: string
  contextRevision: number
  draftFingerprint: string
  submittedAt: number
  localMessageId: string | null
  platformMessageId: string | null
  createdAt: number
  updatedAt: number
}

export interface SignalSendAttemptStorage {
  getAttempt(storageKey: string): Promise<SignalSendAttemptRecord | undefined>
  setAttempt(record: SignalSendAttemptRecord): Promise<void>
  deleteAttempt(storageKey: string): Promise<void>
  listAttempts(accountExternalId: string): Promise<SignalSendAttemptRecord[]>
}

export interface SignalOutgoingMessageLike extends SignalDesktopModelLike {
  id?: string
}

export interface SignalDesktopSendWindowLike extends SignalDesktopComposerWindowLike {
  /** 由 8.25.0 bundle 注入，使用 Signal 自己的 DataReader 按本地消息 id 恢复。 */
  __imHubSignalResolveOutgoingMessage?(localMessageId: string): Promise<unknown>
}

export type SignalSendAttemptRecovery = NonNullable<NativeComposerStateEvent['sendAttempt']>

export type SignalDesktopSendErrorCode =
  | 'signal_send_attempt_unavailable'
  | 'signal_send_attempt_capacity'
  | 'signal_send_attempt_conflict'
  | 'signal_send_attempt_mismatch'
  | 'signal_send_draft_changed'
  | 'signal_send_not_plain_text'
  | 'signal_send_submit_rejected'
  | 'signal_send_recovery_unavailable'
  | 'signal_send_persistence_mismatch'

export class SignalDesktopSendError extends Error {
  constructor(
    readonly code: SignalDesktopSendErrorCode,
    readonly safeMessage: string,
  ) {
    super(safeMessage)
    this.name = 'SignalDesktopSendError'
  }
}

export interface SignalDesktopSendLedger {
  activate(accountExternalId: string): void
  send(command: NativeSendCommand, snapshot: SignalDesktopComposerSnapshot): Promise<string>
  onOutgoingMessagePrepared(message: SignalOutgoingMessageLike): Promise<void>
  onOutgoingMessagePersisted(message: SignalOutgoingMessageLike): Promise<void>
  recover(platformConversationId: string): Promise<SignalSendAttemptRecovery | undefined>
  acknowledge(attemptId: string, platformMessageId: string): Promise<void>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

/**
 * Signal 文字发送账本：先持久化 attempt，再调用 CompositionInput.submit；只有
 * enqueueMessageForSend 的消息 + job 已写入 Signal 数据库后才解析最终规范消息 id。
 */
export function createSignalDesktopSendLedger(
  storage: SignalSendAttemptStorage,
  signalWindow: SignalDesktopSendWindowLike,
): SignalDesktopSendLedger {
  let activeAccountExternalId: string | undefined
  let preparationQueue = Promise.resolve<unknown>(undefined)
  const activeSends = new Map<string, Promise<string>>()
  const waiters = new Map<string, Deferred<string>>()

  function activate(accountExternalId: string): void {
    if (activeAccountExternalId !== accountExternalId) {
      activeSends.clear()
      for (const waiter of waiters.values()) {
        waiter.reject(new SignalDesktopSendError(
          'signal_send_attempt_unavailable',
          'Signal 登录身份已经变化，发送结果需要重新核对',
        ))
      }
      waiters.clear()
    }
    activeAccountExternalId = accountExternalId
  }

  function requireAccount(): string {
    if (!activeAccountExternalId) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_unavailable',
        'Signal 发送账本尚未绑定登录身份',
      )
    }
    return activeAccountExternalId
  }

  async function send(
    command: NativeSendCommand,
    snapshot: SignalDesktopComposerSnapshot,
  ): Promise<string> {
    const accountExternalId = requireAccount()
    const storageKey = buildStorageKey(accountExternalId, command.attemptId)
    const active = activeSends.get(storageKey)
    if (active) return active

    const operation = executeSend(accountExternalId, storageKey, command, snapshot)
      .finally(() => {
        if (activeSends.get(storageKey) === operation) activeSends.delete(storageKey)
      })
    activeSends.set(storageKey, operation)
    return operation
  }

  async function executeSend(
    accountExternalId: string,
    storageKey: string,
    command: NativeSendCommand,
    snapshot: SignalDesktopComposerSnapshot,
  ): Promise<string> {
    const record = await queuePreparation(() => prepareAttempt(
      accountExternalId, storageKey, command, snapshot,
    ))
    if (record.platformMessageId) return record.platformMessageId

    const recovered = await reconcilePersistedMessage(record)
    if (recovered?.platformMessageId) return recovered.platformMessageId

    const current = readCurrentSnapshot(record)
    const currentFingerprint = await nativeDraftFingerprint(current.draft)
    if (currentFingerprint !== record.draftFingerprint) {
      throw new SignalDesktopSendError(
        'signal_send_draft_changed',
        'Signal 原生输入框正文已经变化，旧发送 attempt 未再次提交',
      )
    }
    if (!current.canSendPlainText) {
      throw new SignalDesktopSendError(
        'signal_send_not_plain_text',
        'Signal 自动发送当前只接受已持久化的纯文字新消息',
      )
    }

    const editor = signalWindow.__imHubSignalComposerEditor
    if (editor?.conversationId !== record.localConversationId || !editor.submit) {
      throw new SignalDesktopSendError(
        'signal_send_submit_rejected',
        'Signal 可见输入框尚未准备好，未提交自动发送',
      )
    }

    const waiter = createDeferred<string>()
    waiters.set(storageKey, waiter)
    let accepted: unknown
    try {
      accepted = await Promise.resolve(editor.submit(record.submittedAt))
    } catch {
      waiters.delete(storageKey)
      throw new SignalDesktopSendError(
        'signal_send_submit_rejected',
        'Signal 原生输入框拒绝自动发送',
      )
    }
    if (accepted !== true) {
      waiters.delete(storageKey)
      throw new SignalDesktopSendError(
        'signal_send_submit_rejected',
        'Signal 原生输入框没有接受自动发送',
      )
    }
    return waiter.promise
  }

  async function prepareAttempt(
    accountExternalId: string,
    storageKey: string,
    command: NativeSendCommand,
    snapshot: SignalDesktopComposerSnapshot,
  ): Promise<SignalSendAttemptRecord> {
    if (!isNativeDraftFingerprint(command.draftFingerprint)) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        'Signal 发送命令缺少有效正文指纹',
      )
    }
    if (!Number.isSafeInteger(command.attemptContextRevision)
      || (command.attemptContextRevision as number) < 0) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        'Signal 发送命令缺少有效 attempt 会话 revision',
      )
    }
    const existing = await storage.getAttempt(storageKey)
    if (existing) {
      if (existing.platformConversationId !== command.platformConversationId
        || existing.draftFingerprint !== command.draftFingerprint
        || existing.contextRevision !== command.attemptContextRevision) {
        throw new SignalDesktopSendError(
          'signal_send_attempt_mismatch',
          'Signal 发送 attempt 与已持久化会话或正文不匹配',
        )
      }
      return existing
    }

    if (snapshot.context.platformConversationId !== command.platformConversationId) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        'Signal 当前会话已经变化，发送 attempt 未建立',
      )
    }
    if (command.attemptContextRevision !== command.contextRevision) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        '新 Signal 发送 attempt 的会话 revision 不匹配',
      )
    }
    const fingerprint = await nativeDraftFingerprint(snapshot.draft)
    if (fingerprint !== command.draftFingerprint) {
      throw new SignalDesktopSendError(
        'signal_send_draft_changed',
        'Signal 原生输入框正文已经变化，发送 attempt 未建立',
      )
    }
    if (!snapshot.canSendPlainText) {
      throw new SignalDesktopSendError(
        'signal_send_not_plain_text',
        'Signal 自动发送当前只接受已持久化的纯文字新消息',
      )
    }

    const attempts = await storage.listAttempts(accountExternalId)
    const conflicting = attempts.find(item => item.platformConversationId === command.platformConversationId
      && item.draftFingerprint === command.draftFingerprint)
    if (conflicting) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_conflict',
        '同一 Signal 会话和正文已有待核对发送 attempt',
      )
    }
    if (attempts.length >= MAX_SEND_ATTEMPTS) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_capacity',
        'Signal 发送 attempt 账本已满，请先完成待核对发送',
      )
    }

    const now = Date.now()
    const submittedAt = attempts.reduce(
      (candidate, item) => Math.max(candidate, item.submittedAt + 1),
      now,
    )
    const record: SignalSendAttemptRecord = {
      storageKey,
      accountExternalId,
      attemptId: command.attemptId,
      platformConversationId: command.platformConversationId,
      localConversationId: snapshot.localConversationId,
      contextRevision: command.attemptContextRevision,
      draftFingerprint: command.draftFingerprint,
      submittedAt,
      localMessageId: null,
      platformMessageId: null,
      createdAt: now,
      updatedAt: now,
    }
    await storage.setAttempt(record)
    return record
  }

  function readCurrentSnapshot(record: SignalSendAttemptRecord): SignalDesktopComposerSnapshot {
    const snapshot = readSnapshot()
    if (!snapshot
      || snapshot.localConversationId !== record.localConversationId
      || snapshot.context.platformConversationId !== record.platformConversationId) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        'Signal 当前会话已经变化，旧发送 attempt 未再次提交',
      )
    }
    return snapshot
  }

  function readSnapshot(): SignalDesktopComposerSnapshot | null {
    const store = signalWindow.reduxStore
    if (!store) return null
    // 延迟导入会形成不必要的异步窗口；调用方传入的 snapshot 仍会在提交前重验。
    return readSignalSnapshot(signalWindow)
  }

  async function onOutgoingMessagePrepared(message: SignalOutgoingMessageLike): Promise<void> {
    const record = await findAttemptForMessage(message)
    if (!record) return
    const localMessageId = messageId(message)
    if (!localMessageId) {
      throw new SignalDesktopSendError(
        'signal_send_persistence_mismatch',
        'Signal 最终出向消息缺少稳定本地标识',
      )
    }
    await validateAttemptMessage(record, message)
    await storage.setAttempt({
      ...record,
      localMessageId,
      updatedAt: Date.now(),
    })
  }

  async function onOutgoingMessagePersisted(message: SignalOutgoingMessageLike): Promise<void> {
    const record = await findAttemptForMessage(message)
    if (!record) return
    const confirmed = await confirmPersistedMessage(record, message)
    if (!confirmed.platformMessageId) {
      throw new SignalDesktopSendError(
        'signal_send_persistence_mismatch',
        'Signal 最终消息没有生成规范消息标识',
      )
    }
    waiters.get(record.storageKey)?.resolve(confirmed.platformMessageId)
    waiters.delete(record.storageKey)
  }

  async function reconcilePersistedMessage(
    record: SignalSendAttemptRecord,
  ): Promise<SignalSendAttemptRecord | undefined> {
    if (!record.localMessageId) return undefined
    const resolveMessage = signalWindow.__imHubSignalResolveOutgoingMessage
    if (!resolveMessage) {
      throw new SignalDesktopSendError(
        'signal_send_recovery_unavailable',
        'Signal 最终消息恢复接口尚未准备好',
      )
    }
    let value: unknown
    try {
      value = await resolveMessage(record.localMessageId)
    } catch {
      throw new SignalDesktopSendError(
        'signal_send_recovery_unavailable',
        'Signal 最终消息暂时无法从本地存储核对',
      )
    }
    if (value == null) return undefined
    return confirmPersistedMessage(record, asMessage(value))
  }

  async function confirmPersistedMessage(
    record: SignalSendAttemptRecord,
    message: SignalOutgoingMessageLike,
  ): Promise<SignalSendAttemptRecord> {
    await validateAttemptMessage(record, message)
    const localMessageId = messageId(message)
    if (!localMessageId || (record.localMessageId && record.localMessageId !== localMessageId)) {
      throw new SignalDesktopSendError(
        'signal_send_persistence_mismatch',
        'Signal 最终消息与发送 attempt 的本地标识不匹配',
      )
    }
    const platformMessageId = signalMessageKey(record.accountExternalId, record.submittedAt)
    const confirmed = {
      ...record,
      localMessageId,
      platformMessageId,
      updatedAt: Date.now(),
    }
    await storage.setAttempt(confirmed)
    return confirmed
  }

  async function validateAttemptMessage(
    record: SignalSendAttemptRecord,
    message: SignalOutgoingMessageLike,
  ): Promise<void> {
    const type = messageAttribute(message, 'type')
    const conversationId = messageAttribute(message, 'conversationId')
    const sentAt = messageAttribute(message, 'sent_at')
    const body = messageAttribute(message, 'body')
    if (type !== 'outgoing'
      || conversationId !== record.localConversationId
      || sentAt !== record.submittedAt
      || typeof body !== 'string'
      || await nativeDraftFingerprint(body) !== record.draftFingerprint) {
      throw new SignalDesktopSendError(
        'signal_send_persistence_mismatch',
        'Signal 最终出向消息与发送 attempt 不匹配',
      )
    }
  }

  async function findAttemptForMessage(
    message: SignalOutgoingMessageLike,
  ): Promise<SignalSendAttemptRecord | undefined> {
    const accountExternalId = activeAccountExternalId
    const sentAt = messageAttribute(message, 'sent_at')
    const conversationId = messageAttribute(message, 'conversationId')
    if (!accountExternalId || !Number.isSafeInteger(sentAt) || typeof conversationId !== 'string') {
      return undefined
    }
    const attempts = await storage.listAttempts(accountExternalId)
    const record = attempts.find(record => record.submittedAt === sentAt
      && record.localConversationId === conversationId)
    if (!record) return undefined
    const type = messageAttribute(message, 'type')
    const body = messageAttribute(message, 'body')
    if (type !== 'outgoing'
      || typeof body !== 'string'
      || await nativeDraftFingerprint(body) !== record.draftFingerprint) return undefined
    return record
  }

  async function recover(
    platformConversationId: string,
  ): Promise<SignalSendAttemptRecovery | undefined> {
    const accountExternalId = requireAccount()
    const attempts = (await storage.listAttempts(accountExternalId))
      .filter(record => record.platformConversationId === platformConversationId)
      .sort((first, second) => second.createdAt - first.createdAt)
    const record = attempts[0]
    if (!record) return undefined
    const reconciled = record.platformMessageId ? record : await reconcilePersistedMessage(record) ?? record
    return {
      attemptId: reconciled.attemptId,
      contextRevision: reconciled.contextRevision,
      draftFingerprint: reconciled.draftFingerprint,
      platformMessageId: reconciled.platformMessageId,
    }
  }

  async function acknowledge(attemptId: string, platformMessageId: string): Promise<void> {
    const accountExternalId = requireAccount()
    const storageKey = buildStorageKey(accountExternalId, attemptId)
    const record = await storage.getAttempt(storageKey)
    if (!record) return
    if (!record.platformMessageId || record.platformMessageId !== platformMessageId) {
      throw new SignalDesktopSendError(
        'signal_send_attempt_mismatch',
        'Signal 发送 ACK 与最终消息结果不匹配',
      )
    }
    await storage.deleteAttempt(storageKey)
  }

  function queuePreparation<T>(operation: () => Promise<T>): Promise<T> {
    const result = preparationQueue.then(operation, operation)
    preparationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    activate,
    send,
    onOutgoingMessagePrepared,
    onOutgoingMessagePersisted,
    recover,
    acknowledge,
  }
}

export function createIndexedDbSignalSendAttemptStorage(
  factory: IDBFactory | undefined,
): SignalSendAttemptStorage {
  if (!factory) return unavailableStorage()
  const database = openDatabase(factory)

  async function getAttempt(storageKey: string): Promise<SignalSendAttemptRecord | undefined> {
    const db = await database
    const transaction = db.transaction(ATTEMPT_STORE, 'readonly')
    const completed = transactionCompleted(transaction)
    const result = await requestResult<SignalSendAttemptRecord | undefined>(
      transaction.objectStore(ATTEMPT_STORE).get(storageKey),
    )
    await completed
    return result
  }

  async function setAttempt(record: SignalSendAttemptRecord): Promise<void> {
    const db = await database
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    const completed = transactionCompleted(transaction)
    await requestResult(transaction.objectStore(ATTEMPT_STORE).put(record))
    await completed
  }

  async function deleteAttempt(storageKey: string): Promise<void> {
    const db = await database
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    const completed = transactionCompleted(transaction)
    await requestResult(transaction.objectStore(ATTEMPT_STORE).delete(storageKey))
    await completed
  }

  async function listAttempts(accountExternalId: string): Promise<SignalSendAttemptRecord[]> {
    const db = await database
    const transaction = db.transaction(ATTEMPT_STORE, 'readonly')
    const completed = transactionCompleted(transaction)
    const records = await requestResult<SignalSendAttemptRecord[]>(
      transaction.objectStore(ATTEMPT_STORE).getAll(),
    )
    await completed
    return records
      .filter(record => record.accountExternalId === accountExternalId)
      .sort((first, second) => first.createdAt - second.createdAt)
  }

  return { getAttempt, setAttempt, deleteAttempt, listAttempts }
}

function buildStorageKey(accountExternalId: string, attemptId: string): string {
  return `${accountExternalId}:${attemptId}`
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  let rejectPromise: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function messageAttribute(message: SignalOutgoingMessageLike, key: string): unknown {
  try {
    return message.get?.(key) ?? message.attributes?.[key]
  } catch {
    return message.attributes?.[key]
  }
}

function messageId(message: SignalOutgoingMessageLike): string | null {
  const id = message.id ?? messageAttribute(message, 'id')
  return typeof id === 'string' && id.trim() !== '' && id.length <= 512 ? id : null
}

function asMessage(value: unknown): SignalOutgoingMessageLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SignalDesktopSendError(
      'signal_send_persistence_mismatch',
      'Signal 最终消息恢复结果结构无效',
    )
  }
  return value as SignalOutgoingMessageLike
}

function unavailableStorage(): SignalSendAttemptStorage {
  const unavailable = (): Promise<never> => Promise.reject(new Error('Signal send ledger unavailable'))
  return {
    getAttempt: unavailable,
    setAttempt: unavailable,
    deleteAttempt: unavailable,
    listAttempts: unavailable,
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ATTEMPT_STORE)) {
        db.createObjectStore(ATTEMPT_STORE, { keyPath: 'storageKey' })
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close() }
      resolve(request.result)
    }
    request.onerror = () => { reject(request.error ?? new Error('Signal send ledger open failed')) }
    request.onblocked = () => { reject(new Error('Signal send ledger upgrade blocked')) }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('Signal send ledger request failed')) }
  })
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onerror = () => { reject(transaction.error ?? new Error('Signal send ledger failed')) }
    transaction.onabort = () => { reject(transaction.error ?? new Error('Signal send ledger aborted')) }
  })
}
