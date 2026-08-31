import { describe, expect, it } from 'vitest'
import { parseWhatsAppWebhook } from './webhook-payload.js'

describe('WhatsApp webhook payload', () => {
  it('只归一化官方 id 的纯文字入站和状态事件', () => {
    const result = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-test',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'phone-test' },
            contacts: [{ wa_id: 'customer-test', profile: { name: 'Customer' } }],
            messages: [
              {
                id: 'wamid.incoming', from: 'customer-test', timestamp: '1700000000',
                type: 'text', text: { body: 'hello' }, context: { id: 'wamid.reply' },
              },
              { id: 'wamid.image', from: 'customer-test', timestamp: '1700000001', type: 'image' },
            ],
            statuses: [{ id: 'wamid.outgoing', status: 'delivered', timestamp: '1700000002' }],
          },
        }],
      }],
    })

    expect(result).toEqual({
      inboundTexts: [{
        wabaId: 'waba-test', phoneNumberId: 'phone-test',
        platformMessageId: 'wamid.incoming', senderExternalId: 'customer-test',
        senderDisplayName: 'Customer', body: 'hello',
        replyToPlatformMessageId: 'wamid.reply', sentAt: new Date(1700000000000),
      }],
      statuses: [{
        wabaId: 'waba-test', phoneNumberId: 'phone-test',
        platformMessageId: 'wamid.outgoing', status: 'delivered',
        statusAt: new Date(1700000002000), errorCode: null,
      }],
      unsupportedMessageCount: 1,
    })
  })

  it('错误 object 或不合法时间戳不会制造半条消息', () => {
    expect(parseWhatsAppWebhook({ object: 'page', entry: [] })).toBeNull()
    const result = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'phone' },
        messages: [{ id: 'wamid.bad', from: 'sender', timestamp: 'not-time', type: 'text', text: { body: 'x' } }],
      } }] }],
    })
    expect(result).toMatchObject({ inboundTexts: [], unsupportedMessageCount: 1 })
  })

  it('未知的未来状态只跳过自身，不让同批合法状态整体失败', () => {
    const result = parseWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'phone' },
        statuses: [
          { id: 'wamid.future', status: 'future_status', timestamp: '1700000000' },
          { id: 'wamid.read', status: 'read', timestamp: '1700000001' },
        ],
      } }] }],
    })
    expect(result?.statuses).toEqual([expect.objectContaining({
      platformMessageId: 'wamid.read', status: 'read',
    })])
  })
})
