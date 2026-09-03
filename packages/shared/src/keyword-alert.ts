import type { Platform } from './platform.js'

export const KEYWORD_RULE_PATTERN_MAX_CODE_POINTS = 100
export const KEYWORD_ALERT_PAGE_DEFAULT_LIMIT = 50
export const KEYWORD_ALERT_PAGE_MAX_LIMIT = 100
export const KEYWORD_ALERT_SEVERITIES = ['normal', 'important', 'urgent'] as const
export type KeywordAlertSeverity = (typeof KEYWORD_ALERT_SEVERITIES)[number]
export type KeywordAlertStatusFilter = 'pending' | 'acknowledged' | 'all'

export interface KeywordRule {
  id: string
  pattern: string
  severity: KeywordAlertSeverity
  enabled: boolean
  revision: number
  effectiveAt: string
  createdAt: string
  updatedAt: string
}

export interface KeywordRuleCreate {
  pattern: string
  severity: KeywordAlertSeverity
  enabled: boolean
}

export interface KeywordRuleUpdate {
  baseRevision: number
  pattern?: string
  severity?: KeywordAlertSeverity
  enabled?: boolean
}

export interface KeywordRuleListResponse {
  rules: KeywordRule[]
  degradedScanCount: number
}

export interface KeywordAlertSearchRequest {
  status: KeywordAlertStatusFilter
  severity?: KeywordAlertSeverity
  platform?: Platform
  accountId?: string
  limit?: number
  cursor?: string
}

export interface KeywordAlertListItem {
  alertId: string
  messageId: string
  conversationId: string
  accountId: string
  platform: Platform
  severity: KeywordAlertSeverity
  pattern: string
  accountDisplayName: string
  conversationDisplayName: string | null
  excerpt: string | null
  matchedAt: string
  messageChangedAfterMatch: boolean
  messageDeleted: boolean
  requiresAcknowledgement: boolean
  acknowledgedAt: string | null
}

export interface KeywordAlertListPage {
  items: KeywordAlertListItem[]
  nextCursor: string | null
}

export interface KeywordAlertUnacknowledgedCount {
  count: number
}
