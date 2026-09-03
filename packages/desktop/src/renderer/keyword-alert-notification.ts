import type { WsKeywordAlertEvent } from '@im-hub/shared'

const SEVERITY_LABEL = {
  normal: '普通',
  important: '重要',
  urgent: '紧急',
} as const

export interface KeywordAlertNotification {
  message: string
  refreshCount: boolean
}

export function keywordAlertNotification(
  event: WsKeywordAlertEvent,
): KeywordAlertNotification {
  return {
    message: `收到一条${SEVERITY_LABEL[event.severity]}关键词告警`,
    refreshCount: event.requiresAcknowledgement,
  }
}
