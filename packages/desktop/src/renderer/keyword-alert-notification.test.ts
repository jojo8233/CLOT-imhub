import { describe, expect, it } from 'vitest'
import { keywordAlertNotification } from './keyword-alert-notification.js'

describe('keywordAlertNotification', () => {
  it('returns only a generic severity message for a private keyword alert', () => {
    const event = {
      type: 'keyword_alert',
      alertId: 'alert-private',
      severity: 'urgent',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T00:00:00.000Z',
      pattern: 'PRIVATE_PATTERN',
      body: 'PRIVATE_MESSAGE_BODY',
      excerpt: 'PRIVATE_EXCERPT',
    } as const

    const notification = keywordAlertNotification(event)

    expect(notification).toEqual({
      message: '收到一条紧急关键词告警',
      refreshCount: true,
    })
    expect(JSON.stringify(notification)).not.toContain(event.pattern)
    expect(JSON.stringify(notification)).not.toContain(event.body)
    expect(JSON.stringify(notification)).not.toContain(event.excerpt)
    expect(JSON.stringify(notification)).not.toContain(event.alertId)
  })

  it('refreshes the count only for recipients who require acknowledgement', () => {
    expect(keywordAlertNotification({
      type: 'keyword_alert',
      alertId: 'alert-read-only',
      severity: 'normal',
      requiresAcknowledgement: false,
      createdAt: '2026-09-03T00:00:00.000Z',
    })).toEqual({
      message: '收到一条普通关键词告警',
      refreshCount: false,
    })
  })
})
