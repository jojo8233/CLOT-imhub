import { telegramMessageKeyFromTdlib, type NormalizedMessage } from '@im-hub/shared'

interface TdSenderUser { _: 'messageSenderUser'; user_id: number }
interface TdSenderChat { _: 'messageSenderChat'; chat_id: number }
type TdSender = TdSenderUser | TdSenderChat

interface TdMessage {
  id: number
  sender_id: TdSender
  chat_id: number
  is_outgoing: boolean
  date: number
  edit_date?: number
  content: { _: string; text?: { text: string } }
}

function senderId(sender: TdSender): string | null {
  if (sender._ === 'messageSenderUser') return String(sender.user_id)
  if (sender._ === 'messageSenderChat') return String(sender.chat_id)
  // TDLib 加了新的 sender 类型。宁可丢这条消息，也不要把 'undefined' 当成发送者写进库。
  return null
}

/**
 * 把 TDLib 的 updateNewMessage 转成统一消息形状。
 *
 * P0 只处理纯文本，其余内容类型返回 null 由调用方跳过，媒体消息在 P3 补。
 * 任何结构不符都返回 null 而不是抛错——这个函数跑在 TDLib 的 update 回调里，
 * 抛出去会打断整条事件流，而一条看不懂的 update 不该让整个账号掉线。
 */
export function normalizeTelegramMessage(update: unknown, accountId: string): NormalizedMessage | null {
  if (typeof update !== 'object' || update === null) return null
  const u = update as { _?: string; message?: TdMessage }
  if (u._ !== 'updateNewMessage' || !u.message) return null

  return normalizeTelegramStoredMessage(u.message, accountId, update)
}

/**
 * 规范化 TDLib 返回的完整 message。
 *
 * 编辑正文由 updateMessageContent 单独通知，那个 update 不带 sender/date 等完整
 * 身份字段；适配器会用 getMessage 取快照后进入这里。TDLib 只暴露 edit_date，
 * 不伪造 telegram-tt 的 MTProto pts，因此 editVersion 明确保持 null。
 */
export function normalizeTelegramStoredMessage(
  message: unknown,
  accountId: string,
  raw: unknown = message,
): NormalizedMessage | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as TdMessage

  if (m.content?._ !== 'messageText' || !m.content.text) return null
  if (!m.sender_id) return null
  if (!Number.isSafeInteger(m.chat_id) || !Number.isSafeInteger(m.id)) return null
  if (!Number.isSafeInteger(m.date) || typeof m.is_outgoing !== 'boolean') return null

  const sender = senderId(m.sender_id)
  if (sender === null) return null

  let platformMessageId: string
  try {
    platformMessageId = telegramMessageKeyFromTdlib(m.chat_id, m.id)
  } catch {
    return null
  }

  return {
    platform: 'telegram',
    accountId,
    platformConversationId: String(m.chat_id),
    platformMessageId,
    direction: m.is_outgoing ? 'out' : 'in',
    senderExternalId: sender,
    senderDisplayName: null,
    // Telegram 的群名/联系人名解析后续单独做，现在先按会话 id 显示
    conversationDisplayName: null,
    body: m.content.text.text,
    mediaRefs: [],
    sentAt: new Date(m.date * 1000),
    editedAt: Number.isSafeInteger(m.edit_date) && (m.edit_date ?? 0) > 0
      ? new Date((m.edit_date ?? 0) * 1000)
      : null,
    editVersion: null,
    raw,
  }
}
