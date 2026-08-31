import { normalizeWhatsAppWebUserId } from '@im-hub/shared'

export function normalizeWhatsAppStorageIdentity(raw: string): string | null {
  const candidates: string[] = [raw]
  let parsed: unknown = raw
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      parsed = JSON.parse(typeof parsed === 'string' ? parsed : JSON.stringify(parsed)) as unknown
    } catch {
      break
    }
    if (typeof parsed === 'string') candidates.push(parsed)
    if (record(parsed)) {
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string') candidates.push(value)
      }
    }
  }
  for (const candidate of candidates) {
    const match = /([0-9]{5,20}(?::[0-9]{1,5})?@(c\.us|s\.whatsapp\.net|lid))/i.exec(candidate)
    if (!match?.[1]) continue
    try {
      return normalizeWhatsAppWebUserId(match[1])
    } catch {
      // 继续尝试下一个页面状态表示。
    }
  }
  return null
}

export function whatsappChatJidFromDataId(raw: string): string | null {
  const match = /([0-9]{5,20})(?::[0-9]{1,5})?@(c\.us|g\.us|lid)/i.exec(raw)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}@${match[2].toLowerCase()}`
}

export function normalizeWhatsAppDomText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim()
}

export function isChineseLanguage(value: string | undefined): boolean {
  return value?.toLowerCase() === 'zh' || value?.toLowerCase().startsWith('zh-') === true
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
