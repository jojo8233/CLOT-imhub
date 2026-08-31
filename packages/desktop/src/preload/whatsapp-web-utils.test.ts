import { describe, expect, it } from 'vitest'
import {
  isChineseLanguage,
  normalizeWhatsAppDomText,
  normalizeWhatsAppStorageIdentity,
  whatsappChatJidFromDataId,
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

  it('规范页面文本并按 provider 语言结果选择中英目标', () => {
    expect(normalizeWhatsAppDomText('  hello\u00a0world\r\n')).toBe('hello world')
    expect(isChineseLanguage('zh')).toBe(true)
    expect(isChineseLanguage('zh-CN')).toBe(true)
    expect(isChineseLanguage('ja')).toBe(false)
  })
})
