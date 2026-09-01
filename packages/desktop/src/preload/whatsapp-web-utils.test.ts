import { describe, expect, it } from 'vitest'
import {
  normalizeWhatsAppDomText,
  normalizeWhatsAppStorageIdentity,
  sameWhatsAppConversation,
  shouldResetWhatsAppTranslations,
  whatsappChatJidFromDataId,
  whatsappMessageDirectionFromDataId,
} from './whatsapp-web-utils.js'

describe('WhatsApp Web patch helpers', () => {
  it('从网页本地状态的多种包装中提取并规范当前账号', () => {
    expect(normalizeWhatsAppStorageIdentity('"123456789:4@c.us"')).toBe('123456789@c.us')
    expect(normalizeWhatsAppStorageIdentity('{"_serialized":"123456789@s.whatsapp.net"}'))
      .toBe('123456789@c.us')
    expect(normalizeWhatsAppStorageIdentity('not-an-identity')).toBeNull()
  })

  it('从消息 data-id 中提取私聊、群聊和 LID 会话', () => {
    expect(whatsappChatJidFromDataId('false_123456789@c.us_MESSAGE')).toBe('123456789@c.us')
    expect(whatsappChatJidFromDataId('true_123456789@g.us_MESSAGE')).toBe('123456789@g.us')
    expect(whatsappChatJidFromDataId('false_123456789:7@lid_MESSAGE')).toBe('123456789@lid')
    expect(whatsappChatJidFromDataId('unrelated')).toBeNull()
  })

  it('只按 WhatsApp data-id 自身的 from-me 前缀判断消息方向', () => {
    expect(whatsappMessageDirectionFromDataId('true_123456789@c.us_MESSAGE')).toBe('out')
    expect(whatsappMessageDirectionFromDataId('false_123456789@c.us_MESSAGE')).toBe('in')
    expect(whatsappMessageDirectionFromDataId('123456789@c.us_MESSAGE')).toBeNull()
    expect(whatsappMessageDirectionFromDataId(null)).toBeNull()
  })

  it('规范页面文本', () => {
    expect(normalizeWhatsAppDomText('  hello\u00a0world\r\n')).toBe('hello world')
  })

  it('显示名变化不等于切换 WhatsApp 会话', () => {
    const current = {
      platformConversationId: 'wa:123456789@c.us',
      contactExternalId: '123456789@c.us',
      contactDisplayName: 'Customer',
    }

    expect(sameWhatsAppConversation(current, {
      ...current,
      contactDisplayName: 'Customer · online',
    })).toBe(true)
    expect(sameWhatsAppConversation(current, {
      ...current,
      platformConversationId: 'wa:987654321@c.us',
      contactExternalId: '987654321@c.us',
    })).toBe(false)
    expect(sameWhatsAppConversation(current, null)).toBe(false)
  })

  it('只有真实会话边界才重置 WhatsApp 译文', () => {
    const current = {
      platformConversationId: 'wa:first@c.us',
      contactExternalId: 'first@c.us',
      contactDisplayName: 'First',
    }
    expect(shouldResetWhatsAppTranslations(current, {
      ...current,
      contactDisplayName: 'First · online',
    })).toBe(false)
    expect(shouldResetWhatsAppTranslations(current, {
      ...current,
      platformConversationId: 'wa:second@c.us',
    })).toBe(true)
    expect(shouldResetWhatsAppTranslations(current, null)).toBe(true)
    expect(shouldResetWhatsAppTranslations(null, current)).toBe(true)
  })
})
