const DIRECT_PREFIX = 'u:'
const GROUP_PREFIX = 'g:'
const SIGNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeSignalAci(value: string): string {
  const normalized = value.trim()
  if (!SIGNAL_UUID.test(normalized)) throw new Error('Signal ACI must be a UUID')
  return normalized.toLowerCase()
}

/**
 * Signal 的 ACI/UUID 大小写不承载身份语义。统一成小写，避免 Signal Desktop 与
 * signal-cli 对同一个发送者给出不同大小写时绕过去重键。
 */
export function normalizeSignalPersonId(value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error('Signal person id cannot be empty')
  return SIGNAL_UUID.test(normalized) ? normalizeSignalAci(normalized) : normalized
}

export function signalDirectConversationId(personId: string): string {
  return `${DIRECT_PREFIX}${normalizeSignalPersonId(personId)}`
}

export function signalGroupConversationId(groupId: string): string {
  const normalized = groupId.trim()
  if (normalized === '') throw new Error('Signal group id cannot be empty')
  return `${GROUP_PREFIX}${normalized}`
}

/** Signal 的跨客户端消息身份是发送者 + 发送时间戳，不是本地数据库 UUID。 */
export function signalMessageKey(senderId: string, sentAtMs: number): string {
  if (!Number.isSafeInteger(sentAtMs) || sentAtMs < 0) {
    throw new Error('Signal message timestamp must be a non-negative safe integer')
  }
  return `${normalizeSignalPersonId(senderId)}:${sentAtMs}`
}

export interface SignalMessageKey {
  senderId: string
  sentAtMs: number
}

export function parseSignalMessageKey(value: string): SignalMessageKey | null {
  const separator = value.lastIndexOf(':')
  if (separator <= 0 || separator === value.length - 1) return null
  const senderId = value.slice(0, separator)
  const timestamp = value.slice(separator + 1)
  if (!/^(0|[1-9][0-9]*)$/.test(timestamp)) return null
  const sentAtMs = Number(timestamp)
  if (!Number.isSafeInteger(sentAtMs)) return null
  try {
    const normalizedSender = normalizeSignalPersonId(senderId)
    if (normalizedSender !== senderId) return null
    return { senderId, sentAtMs }
  } catch {
    return null
  }
}

export function isSignalConversationId(value: string): boolean {
  if (value.startsWith(DIRECT_PREFIX)) {
    const personId = value.slice(DIRECT_PREFIX.length)
    try {
      return signalDirectConversationId(personId) === value
    } catch {
      return false
    }
  }
  if (value.startsWith(GROUP_PREFIX)) {
    const groupId = value.slice(GROUP_PREFIX.length)
    try {
      return signalGroupConversationId(groupId) === value
    } catch {
      return false
    }
  }
  return false
}
