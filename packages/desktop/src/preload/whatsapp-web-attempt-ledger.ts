export interface WhatsAppSendAttemptRecord {
  attemptId: string
  platformConversationId: string
  contextRevision: number
  draftFingerprint: string
  state: 'pending' | 'confirmed'
  platformMessageId: string | null
  createdAt: number
}

const DATABASE_NAME = 'imhub-whatsapp-bridge-v1'
const ATTEMPT_STORE = 'send_attempts'
let databasePromise: Promise<IDBDatabase> | null = null

export async function readWhatsAppAttempt(attemptId: string): Promise<WhatsAppSendAttemptRecord | null> {
  const db = await attemptDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(ATTEMPT_STORE).objectStore(ATTEMPT_STORE).get(attemptId)
    request.onsuccess = () => resolve(validAttempt(request.result) ? request.result : null)
    request.onerror = () => reject(new Error('attempt read failed'))
  })
}

export async function writeWhatsAppAttempt(attempt: WhatsAppSendAttemptRecord): Promise<void> {
  const db = await attemptDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    transaction.objectStore(ATTEMPT_STORE).put(attempt)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(new Error('attempt write failed'))
    transaction.onabort = () => reject(new Error('attempt write aborted'))
  })
  await pruneAttempts()
}

export async function acknowledgeWhatsAppAttempt(
  attemptId: string,
  platformMessageId: string,
): Promise<void> {
  const attempt = await readWhatsAppAttempt(attemptId)
  if (!attempt || attempt.platformMessageId !== platformMessageId) return
  const db = await attemptDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    transaction.objectStore(ATTEMPT_STORE).delete(attemptId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(new Error('attempt acknowledgement failed'))
  })
}

export async function discardWhatsAppAttempt(attemptId: string): Promise<void> {
  const db = await attemptDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    transaction.objectStore(ATTEMPT_STORE).delete(attemptId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(new Error('attempt discard failed'))
  })
}

export async function latestWhatsAppAttempt(
  platformConversationId: string,
): Promise<WhatsAppSendAttemptRecord | null> {
  try {
    return (await allAttempts())
      .filter(attempt => attempt.platformConversationId === platformConversationId)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  } catch {
    return null
  }
}

function attemptDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ATTEMPT_STORE)) {
        request.result.createObjectStore(ATTEMPT_STORE, { keyPath: 'attemptId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('attempt database unavailable'))
    request.onblocked = () => reject(new Error('attempt database blocked'))
  })
  const result = opening.catch(error => {
    databasePromise = null
    throw error
  })
  databasePromise = result
  return result
}

async function allAttempts(): Promise<WhatsAppSendAttemptRecord[]> {
  const db = await attemptDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(ATTEMPT_STORE).objectStore(ATTEMPT_STORE).getAll()
    request.onsuccess = () => resolve((request.result as unknown[]).filter(validAttempt))
    request.onerror = () => reject(new Error('attempt list failed'))
  })
}

async function pruneAttempts(): Promise<void> {
  const attempts = (await allAttempts()).sort((left, right) => right.createdAt - left.createdAt)
  const removable = attempts.filter(attempt => attempt.state === 'confirmed').slice(100)
  if (removable.length === 0) return
  const db = await attemptDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ATTEMPT_STORE, 'readwrite')
    const store = transaction.objectStore(ATTEMPT_STORE)
    for (const attempt of removable) store.delete(attempt.attemptId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(new Error('attempt prune failed'))
  })
}

function validAttempt(value: unknown): value is WhatsAppSendAttemptRecord {
  return record(value)
    && typeof value.attemptId === 'string'
    && typeof value.platformConversationId === 'string'
    && Number.isSafeInteger(value.contextRevision)
    && typeof value.draftFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.draftFingerprint)
    && (value.state === 'pending' || value.state === 'confirmed')
    && (value.platformMessageId === null || typeof value.platformMessageId === 'string')
    && typeof value.createdAt === 'number'
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
