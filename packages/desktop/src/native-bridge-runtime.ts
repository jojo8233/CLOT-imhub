import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  NATIVE_EDIT_VERSION_MAX,
  type NativeGuestEvent,
  type NativeHostCommand,
} from '@im-hub/shared'

const MAX_EVENT_BYTES = 900_000
const MAX_OUTBOX_EVENT_COUNT = 1_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown, max = 1_000_000): value is string {
  return typeof value === 'string' && value.length <= max
}

function nonEmptyString(value: unknown, max: number): value is string {
  return string(value, max) && value.trim().length > 0
}

function nullableString(value: unknown, max = 4_096): boolean {
  return value === null || string(value, max)
}

function jsonRecord(value: unknown): boolean {
  if (!record(value)) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256_000
  } catch {
    return false
  }
}

function mediaRef(value: unknown): boolean {
  if (!record(value)
    || !['image', 'video', 'audio', 'file', 'sticker'].includes(String(value.kind))
    || !nonEmptyString(value.remoteId, 512)
    || (value.fileName !== undefined && !string(value.fileName, 1_024))
    || (value.mimeType !== undefined && !string(value.mimeType, 256))) return false
  return value.sizeBytes === undefined
    || (Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0)
}

function frameSizeAllowed(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EVENT_BYTES
  } catch {
    return false
  }
}

/** guest 页面不可信；只有通过这层最小运行时校验的事件才会进入主进程控制边界。 */
export function parseNativeGuestEvent(value: unknown): NativeGuestEvent | null {
  if (!frameSizeAllowed(value)
    || !record(value)
    || value.protocolVersion !== NATIVE_BRIDGE_PROTOCOL_VERSION
    || !string(value.type, 64)) return null

  switch (value.type) {
    case 'bridge.ready':
    case 'account.signed-out':
      return value as unknown as NativeGuestEvent
    case 'account.identity':
      if (!nonEmptyString(value.platformAccountExternalId, 512)) return null
      return value as unknown as NativeGuestEvent
    case 'context.changed': {
      if (!Number.isSafeInteger(value.contextRevision) || (value.contextRevision as number) < 0) return null
      if (value.context === null) return value as unknown as NativeGuestEvent
      if (!record(value.context)
        || !nonEmptyString(value.context.platformConversationId, 512)
        || !nonEmptyString(value.context.contactExternalId, 512)
        || !nullableString(value.context.contactDisplayName, 512)) return null
      return value as unknown as NativeGuestEvent
    }
    case 'composer.state':
      if (!Number.isSafeInteger(value.contextRevision)
        || !string(value.platformConversationId, 512)
        || !string(value.draft)
        || typeof value.canSend !== 'boolean') return null
      return value as unknown as NativeGuestEvent
    case 'command.result':
      if (!string(value.requestId, 128)
        || !['composer.set-draft', 'composer.get-draft', 'composer.send'].includes(String(value.command))
        || !Number.isSafeInteger(value.contextRevision)
        || typeof value.ok !== 'boolean'
        || (value.command === 'composer.send'
          ? !nonEmptyString(value.attemptId, 128)
          : value.attemptId !== undefined)
        || (value.draft !== undefined && !string(value.draft))
        || (value.platformMessageId !== undefined && !nonEmptyString(value.platformMessageId, 512))
        || (value.error !== undefined && (!record(value.error)
          || !nonEmptyString(value.error.code, 128)
          || !string(value.error.message, 2_048)))) return null
      return value as unknown as NativeGuestEvent
    case 'bridge.error':
      if (!nonEmptyString(value.code, 128) || !string(value.message, 2_048)) return null
      return value as unknown as NativeGuestEvent
    case 'outbox.status':
      if (!Number.isSafeInteger(value.pendingCount)
        || (value.pendingCount as number) < 0
        || (value.pendingCount as number) > MAX_OUTBOX_EVENT_COUNT
        || !Number.isSafeInteger(value.deadLetterCount)
        || (value.deadLetterCount as number) < 0
        || (value.deadLetterCount as number) > MAX_OUTBOX_EVENT_COUNT
        || typeof value.isSending !== 'boolean'
        || !nullableString(value.lastErrorCode, 128)) return null
      return value as unknown as NativeGuestEvent
    case 'message.upsert': {
      if (!nonEmptyString(value.eventId, 128) || !record(value.message)) return null
      const message = value.message
      if (!nonEmptyString(message.platformConversationId, 512)
        || !nonEmptyString(message.platformMessageId, 512)
        || (message.direction !== 'in' && message.direction !== 'out')
        || !nonEmptyString(message.senderExternalId, 512)
        || !nullableString(message.senderDisplayName, 512)
        || !nullableString(message.conversationDisplayName, 512)
        || !string(message.body)
        || !Array.isArray(message.mediaRefs) || message.mediaRefs.length > 64
        || !message.mediaRefs.every(mediaRef)
        || !nullableString(message.replyToPlatformMessageId, 512)
        || !string(message.sentAt, 64)
        || !nullableString(message.editedAt, 64)
        || (message.editVersion !== null
          && (!Number.isSafeInteger(message.editVersion)
            || (message.editVersion as number) < 0
            || (message.editVersion as number) > NATIVE_EDIT_VERSION_MAX))
        || (message.editVersion !== null && message.editedAt === null)
        || !jsonRecord(message.raw)) return null
      return value as unknown as NativeGuestEvent
    }
    case 'message.deleted':
      if (!nonEmptyString(value.eventId, 128)
        || !nonEmptyString(value.platformMessageId, 512)
        || !string(value.deletedAt, 64)) return null
      return value as unknown as NativeGuestEvent
    case 'message.id-remapped':
      if (!nonEmptyString(value.eventId, 128)
        || !nonEmptyString(value.oldPlatformMessageId, 512)
        || !nonEmptyString(value.newPlatformMessageId, 512)) return null
      return value as unknown as NativeGuestEvent
  }
  return null
}

export function parseNativeHostCommand(value: unknown): NativeHostCommand | null {
  if (!frameSizeAllowed(value)
    || !record(value)
    || value.protocolVersion !== NATIVE_BRIDGE_PROTOCOL_VERSION
    || !string(value.type, 64)) return null
  if (value.type === 'event.ack') {
    return nonEmptyString(value.eventId, 128)
      && typeof value.accepted === 'boolean'
      && typeof value.retryable === 'boolean'
      ? value as unknown as NativeHostCommand
      : null
  }
  if (value.type === 'bridge.request-state') return value as unknown as NativeHostCommand
  if (!['composer.set-draft', 'composer.get-draft', 'composer.send'].includes(value.type)
    || !nonEmptyString(value.requestId, 128)
    || !Number.isSafeInteger(value.contextRevision)
    || (value.contextRevision as number) < 0
    || !nonEmptyString(value.platformConversationId, 512)
    || (value.type === 'composer.set-draft' && !string(value.text))
    || (value.type === 'composer.send' && !nonEmptyString(value.attemptId, 128))) return null
  return value as unknown as NativeHostCommand
}
