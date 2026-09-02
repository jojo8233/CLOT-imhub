import type { NormalizedMessage } from '@im-hub/shared'
import {
  normalizeSignalPersonId,
  signalDirectConversationId,
  signalGroupConversationId,
  signalMessageKey,
} from '@im-hub/shared'

/**
 * signal-cli 的 receive 通知归一化。
 *
 * 与 Telegram 不同的两点，理解了才看得懂下面的分支：
 *
 * 1. **我们是被关联的次要设备**。员工在手机上发的消息不会以"发出"的形式到达，
 *    而是作为 syncMessage.sentMessage 同步过来。不处理它，员工在手机上回的话
 *    在这边就完全看不见，会话看起来只有客户单方面在说。
 *
 * 2. **Signal 没有服务端消息 id**。全网通用的身份是 (发送者, timestamp)，
 *    所以这里把两者拼起来当 platformMessageId，去重约束才有东西可比。
 */

interface SignalAttachment {
  id?: string
  contentType?: string
  filename?: string
  size?: number
}

interface SignalGroupInfo {
  groupId?: string
}

interface SignalDataMessage {
  timestamp?: number
  message?: string | null
  attachments?: SignalAttachment[]
  groupInfo?: SignalGroupInfo | null
}

interface SignalSentMessage extends SignalDataMessage {
  destination?: string | null
  destinationNumber?: string | null
  destinationUuid?: string | null
}

interface SignalEnvelope {
  source?: string
  sourceNumber?: string | null
  sourceUuid?: string | null
  sourceName?: string | null
  timestamp?: number
  dataMessage?: SignalDataMessage | null
  syncMessage?: { sentMessage?: SignalSentMessage | null } | null
}

export interface SignalReceiveParams {
  account?: string
  envelope?: SignalEnvelope
}

/**
 * 会话标识加前缀区分单聊和群。
 *
 * 发送时两者要走完全不同的参数（recipient vs groupId），而 Signal 的群 id 是
 * 一串 base64，跟号码/UUID 没有形状上的差别，光看字符串认不出来。不加前缀的话
 * 发消息时只能靠猜，猜错就发到别人那儿去了。
 */
export const DIRECT_PREFIX = 'u:'
export const GROUP_PREFIX = 'g:'

export function directConversationId(recipient: string): string {
  return signalDirectConversationId(recipient)
}

export function groupConversationId(groupId: string): string {
  return signalGroupConversationId(groupId)
}

/** UUID 比号码稳定：Signal 允许隐藏手机号，号码可能缺失或改变，UUID 不会。 */
function personId(uuid: string | null | undefined, number: string | null | undefined, fallback?: string): string | null {
  const id = uuid ?? number ?? fallback ?? null
  if (id === null || id === '') return null
  try {
    return normalizeSignalPersonId(id)
  } catch {
    return null
  }
}

function mediaOf(attachments: SignalAttachment[] | undefined): NormalizedMessage['mediaRefs'] {
  // P1 只记下有附件这件事，不下载。没有 id 的附件跳过——没有 id 就没法回源取。
  return (attachments ?? []).flatMap((a) => {
    if (!a.id) return []
    const type = a.contentType ?? ''
    const kind = type.startsWith('image/') ? 'image'
      : type.startsWith('video/') ? 'video'
        : type.startsWith('audio/') ? 'audio'
          : 'file'
    return [{
      kind: kind as 'image' | 'video' | 'audio' | 'file',
      remoteId: a.id,
      ...(a.filename ? { fileName: a.filename } : {}),
      ...(a.contentType ? { mimeType: a.contentType } : {}),
      ...(a.size !== undefined ? { sizeBytes: a.size } : {}),
    }]
  })
}

/**
 * 任何看不懂的结构一律返回 null 交给调用方跳过，绝不抛错——这个函数跑在
 * signal-cli 的输出流处理里，抛出去会打断整条事件流，而一条不认识的通知
 * 不该让整个账号掉线。
 */
export function normalizeSignalMessage(
  params: unknown,
  accountId: string,
  /** 群 id → 群名。私聊传不传都行，只在群消息里用得上 */
  resolveGroupName?: (groupId: string) => string | undefined,
): NormalizedMessage | null {
  if (typeof params !== 'object' || params === null) return null
  const { envelope } = params as SignalReceiveParams
  if (!envelope) return null

  const senderExternalId = personId(envelope.sourceUuid, envelope.sourceNumber, envelope.source)
  if (senderExternalId === null) return null

  const sent = envelope.syncMessage?.sentMessage
  const data = envelope.dataMessage

  // 自己在别的设备上发的：同步过来的才是我们这边唯一的出站记录来源
  if (sent) {
    // 发送者一律取 params.account（本账号的号码），不取 envelope 里的 source。
    //
    // 因为 platformMessageId 是「发送者:timestamp」，而我们自己发出去时
    // sendMessage() 拼的也是号码；如果这里用了 envelope.sourceUuid，同一条消息
    // 两条路径会算出两个不同的 id，(account_id, platform_message_id) 去重就认不出
    // 它们是同一条，于是存成两行。
    const self = (params as SignalReceiveParams).account ?? senderExternalId
    const body = sent.message ?? ''
    const groupId = sent.groupInfo?.groupId
    const target = personId(sent.destinationUuid, sent.destinationNumber, sent.destination ?? undefined)
    // 既不是群、又没有收件人，说不出这条属于哪个会话，只能丢
    if (!groupId && target === null) return null
    const timestamp = sent.timestamp ?? envelope.timestamp
    if (timestamp === undefined) return null
    if (body === '' && (sent.attachments ?? []).length === 0) return null

    return {
      platform: 'signal',
      accountId,
      platformConversationId: groupId ? groupConversationId(groupId) : directConversationId(target!),
      platformMessageId: signalMessageKey(self, timestamp),
      direction: 'out',
      senderExternalId: self,
      senderDisplayName: envelope.sourceName ?? null,
      // 群会话名用群名；私聊我方发出的消息不带对方名，会话名保持不动（null）
      conversationDisplayName: groupId ? (resolveGroupName?.(groupId) ?? null) : null,
      body,
      mediaRefs: mediaOf(sent.attachments),
      sentAt: new Date(timestamp),
      raw: params,
    }
  }

  if (data) {
    const body = data.message ?? ''
    const groupId = data.groupInfo?.groupId
    const timestamp = data.timestamp ?? envelope.timestamp
    if (timestamp === undefined) return null
    // 纯回执、纯表情回应、输入状态都会带一个空的 dataMessage，没有正文也没有附件
    if (body === '' && (data.attachments ?? []).length === 0) return null

    return {
      platform: 'signal',
      accountId,
      platformConversationId: groupId ? groupConversationId(groupId) : directConversationId(senderExternalId),
      platformMessageId: signalMessageKey(senderExternalId, timestamp),
      direction: 'in',
      senderExternalId,
      senderDisplayName: envelope.sourceName ?? null,
      // 群会话名用群名；私聊会话名就是对方（发言人）的名字
      conversationDisplayName: groupId
        ? (resolveGroupName?.(groupId) ?? null)
        : (envelope.sourceName ?? null),
      body,
      mediaRefs: mediaOf(data.attachments),
      sentAt: new Date(timestamp),
      raw: params,
    }
  }

  // receiptMessage / typingMessage / 没有 sentMessage 的 syncMessage 都走到这里
  return null
}
