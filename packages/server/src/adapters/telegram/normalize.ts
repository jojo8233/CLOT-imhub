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

  const m = u.message
  if (m.content?._ !== 'messageText' || !m.content.text) return null
  if (!m.sender_id) return null

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
    raw: update,
  }
}
