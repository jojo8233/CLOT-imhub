const TELEGRAM_SERVER_MESSAGE_ID_MAX = 2_147_483_647n
const TDLIB_SERVER_ID_SHIFT = 20n
const TDLIB_LOCAL_BITS_MASK = (1n << TDLIB_SERVER_ID_SHIFT) - 1n
const TELEGRAM_CHAT_ID_MIN = -(1n << 63n)
const TELEGRAM_CHAT_ID_MAX = (1n << 63n) - 1n
const CANONICAL_INTEGER = /^-?(?:0|[1-9]\d*)$/
const CANONICAL_LOCAL_ID = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const NEGATIVE_ZERO = /^-0(?:\.0+)?$/

export type TelegramMessageSource = 'tdlib' | 'telegram-tt'

export type ParsedTelegramMessageKey = {
  chatId: string
} & ({
  kind: 'server'
  serverMessageId: string
} | {
  kind: 'temporary'
  source: TelegramMessageSource
  localMessageId: string
})

type NumericId = string | number | bigint

function numericText(value: NumericId, label: string): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
    return String(value)
  }
  if (value.trim() !== value || value === '') throw new Error(`${label} must be canonical decimal`)
  return value
}

function normalizedInteger(value: NumericId, label: string): { text: string; value: bigint } {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`)
  }
  const text = numericText(value, label)
  if (!CANONICAL_INTEGER.test(text)) throw new Error(`${label} must be an integer`)
  const parsed = BigInt(text)
  const normalized = parsed.toString()
  if (text !== normalized) throw new Error(`${label} must be canonical decimal`)
  return { text: normalized, value: parsed }
}

export function normalizeTelegramChatId(chatId: NumericId): string {
  const parsed = normalizedInteger(chatId, 'Telegram chat id')
  if (parsed.value === 0n
    || parsed.value < TELEGRAM_CHAT_ID_MIN
    || parsed.value > TELEGRAM_CHAT_ID_MAX) {
    throw new Error('Telegram chat id is out of range')
  }
  return parsed.text
}

function normalizeTelegramServerMessageId(serverMessageId: NumericId): string {
  const parsed = normalizedInteger(serverMessageId, 'Telegram server message id')
  if (parsed.value <= 0n || parsed.value > TELEGRAM_SERVER_MESSAGE_ID_MAX) {
    throw new Error('Telegram server message id is out of range')
  }
  return parsed.text
}

function normalizeLocalMessageId(localMessageId: NumericId, label: string): string {
  const text = numericText(localMessageId, label)
  if (!CANONICAL_LOCAL_ID.test(text) || NEGATIVE_ZERO.test(text)) {
    throw new Error(`${label} must be a canonical decimal id`)
  }
  return text
}

export function telegramServerMessageKey(chatId: NumericId, serverMessageId: NumericId): string {
  return `${normalizeTelegramChatId(chatId)}:${normalizeTelegramServerMessageId(serverMessageId)}`
}

export function telegramTemporaryMessageKey(
  chatId: NumericId,
  source: TelegramMessageSource,
  localMessageId: NumericId,
): string {
  const id = normalizeLocalMessageId(localMessageId, `${source} local message id`)
  return `${normalizeTelegramChatId(chatId)}:temp:${source}:${id}`
}

/**
 * TDLib 把 MTProto 的 32-bit server message id 放在高位，低 20 位留给本地类型与排序。
 * 只有低 20 位全为 0 的正数才是已确认的服务器消息；其余值不能右移后冒充最终 id。
 */
export function telegramServerMessageIdFromTdlib(tdlibMessageId: NumericId): string | null {
  const parsed = normalizedInteger(tdlibMessageId, 'TDLib message id')
  if (parsed.value === 0n) throw new Error('TDLib message id must not be zero')
  if (parsed.value <= 0n || (parsed.value & TDLIB_LOCAL_BITS_MASK) !== 0n) return null
  return normalizeTelegramServerMessageId(parsed.value >> TDLIB_SERVER_ID_SHIFT)
}

export function telegramMessageKeyFromTdlib(chatId: NumericId, tdlibMessageId: NumericId): string {
  const serverMessageId = telegramServerMessageIdFromTdlib(tdlibMessageId)
  return serverMessageId === null
    ? telegramTemporaryMessageKey(chatId, 'tdlib', tdlibMessageId)
    : telegramServerMessageKey(chatId, serverMessageId)
}

export function telegramMessageKeyFromMtp(chatId: NumericId, mtpMessageId: NumericId): string {
  const text = normalizeLocalMessageId(mtpMessageId, 'MTProto message id')
  if (CANONICAL_INTEGER.test(text)) {
    const value = BigInt(text)
    if (value > TELEGRAM_SERVER_MESSAGE_ID_MAX) {
      throw new Error('MTProto message id is out of range')
    }
    if (value > 0n) return telegramServerMessageKey(chatId, text)
  }
  return telegramTemporaryMessageKey(chatId, 'telegram-tt', text)
}

export function parseTelegramMessageKey(messageKey: string): ParsedTelegramMessageKey | null {
  const parts = messageKey.split(':')
  try {
    if (parts.length === 2) {
      const [rawChatId, rawMessageId] = parts
      if (rawChatId === undefined || rawMessageId === undefined) return null
      const chatId = normalizeTelegramChatId(rawChatId)
      const serverMessageId = normalizeTelegramServerMessageId(rawMessageId)
      if (`${chatId}:${serverMessageId}` !== messageKey) return null
      return { chatId, kind: 'server', serverMessageId }
    }

    if (parts.length === 4 && parts[1] === 'temp') {
      const [rawChatId, , rawSource, rawLocalMessageId] = parts
      if (rawChatId === undefined
        || (rawSource !== 'tdlib' && rawSource !== 'telegram-tt')
        || rawLocalMessageId === undefined) return null
      const chatId = normalizeTelegramChatId(rawChatId)
      const localMessageId = normalizeLocalMessageId(rawLocalMessageId, 'Telegram local message id')
      if (`${chatId}:temp:${rawSource}:${localMessageId}` !== messageKey) return null
      return { chatId, kind: 'temporary', source: rawSource, localMessageId }
    }
  } catch {
    return null
  }
  return null
}

export function isTelegramMessageKeyForChat(messageKey: string, chatId: NumericId): boolean {
  const parsed = parseTelegramMessageKey(messageKey)
  if (!parsed) return false
  try {
    return parsed.chatId === normalizeTelegramChatId(chatId)
  } catch {
    return false
  }
}
