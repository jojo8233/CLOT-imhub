import { createHash } from 'node:crypto'
import type { MediaRef, NormalizedMessage } from '@im-hub/shared'

export type TelegramShadowSource = 'tdlib' | 'telegram-tt'
export type TelegramShadowEventType = 'upsert' | 'delete' | 'remap'

export interface TelegramShadowObservation {
  accountId: string
  source: TelegramShadowSource
  eventType: TelegramShadowEventType
  factKey: string
  semanticHash: string
}

interface SemanticMediaShape {
  kind: MediaRef['kind']
  fileName: string | null
  mimeType: string | null
  sizeBytes: number | null
}

export function buildTelegramUpsertObservation(
  source: TelegramShadowSource,
  message: NormalizedMessage,
): TelegramShadowObservation {
  if (message.platform !== 'telegram') {
    throw new Error('Telegram shadow observation requires a Telegram message')
  }

  const factKey = `upsert:${message.platformMessageId}:${messageRevision(message)}`
  const media = message.mediaRefs
    .map(toSemanticMediaShape)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const semanticPayload = {
    platformConversationId: message.platformConversationId,
    platformMessageId: message.platformMessageId,
    direction: message.direction,
    senderExternalId: message.senderExternalId,
    bodyHash: hash(message.body),
    media,
    replyToPlatformMessageId: message.replyToPlatformMessageId ?? null,
    sentAt: message.sentAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    editVersion: message.editVersion ?? null,
  }

  return {
    accountId: message.accountId,
    source,
    eventType: 'upsert',
    factKey,
    semanticHash: hash(JSON.stringify(semanticPayload)),
  }
}

export function buildTelegramDeleteObservation(
  accountId: string,
  source: TelegramShadowSource,
  platformMessageId: string,
): TelegramShadowObservation {
  return buildIdentityObservation(accountId, source, 'delete', `delete:${platformMessageId}`)
}

export function buildTelegramRemapObservation(
  accountId: string,
  source: TelegramShadowSource,
  oldPlatformMessageId: string,
  newPlatformMessageId: string,
): TelegramShadowObservation {
  return buildIdentityObservation(
    accountId,
    source,
    'remap',
    `remap:${oldPlatformMessageId}:${newPlatformMessageId}`,
  )
}

function messageRevision(message: NormalizedMessage): string {
  if (message.editVersion !== null && message.editVersion !== undefined) {
    return `version:${message.editVersion}`
  }
  if (message.editedAt) return `edited-at:${message.editedAt.toISOString()}`
  return 'base'
}

function toSemanticMediaShape(media: MediaRef): SemanticMediaShape {
  return {
    kind: media.kind,
    fileName: media.fileName ?? null,
    mimeType: media.mimeType ?? null,
    sizeBytes: media.sizeBytes ?? null,
  }
}

function buildIdentityObservation(
  accountId: string,
  source: TelegramShadowSource,
  eventType: Exclude<TelegramShadowEventType, 'upsert'>,
  factKey: string,
): TelegramShadowObservation {
  return { accountId, source, eventType, factKey, semanticHash: hash(factKey) }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
