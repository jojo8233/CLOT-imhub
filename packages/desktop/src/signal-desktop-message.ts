import type { MediaRef, NativeMessageUpsertEvent } from '@im-hub/shared'
import {
  NATIVE_BRIDGE_PROTOCOL_VERSION,
  normalizeSignalAci,
  normalizeSignalPersonId,
  signalDirectConversationId,
  signalGroupConversationId,
  signalMessageKey,
} from '@im-hub/shared'

export interface SignalDesktopModelLike {
  attributes?: Record<string, unknown>
  get?(key: string): unknown
  getTitle?(): unknown
}

export interface SignalDesktopWindowLike {
  ConversationController?: {
    getOurConversationOrThrow?(): SignalDesktopModelLike & { getAci?(): unknown }
  }
  /** 旧版兼容回退；8.25.0 的事实来源是 ConversationController 中的 self conversation。 */
  storage?: { user?: { getAci?(): unknown } }
}

export type SignalDesktopInboundErrorCode =
  | 'invalid_signal_inbound'
  | 'invalid_signal_media'
  | 'unsupported_signal_media'

export class SignalDesktopInboundError extends Error {
  constructor(
    readonly code: SignalDesktopInboundErrorCode,
    readonly safeMessage: string,
  ) {
    super(safeMessage)
    this.name = 'SignalDesktopInboundError'
  }
}

function attribute(model: SignalDesktopModelLike | null, key: string): unknown {
  if (!model) return undefined
  try {
    return model.get?.(key) ?? model.attributes?.[key]
  } catch {
    return model.attributes?.[key]
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readSignalDesktopAci(signalWindow: SignalDesktopWindowLike): string | null {
  let value: unknown
  try {
    const self = signalWindow.ConversationController?.getOurConversationOrThrow?.()
    value = self?.getAci?.() ?? self?.get?.('serviceId') ?? self?.attributes?.serviceId
  } catch {
    value = undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    try {
      value = signalWindow.storage?.user?.getAci?.()
    } catch {
      value = undefined
    }
  }
  if (typeof value !== 'string') return null
  try {
    return normalizeSignalAci(value)
  } catch {
    return null
  }
}

function displayName(model: SignalDesktopModelLike | null): string | null {
  if (!model) return null
  try {
    const title = model.getTitle?.()
    if (typeof title === 'string' && title.trim() !== '') return title
  } catch {
    // Signal 的展示名不是消息身份的一部分；取不到时继续使用已知属性。
  }
  for (const key of ['name', 'profileName', 'systemNickname', 'e164']) {
    const value = nonEmptyString(attribute(model, key))
    if (value) return value
  }
  return null
}

/** 当前只桥接图片与贴纸元数据，不读取文件、不导出本机路径或任何附件密钥。 */
function mediaRefs(message: SignalDesktopModelLike, localMessageId: string | null): MediaRef[] {
  const rawAttachments = attribute(message, 'attachments')
  if (rawAttachments !== undefined && rawAttachments !== null && !Array.isArray(rawAttachments)) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 入站媒体结构无效，已拒绝回传',
    )
  }
  const attachments = rawAttachments ?? []
  const sticker = attribute(message, 'sticker')
  const hasSticker = sticker !== undefined && sticker !== null
  if (hasSticker && !record(sticker)) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 入站贴纸结构无效，已拒绝回传',
    )
  }
  if (hasSticker && (!nonEmptyString(sticker.packId)
    || !Number.isSafeInteger(sticker.stickerId)
    || (sticker.stickerId as number) < 0)) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 入站贴纸缺少稳定包或贴纸标识，已拒绝回传',
    )
  }
  if (attachments.length === 0 && !hasSticker) return []
  if (!localMessageId) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 入站图片或贴纸缺少稳定本地消息标识，已拒绝回传',
    )
  }

  const refs: MediaRef[] = []
  for (const [index, value] of attachments.entries()) {
    if (!record(value)) {
      throw new SignalDesktopInboundError(
        'invalid_signal_media',
        'Signal 入站附件结构无效，已拒绝回传',
      )
    }
    const contentType = optionalBoundedString(value.contentType, 256)
    if (!contentType) {
      throw new SignalDesktopInboundError(
        'invalid_signal_media',
        'Signal 入站附件缺少有效媒体类型，已拒绝回传',
      )
    }
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new SignalDesktopInboundError(
        'unsupported_signal_media',
        'Signal 入站媒体类型尚未接入；当前只支持图片与贴纸',
      )
    }
    const fileName = optionalBoundedString(value.fileName, 1_024)
    refs.push({
      kind: 'image',
      remoteId: signalDesktopMediaRemoteId(localMessageId, `attachment:${index}`),
      ...(fileName !== undefined ? { fileName } : {}),
      mimeType: contentType,
      ...(Number.isSafeInteger(value.size) && (value.size as number) >= 0
        ? { sizeBytes: value.size as number }
        : {}),
    })
  }

  if (hasSticker) {
    const data = record(sticker.data) ? sticker.data : null
    const contentType = optionalBoundedString(data?.contentType, 256)
    refs.push({
      kind: 'sticker',
      remoteId: signalDesktopMediaRemoteId(localMessageId, 'sticker'),
      ...(contentType ? { mimeType: contentType } : {}),
      ...(Number.isSafeInteger(data?.size) && (data?.size as number) >= 0
        ? { sizeBytes: data?.size as number }
        : {}),
    })
  }

  if (refs.length > 64) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 单条入站消息的图片或贴纸数量超过桥接上限',
    )
  }
  return refs
}

function signalDesktopMediaRemoteId(
  localMessageId: string,
  slot: `attachment:${number}` | 'sticker',
): string {
  if (localMessageId.length > 400) {
    throw new SignalDesktopInboundError(
      'invalid_signal_media',
      'Signal 入站媒体的本地消息标识超过桥接上限',
    )
  }
  return `signal-desktop:${localMessageId}:${slot}`
}

/**
 * 覆盖入站纯文字、图片与贴纸。编辑、删除、回应及其他媒体类型继续由后续事件分支接入。
 */
export function normalizeSignalDesktopInbound(
  conversation: SignalDesktopModelLike,
  message: SignalDesktopModelLike,
  senderConversation: SignalDesktopModelLike | null,
): NativeMessageUpsertEvent | null {
  if (attribute(message, 'type') !== 'incoming') return null
  const body = nonEmptyString(attribute(message, 'body')) ?? ''
  const localMessageId = nonEmptyString(attribute(message, 'id'))
  const normalizedMediaRefs = mediaRefs(message, localMessageId)
  if (!body && normalizedMediaRefs.length === 0) return null

  const senderValue = nonEmptyString(attribute(message, 'sourceServiceId'))
    ?? nonEmptyString(attribute(message, 'source'))
  const sentAtMs = attribute(message, 'sent_at')
  if (!senderValue || !Number.isSafeInteger(sentAtMs) || (sentAtMs as number) < 0) {
    throw new SignalDesktopInboundError(
      'invalid_signal_inbound',
      'Signal 入站消息缺少稳定身份或发送时间，已拒绝回传',
    )
  }
  const senderExternalId = normalizeSignalPersonId(senderValue)
  const platformMessageId = signalMessageKey(senderExternalId, sentAtMs as number)
  const groupId = nonEmptyString(attribute(conversation, 'groupId'))
  const platformConversationId = groupId
    ? signalGroupConversationId(groupId)
    : signalDirectConversationId(senderExternalId)
  const eventId = `signal-inbound:${platformMessageId}`
  if (eventId.length > 128) throw new Error('Signal inbound event id exceeds protocol limit')

  const receivedAtMs = attribute(message, 'received_at_ms')
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId,
    message: {
      platformConversationId,
      platformMessageId,
      direction: 'in',
      senderExternalId,
      senderDisplayName: displayName(senderConversation),
      conversationDisplayName: displayName(conversation),
      body,
      mediaRefs: normalizedMediaRefs,
      replyToPlatformMessageId: null,
      sentAt: new Date(sentAtMs as number).toISOString(),
      editedAt: null,
      editVersion: null,
      raw: {
        source: 'signal-desktop',
        signalMessageId: localMessageId,
        receivedAtMs: Number.isSafeInteger(receivedAtMs) ? receivedAtMs : null,
      },
    },
  }
}
