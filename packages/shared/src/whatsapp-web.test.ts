import { describe, expect, it } from 'vitest'
import { normalizeWhatsAppWebUserId } from './whatsapp-web.js'

describe('normalizeWhatsAppWebUserId', () => {
  it('移除多设备后缀并规范网页用户域名', () => {
    expect(normalizeWhatsAppWebUserId('123456789:17@c.us')).toBe('123456789@c.us')
    expect(normalizeWhatsAppWebUserId('123456789@s.whatsapp.net')).toBe('123456789@c.us')
    expect(normalizeWhatsAppWebUserId('123456789@lid')).toBe('123456789@lid')
  })

  it('拒绝群组、短值和任意网页字符串', () => {
    expect(() => normalizeWhatsAppWebUserId('123456789@g.us')).toThrow()
    expect(() => normalizeWhatsAppWebUserId('123@c.us')).toThrow()
    expect(() => normalizeWhatsAppWebUserId('not-an-account')).toThrow()
  })
})
