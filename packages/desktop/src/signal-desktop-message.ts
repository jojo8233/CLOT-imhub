import type { NativeMessageUpsertEvent } from '@im-hub/shared'
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

/**
 * 只覆盖 M5 当前 checkpoint 的入站文字。附件、编辑、删除和回应继续由后续事件
 * 分支接入，不能把看见附件元数据误写成媒体闭环已经完成。
 */
export function normalizeSignalDesktopInbound(
  conversation: SignalDesktopModelLike,
  message: SignalDesktopModelLike,
  senderConversation: SignalDesktopModelLike | null,
): NativeMessageUpsertEvent | null {
  if (attribute(message, 'type') !== 'incoming') return null
  const body = nonEmptyString(attribute(message, 'body'))
  if (!body) return null

  const senderValue = nonEmptyString(attribute(message, 'sourceServiceId'))
    ?? nonEmptyString(attribute(message, 'source'))
  const sentAtMs = attribute(message, 'sent_at')
  if (!senderValue || !Number.isSafeInteger(sentAtMs) || (sentAtMs as number) < 0) {
    throw new Error('Signal inbound message lacks stable sender or sent timestamp')
  }
  const senderExternalId = normalizeSignalPersonId(senderValue)
  const platformMessageId = signalMessageKey(senderExternalId, sentAtMs as number)
  const groupId = nonEmptyString(attribute(conversation, 'groupId'))
  const platformConversationId = groupId
    ? signalGroupConversationId(groupId)
    : signalDirectConversationId(senderExternalId)
  const eventId = `signal-inbound:${platformMessageId}`
  if (eventId.length > 128) throw new Error('Signal inbound event id exceeds protocol limit')

  const localMessageId = nonEmptyString(attribute(message, 'id'))
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
      mediaRefs: [],
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
