import { z } from 'zod'
import type { WhatsAppMessageStatus } from '../db/types.js'

const id = z.string().min(1).max(512)
// 先保留为有界字符串，再逐事件解析；单条坏时间不能让同批其他合法消息整体丢失。
const timestamp = z.string().min(1).max(32)
const error = z.object({ code: z.union([z.string(), z.number()]) }).passthrough()
const contact = z.object({
  wa_id: id,
  profile: z.object({ name: z.string().min(1).max(256) }).optional(),
}).passthrough()
const message = z.object({
  id,
  from: id,
  timestamp,
  type: z.string().min(1).max(64),
  text: z.object({ body: z.string().max(4096) }).optional(),
  context: z.object({ id }).optional(),
}).passthrough()
const status = z.object({
  id,
  // Meta 未来新增状态时不能让同批合法消息整体 400；解析后只接收本版本认识的值。
  status: z.string().min(1).max(64),
  timestamp,
  errors: z.array(error).optional(),
}).passthrough()
const value = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: id }).passthrough(),
  contacts: z.array(contact).optional(),
  messages: z.array(message).optional(),
  statuses: z.array(status).optional(),
}).passthrough()
const payload = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    id,
    changes: z.array(z.object({ field: z.literal('messages'), value }).passthrough()),
  }).passthrough()),
}).passthrough()

export interface WhatsAppInboundTextEvent {
  wabaId: string
  phoneNumberId: string
  platformMessageId: string
  senderExternalId: string
  senderDisplayName: string | null
  body: string
  replyToPlatformMessageId: string | null
  sentAt: Date
}

export interface WhatsAppStatusEvent {
  wabaId: string
  phoneNumberId: string
  platformMessageId: string
  status: Exclude<WhatsAppMessageStatus, 'accepted'>
  statusAt: Date
  errorCode: string | null
}

export interface ParsedWhatsAppWebhook {
  inboundTexts: WhatsAppInboundTextEvent[]
  statuses: WhatsAppStatusEvent[]
  unsupportedMessageCount: number
}

function epochSeconds(value: string): Date | null {
  const milliseconds = Number(value) * 1000
  if (!Number.isSafeInteger(milliseconds)) return null
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date
}

function knownStatus(value: string): WhatsAppStatusEvent['status'] | null {
  switch (value) {
    case 'sent': return 'sent'
    case 'delivered': return 'delivered'
    case 'read': return 'read'
    case 'failed': return 'failed'
    case 'deleted': return 'deleted'
    default: return null
  }
}

export function parseWhatsAppWebhook(input: unknown): ParsedWhatsAppWebhook | null {
  const parsed = payload.safeParse(input)
  if (!parsed.success) return null

  const inboundTexts: WhatsAppInboundTextEvent[] = []
  const statuses: WhatsAppStatusEvent[] = []
  let unsupportedMessageCount = 0

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const names = new Map(
        (change.value.contacts ?? []).map(item => [item.wa_id, item.profile?.name ?? null]),
      )
      for (const item of change.value.messages ?? []) {
        const sentAt = epochSeconds(item.timestamp)
        if (item.type !== 'text' || item.text === undefined || sentAt === null) {
          unsupportedMessageCount++
          continue
        }
        inboundTexts.push({
          wabaId: entry.id,
          phoneNumberId: change.value.metadata.phone_number_id,
          platformMessageId: item.id,
          senderExternalId: item.from,
          senderDisplayName: names.get(item.from) ?? null,
          body: item.text.body,
          replyToPlatformMessageId: item.context?.id ?? null,
          sentAt,
        })
      }
      for (const item of change.value.statuses ?? []) {
        const statusAt = epochSeconds(item.timestamp)
        const recognized = knownStatus(item.status)
        if (statusAt === null || recognized === null) continue
        statuses.push({
          wabaId: entry.id,
          phoneNumberId: change.value.metadata.phone_number_id,
          platformMessageId: item.id,
          status: recognized,
          statusAt,
          errorCode: item.errors?.[0] ? String(item.errors[0].code) : null,
        })
      }
    }
  }

  return { inboundTexts, statuses, unsupportedMessageCount }
}
