import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  verifyWhatsAppChallengeToken,
  verifyWhatsAppWebhookSignature,
} from './signature.js'

describe('WhatsApp webhook authenticity', () => {
  it('只接受原始请求字节对应的 sha256 签名', () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account","entry":[]}', 'utf8')
    const secret = 'test-app-secret'
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

    expect(verifyWhatsAppWebhookSignature(raw, signature, secret)).toBe(true)
    expect(verifyWhatsAppWebhookSignature(Buffer.from('{}'), signature, secret)).toBe(false)
    expect(verifyWhatsAppWebhookSignature(raw, undefined, secret)).toBe(false)
    expect(verifyWhatsAppWebhookSignature(raw, 'sha256=short', secret)).toBe(false)
  })

  it('challenge token 缺失或不一致时拒绝', () => {
    expect(verifyWhatsAppChallengeToken('same-token', 'same-token')).toBe(true)
    expect(verifyWhatsAppChallengeToken('wrong', 'same-token')).toBe(false)
    expect(verifyWhatsAppChallengeToken('', '')).toBe(false)
  })
})
