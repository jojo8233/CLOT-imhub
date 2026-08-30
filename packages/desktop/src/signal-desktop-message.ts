import type {
  MediaRef,
  NativeConversationContext,
  NativeMessageDeletedEvent,
  NativeMessageReactionEvent,
  NativeMessageUpsertEvent,
} from '@im-hub/shared'
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
  getAci?(): unknown
  getTitle?(): unknown
}

export interface SignalDesktopWindowLike {
  ConversationController?: {
    get?(id: string): SignalDesktopModelLike | undefined
    getOurConversationOrThrow?(): SignalDesktopModelLike & { getAci?(): unknown }
  }
  /** 旧版兼容回退；8.25.0 的事实来源是 ConversationController 中的 self conversation。 */
  storage?: { user?: { getAci?(): unknown } }
}

export type SignalDesktopInboundErrorCode =
  | 'invalid_signal_inbound'
  | 'invalid_signal_media'
  | 'unsupported_signal_media'
  | 'invalid_signal_edit'
  | 'invalid_signal_delete'
  | 'invalid_signal_reaction'

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

function safeTimestamp(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return null
  const timestamp = value as number
  return Number.isNaN(new Date(timestamp).getTime()) ? null : timestamp
}

function boundedEventId(value: string, code: SignalDesktopInboundErrorCode): string {
  if (value.length <= 128) return value
  throw new SignalDesktopInboundError(code, 'Signal 入站生命周期事件标识超过桥接上限')
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

/** 当前 Signal 会话的规范平台身份；不把本地 ConversationModel id 带出 guest。 */
export function normalizeSignalDesktopConversationContext(
  conversation: SignalDesktopModelLike | null,
): NativeConversationContext | null {
  if (!conversation) return null
  const groupId = nonEmptyString(attribute(conversation, 'groupId'))
  if (groupId) {
    const platformConversationId = signalGroupConversationId(groupId)
    return {
      platformConversationId,
      contactExternalId: platformConversationId,
      contactDisplayName: displayName(conversation),
    }
  }

  let aci: unknown
  try {
    aci = conversation.getAci?.()
  } catch {
    aci = undefined
  }
  const personId = nonEmptyString(aci)
    ?? nonEmptyString(attribute(conversation, 'serviceId'))
    ?? nonEmptyString(attribute(conversation, 'e164'))
  if (!personId) return null
  const contactExternalId = normalizeSignalPersonId(personId)
  return {
    platformConversationId: signalDirectConversationId(contactExternalId),
    contactExternalId,
    contactDisplayName: displayName(conversation),
  }
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

function normalizeSignalDesktopMessage(
  conversation: SignalDesktopModelLike,
  message: SignalDesktopModelLike,
  senderConversation: SignalDesktopModelLike | null,
  editedAtMs: number | null,
  allowEmpty: boolean,
): NativeMessageUpsertEvent['message'] | null {
  if (attribute(message, 'type') !== 'incoming') return null
  const body = nonEmptyString(attribute(message, 'body')) ?? ''
  const localMessageId = nonEmptyString(attribute(message, 'id'))
  const normalizedMediaRefs = mediaRefs(message, localMessageId)
  if (!allowEmpty && !body && normalizedMediaRefs.length === 0) return null

  const senderValue = nonEmptyString(attribute(message, 'sourceServiceId'))
    ?? nonEmptyString(attribute(message, 'source'))
  const sentAtMs = safeTimestamp(attribute(message, 'sent_at'))
  if (!senderValue || sentAtMs === null) {
    throw new SignalDesktopInboundError(
      editedAtMs === null ? 'invalid_signal_inbound' : 'invalid_signal_edit',
      editedAtMs === null
        ? 'Signal 入站消息缺少稳定身份或发送时间，已拒绝回传'
        : 'Signal 入站编辑缺少原消息身份或发送时间，已拒绝回传',
    )
  }
  const senderExternalId = normalizeSignalPersonId(senderValue)
  const platformMessageId = signalMessageKey(senderExternalId, sentAtMs)
  const groupId = nonEmptyString(attribute(conversation, 'groupId'))
  const platformConversationId = groupId
    ? signalGroupConversationId(groupId)
    : signalDirectConversationId(senderExternalId)
  const receivedAtMs = attribute(message, 'received_at_ms')

  return {
    platformConversationId,
    platformMessageId,
    direction: 'in',
    senderExternalId,
    senderDisplayName: displayName(senderConversation),
    conversationDisplayName: displayName(conversation),
    body,
    mediaRefs: normalizedMediaRefs,
    replyToPlatformMessageId: null,
    sentAt: new Date(sentAtMs).toISOString(),
    editedAt: editedAtMs === null ? null : new Date(editedAtMs).toISOString(),
    // Signal 的编辑 revision 是毫秒时间戳，超过共享协议的 int32 上限；editedAt
    // 已由中央库作为同消息的单调版本使用，不能截断或伪造 editVersion。
    editVersion: null,
    raw: {
      source: 'signal-desktop',
      signalMessageId: localMessageId,
      receivedAtMs: Number.isSafeInteger(receivedAtMs) ? receivedAtMs : null,
    },
  }
}

/** 普通入站文字、图片与贴纸；编辑、删除、回应使用下方独立生命周期事件。 */
export function normalizeSignalDesktopInbound(
  conversation: SignalDesktopModelLike,
  message: SignalDesktopModelLike,
  senderConversation: SignalDesktopModelLike | null,
): NativeMessageUpsertEvent | null {
  const normalized = normalizeSignalDesktopMessage(
    conversation, message, senderConversation, null, false,
  )
  if (!normalized) return null
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId: boundedEventId(`signal-inbound:${normalized.platformMessageId}`, 'invalid_signal_inbound'),
    message: normalized,
  }
}

/** 编辑沿用原 sender+sent_at 规范键，只以 editMessageTimestamp 推进中央版本。 */
export function normalizeSignalDesktopEdit(
  conversation: SignalDesktopModelLike,
  message: SignalDesktopModelLike,
  senderConversation: SignalDesktopModelLike | null,
): NativeMessageUpsertEvent | null {
  if (attribute(message, 'type') !== 'incoming') return null
  const editedAtMs = safeTimestamp(attribute(message, 'editMessageTimestamp'))
  if (editedAtMs === null) {
    throw new SignalDesktopInboundError(
      'invalid_signal_edit',
      'Signal 入站编辑缺少稳定编辑时间，已拒绝回传',
    )
  }
  const normalized = normalizeSignalDesktopMessage(
    conversation, message, senderConversation, editedAtMs, true,
  )
  if (!normalized) return null
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.upsert',
    eventId: boundedEventId(
      `signal-edit:${normalized.platformMessageId}:${editedAtMs}`,
      'invalid_signal_edit',
    ),
    message: normalized,
  }
}

/** 为所有人删除只桥接入站目标；目标不存在时服务端仍按幂等已删除接受。 */
export function normalizeSignalDesktopDelete(
  message: SignalDesktopModelLike,
  deleteDetails: unknown,
): NativeMessageDeletedEvent | null {
  if (attribute(message, 'type') !== 'incoming') return null
  if (!record(deleteDetails)) {
    throw new SignalDesktopInboundError(
      'invalid_signal_delete',
      'Signal 入站删除结构无效，已拒绝回传',
    )
  }
  const senderValue = nonEmptyString(attribute(message, 'sourceServiceId'))
    ?? nonEmptyString(attribute(message, 'source'))
  const sentAtMs = safeTimestamp(attribute(message, 'sent_at'))
  const targetSentAtMs = safeTimestamp(deleteDetails.targetSentTimestamp)
  const deletedAtMs = safeTimestamp(deleteDetails.deleteServerTimestamp)
  if (!senderValue || sentAtMs === null || targetSentAtMs !== sentAtMs || deletedAtMs === null) {
    throw new SignalDesktopInboundError(
      'invalid_signal_delete',
      'Signal 入站删除缺少匹配的原消息身份或删除时间，已拒绝回传',
    )
  }
  const platformMessageId = signalMessageKey(normalizeSignalPersonId(senderValue), sentAtMs)
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.deleted',
    eventId: boundedEventId(
      `signal-delete:${platformMessageId}:${deletedAtMs}`,
      'invalid_signal_delete',
    ),
    platformMessageId,
    deletedAt: new Date(deletedAtMs).toISOString(),
  }
}

/** 回应以 target sender+timestamp 定位，reactor 用平台身份；fromId 等本地 UUID 不外传。 */
export function normalizeSignalDesktopReaction(
  targetMessage: SignalDesktopModelLike,
  reaction: unknown,
  reactorConversation: SignalDesktopModelLike | null,
  accountExternalId: string,
): NativeMessageReactionEvent | null {
  if (!record(reaction)) {
    throw new SignalDesktopInboundError(
      'invalid_signal_reaction',
      'Signal 入站回应结构无效，已拒绝回传',
    )
  }
  const targetType = attribute(targetMessage, 'type')
  if (targetType !== 'incoming' && targetType !== 'outgoing') return null
  const targetAuthor = nonEmptyString(reaction.targetAuthorAci)
  const targetTimestamp = safeTimestamp(reaction.targetTimestamp)
  const reactedAtMs = safeTimestamp(reaction.timestamp)
  const reactorValue = nonEmptyString(reactorConversation?.getAci?.())
    ?? nonEmptyString(attribute(reactorConversation, 'serviceId'))
  const isRemove = reaction.remove
  const emoji = nonEmptyString(reaction.emoji)
  if (!targetAuthor || targetTimestamp === null || reactedAtMs === null
    || !reactorValue || typeof isRemove !== 'boolean' || !emoji || emoji.length > 64) {
    throw new SignalDesktopInboundError(
      'invalid_signal_reaction',
      'Signal 入站回应缺少稳定目标、回应者、表情或时间，已拒绝回传',
    )
  }
  const reactorExternalId = normalizeSignalPersonId(reactorValue)
  if (reactorExternalId === normalizeSignalAci(accountExternalId)) return null
  const targetPlatformMessageId = signalMessageKey(
    normalizeSignalPersonId(targetAuthor),
    targetTimestamp,
  )
  return {
    protocolVersion: NATIVE_BRIDGE_PROTOCOL_VERSION,
    type: 'message.reaction',
    eventId: boundedEventId(
      `signal-reaction:${reactorExternalId}:${targetPlatformMessageId}:${reactedAtMs}`,
      'invalid_signal_reaction',
    ),
    targetPlatformMessageId,
    reactorExternalId,
    emoji: isRemove ? null : emoji,
    reactedAt: new Date(reactedAtMs).toISOString(),
  }
}
