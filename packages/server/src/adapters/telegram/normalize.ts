import {
  telegramMessageKeyFromTdlib,
  type MediaRef,
  type NormalizedMessage,
} from '@im-hub/shared'

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
  reply_to?: {
    _?: string
    chat_id?: number
    message_id?: number
  }
  content: TdMessageContent
}

interface TdFile {
  id?: number
  size?: number
  expected_size?: number
  remote?: { id?: string; unique_id?: string }
}

interface TdMessageContent {
  _: string
  text?: { text?: string }
  caption?: { text?: string }
  photo?: { sizes?: Array<{ photo?: TdFile }> }
  video?: { file_name?: string; mime_type?: string; video?: TdFile }
  audio?: { file_name?: string; mime_type?: string; audio?: TdFile }
  voice_note?: { mime_type?: string; voice?: TdFile }
  document?: { file_name?: string; mime_type?: string; document?: TdFile }
  sticker?: { sticker?: TdFile }
  video_note?: { video?: TdFile }
  animation?: { file_name?: string; mime_type?: string; animation?: TdFile }
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

  if (!m.content || typeof m.content._ !== 'string') return null
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

  const normalizedContent = normalizeContent(m.content)
  if (!normalizedContent) return null

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
    body: normalizedContent.body,
    mediaRefs: normalizedContent.mediaRefs,
    replyToPlatformMessageId: normalizeReplyToMessageId(m),
    sentAt: new Date(m.date * 1000),
    editedAt: Number.isSafeInteger(m.edit_date) && (m.edit_date ?? 0) > 0
      ? new Date((m.edit_date ?? 0) * 1000)
      : null,
    editVersion: null,
    raw,
  }
}

function normalizeContent(
  content: TdMessageContent,
): { body: string; mediaRefs: MediaRef[] } | null {
  switch (content._) {
    case 'messageText': {
      const body = formattedText(content.text)
      return body === null ? null : { body, mediaRefs: [] }
    }
    case 'messagePhoto': {
      const file = largestPhotoFile(content.photo?.sizes)
      const media = file ? buildMediaRef('image', file) : null
      return media
        ? { body: caption(content), mediaRefs: [minimalMediaRef(media)] }
        : null
    }
    case 'messageVideo': {
      const media = buildMediaRef('video', content.video?.video, {
        fileName: content.video?.file_name,
        mimeType: content.video?.mime_type,
      })
      return media ? { body: caption(content), mediaRefs: [media] } : null
    }
    case 'messageAudio': {
      const media = buildMediaRef('audio', content.audio?.audio, {
        fileName: content.audio?.file_name,
        mimeType: content.audio?.mime_type,
      })
      return media ? { body: caption(content), mediaRefs: [media] } : null
    }
    case 'messageVoiceNote': {
      const media = buildMediaRef('audio', content.voice_note?.voice, {
        // telegram-tt 的 ApiVoice 不保留 MTProto mime，outbox 固定使用 audio/ogg。
        mimeType: 'audio/ogg',
      })
      return media ? { body: caption(content), mediaRefs: [media] } : null
    }
    case 'messageDocument': {
      const media = buildMediaRef('file', content.document?.document, {
        fileName: content.document?.file_name,
        mimeType: content.document?.mime_type,
      })
      return media ? { body: caption(content), mediaRefs: [media] } : null
    }
    case 'messageSticker': {
      const media = buildMediaRef('sticker', content.sticker?.sticker)
      return media
        ? { body: '', mediaRefs: [minimalMediaRef(media)] }
        : null
    }
    case 'messageVideoNote': {
      const media = buildMediaRef('video', content.video_note?.video, {
        mimeType: 'video/mp4',
      })
      return media ? { body: '', mediaRefs: [media] } : null
    }
    case 'messageAnimation': {
      const media = buildMediaRef('video', content.animation?.animation, {
        fileName: content.animation?.file_name,
        mimeType: content.animation?.mime_type,
      })
      return media ? { body: caption(content), mediaRefs: [media] } : null
    }
    default:
      return null
  }
}

function formattedText(value: { text?: string } | undefined): string | null {
  return typeof value?.text === 'string' ? value.text : null
}

function caption(content: TdMessageContent): string {
  return formattedText(content.caption) ?? ''
}

function largestPhotoFile(sizes: Array<{ photo?: TdFile }> | undefined): TdFile | null {
  if (!sizes || sizes.length === 0) return null
  let largest: TdFile | null = null
  let largestSize = -1
  for (const size of sizes) {
    if (!size.photo) continue
    const bytes = normalizedSize(size.photo) ?? 0
    if (bytes >= largestSize) {
      largest = size.photo
      largestSize = bytes
    }
  }
  return largest
}

function buildMediaRef(
  kind: MediaRef['kind'],
  file: TdFile | undefined,
  metadata: { fileName?: string; mimeType?: string } = {},
): MediaRef | null {
  if (!file) return null
  const remoteId = nonempty(file.remote?.id)
    ?? nonempty(file.remote?.unique_id)
    ?? (Number.isSafeInteger(file.id) ? `tdlib-file:${file.id}` : null)
  if (!remoteId) return null

  const media: MediaRef = { kind, remoteId }
  const fileName = nonempty(metadata.fileName)
  const mimeType = nonempty(metadata.mimeType)
  const sizeBytes = normalizedSize(file)
  if (fileName) media.fileName = fileName
  if (mimeType) media.mimeType = mimeType
  if (sizeBytes !== null) media.sizeBytes = sizeBytes
  return media
}

function minimalMediaRef(media: MediaRef): MediaRef {
  return { kind: media.kind, remoteId: media.remoteId }
}

function normalizedSize(file: TdFile): number | null {
  if (Number.isSafeInteger(file.size) && (file.size ?? -1) >= 0) return file.size ?? null
  if (Number.isSafeInteger(file.expected_size) && (file.expected_size ?? -1) >= 0) {
    return file.expected_size ?? null
  }
  return null
}

function nonempty(value: string | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function normalizeReplyToMessageId(message: TdMessage): string | null {
  const reply = message.reply_to
  if (reply?._ !== 'messageReplyToMessage'
    || reply.chat_id !== message.chat_id
    || typeof reply.message_id !== 'number'
    || !Number.isSafeInteger(reply.message_id)) return null
  try {
    return telegramMessageKeyFromTdlib(message.chat_id, reply.message_id)
  } catch {
    return null
  }
}
