import { describe, expect, it } from 'vitest'
import {
  KEYWORD_ALERT_PAGE_DEFAULT_LIMIT,
  KEYWORD_ALERT_PAGE_MAX_LIMIT,
  KEYWORD_RULE_PATTERN_MAX_CODE_POINTS,
  KEYWORD_ALERT_SEVERITIES,
  type KeywordAlertListPage,
  type KeywordAlertSearchRequest,
  type KeywordRuleCreate,
  type KeywordRuleUpdate,
} from './keyword-alert.js'
import type { WsServerEvent } from './ws.js'

describe('keyword alert contracts', () => {
  it('fixes limits, severities, request shapes, and the body-free websocket hint', () => {
    expect(KEYWORD_RULE_PATTERN_MAX_CODE_POINTS).toBe(100)
    expect(KEYWORD_ALERT_PAGE_DEFAULT_LIMIT).toBe(50)
    expect(KEYWORD_ALERT_PAGE_MAX_LIMIT).toBe(100)
    expect(KEYWORD_ALERT_SEVERITIES).toEqual(['normal', 'important', 'urgent'])

    const create: KeywordRuleCreate = {
      pattern: 'Synthetic literal', severity: 'important', enabled: true,
    }
    const update: KeywordRuleUpdate = { baseRevision: 1, enabled: false }
    const search: KeywordAlertSearchRequest = {
      status: 'pending', severity: 'urgent', platform: 'telegram', limit: 50,
    }
    const page: KeywordAlertListPage = { items: [], nextCursor: null }
    const event: WsServerEvent = {
      type: 'keyword_alert',
      alertId: '00000000-0000-4000-8000-000000000001',
      severity: 'urgent',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T00:00:00.000Z',
    }

    expect({ create, update, search, page, event }).toBeDefined()
    expect(event).not.toHaveProperty('body')
    expect(event).not.toHaveProperty('pattern')
  })
})
