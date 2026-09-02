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
    // telegram-tt 的出向媒体在开始上传时定格本地时间，TDLib 则返回平台接受
    // 上传后的服务端时间；上传耗时不是消息内容差异。入向媒体和文本仍严格比较。
    sentAt: message.direction === 'out' && message.mediaRefs.length > 0
      ? null
      : message.sentAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    // telegram-tt 的 MTProto pts 用于其自身落库排序，TDLib 不暴露等价字段。
    // 保留 payload 键并固定为 null，让两来源可比较且保持 base/edit 结构一致。
    editVersion: null,
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
  if (message.editedAt) return `edited-at:${message.editedAt.toISOString()}`
  // Bridge v2 要求非 null editVersion 必须同时携带 editedAt；这里仅为内部异常
  // 输入保留不可伪造的降级键，正常双来源编辑不会走到该分支。
  if (message.editVersion !== null && message.editVersion !== undefined) {
    return `version:${message.editVersion}`
  }
  return 'base'
}

function toSemanticMediaShape(media: MediaRef): SemanticMediaShape {
  return {
    kind: media.kind,
    fileName: comparableFileName(media),
    mimeType: media.mimeType ?? null,
    sizeBytes: media.sizeBytes ?? null,
  }
}

function comparableFileName(media: MediaRef): string | null {
  const fileName = media.fileName ?? null
  if (!fileName) return null

  // telegram-tt 在 MTProto 没有 filename attribute 时用媒体 id 生成 UI 文件名；
  // TDLib 只返回空 file_name。该 id 又是 SDK 专属远端引用，不能进入跨来源指纹。
  const fallbackPrefix = media.kind === 'video'
    ? 'video'
    : media.kind === 'audio'
      ? 'audio'
      : media.kind === 'file'
        ? 'file'
        : null
  return fallbackPrefix && fileName.startsWith(`${fallbackPrefix}${media.remoteId}.`)
    ? null
    : fileName
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
