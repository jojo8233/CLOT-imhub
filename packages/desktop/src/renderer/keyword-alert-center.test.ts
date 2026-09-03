import type {
  KeywordAlertListItem,
  KeywordAlertListPage,
  WsKeywordAlertEvent,
} from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  initialKeywordAlertCenterState,
  reduceKeywordAlertCenter,
  type KeywordAlertCenterState,
} from './keyword-alert-center.js'

function item(alertId: string, acknowledgedAt: string | null = null): KeywordAlertListItem {
  return {
    alertId,
    messageId: '00000000-0000-4000-8000-000000000011',
    conversationId: '00000000-0000-4000-8000-000000000012',
    accountId: '00000000-0000-4000-8000-000000000013',
    platform: 'telegram',
    severity: 'urgent',
    pattern: 'Synthetic',
    accountDisplayName: 'Synthetic Account',
    conversationDisplayName: 'Synthetic Conversation',
    excerpt: 'Synthetic message excerpt',
    matchedAt: '2026-09-03T00:00:00.000Z',
    messageChangedAfterMatch: false,
    messageDeleted: false,
    requiresAcknowledgement: true,
    acknowledgedAt,
  }
}

function page(
  items: KeywordAlertListItem[],
  nextCursor: string | null,
): KeywordAlertListPage {
  return { items, nextCursor }
}

function readyState(
  items: KeywordAlertListItem[],
  nextCursor: string | null = null,
): KeywordAlertCenterState {
  return {
    ...initialKeywordAlertCenterState(),
    items,
    nextCursor,
    hasLoaded: true,
  }
}

const firstAlert = item('00000000-0000-4000-8000-000000000101')
const secondAlert = item('00000000-0000-4000-8000-000000000102')

describe('keyword alert center state', () => {
  it('ignores stale replacement responses and does not alias the accepted page array', () => {
    let state = initialKeywordAlertCenterState()
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 1, mode: 'replace',
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 2, mode: 'replace',
    })

    const beforeStale = state
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 1,
      mode: 'replace',
      page: page([firstAlert], null),
    })
    expect(state).toBe(beforeStale)

    const acceptedItems = [secondAlert]
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 2,
      mode: 'replace',
      page: page(acceptedItems, null),
    })
    acceptedItems.push(firstAlert)
    expect(state.items).toEqual([secondAlert])
  })

  it('appends by alertId without replacing existing rows and preserves rows on append failure', () => {
    let state = readyState([firstAlert], 'cursor-2')
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 2, mode: 'append',
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 2,
      mode: 'append',
      page: page([{ ...firstAlert, pattern: 'Duplicate' }, secondAlert], null),
    })
    expect(state.items).toEqual([firstAlert, secondAlert])

    state = { ...state, nextCursor: 'cursor-3' }
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 3, mode: 'append',
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.failed',
      requestId: 3,
      mode: 'append',
      message: '关键词告警加载失败，请稍后重试',
    })
    expect(state.items).toEqual([firstAlert, secondAlert])
    expect(state.nextCursor).toBe('cursor-3')
    expect(state.appendError).toBe('关键词告警加载失败，请稍后重试')
  })

  it('filter changes clear old rows and invalidate the active request generation', () => {
    let state = readyState([firstAlert], 'cursor-2')
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 7, mode: 'replace',
    })
    state = reduceKeywordAlertCenter(state, { type: 'filters.changed' })
    expect(state).toMatchObject({
      items: [],
      nextCursor: null,
      activeLoad: null,
      hasLoaded: false,
    })

    const resetState = state
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 7,
      mode: 'replace',
      page: page([secondAlert], null),
    })
    expect(state).toBe(resetState)
  })

  it('ack.started marks exactly the requested current row busy', () => {
    const state = readyState([firstAlert, secondAlert])
    const next = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 1, alertId: secondAlert.alertId,
    })

    expect(next.acknowledgingAlertId).toBe(secondAlert.alertId)
    expect(next.acknowledgementRequestId).toBe(1)
    expect(next.items).toEqual([firstAlert, secondAlert])
    expect(state.acknowledgingAlertId).toBeNull()
  })

  it('ack.succeeded removes the row from a pending result', () => {
    let state = readyState([firstAlert])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 2, alertId: firstAlert.alertId,
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 2,
      alertId: firstAlert.alertId,
      acknowledgedAt: '2026-09-03T01:00:00.000Z',
    })

    expect(state.items).toEqual([])
    expect(state.acknowledgingAlertId).toBeNull()
    expect(state.ackError).toBeNull()
  })

  it('ack.succeeded keeps an all-result row and uses the authoritative server timestamp', () => {
    const original = firstAlert
    let state = readyState([original])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 3, alertId: original.alertId,
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 3,
      alertId: original.alertId,
      acknowledgedAt: '2026-09-03T01:00:00.000Z',
      status: 'all',
    })

    expect(state.items).toEqual([{
      ...original,
      acknowledgedAt: '2026-09-03T01:00:00.000Z',
    }])
    expect(original.acknowledgedAt).toBeNull()
    expect(state.acknowledgingAlertId).toBeNull()
  })

  it('ack.failed leaves acknowledgement unchanged and exposes a retryable row error', () => {
    let state = readyState([firstAlert])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 4, alertId: firstAlert.alertId,
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.failed',
      requestId: 4,
      alertId: firstAlert.alertId,
      message: '确认失败，请重试',
    })

    expect(state.items).toEqual([firstAlert])
    expect(state.items[0]?.acknowledgedAt).toBeNull()
    expect(state.acknowledgingAlertId).toBeNull()
    expect(state.ackError).toEqual({
      alertId: firstAlert.alertId,
      message: '确认失败，请重试',
    })
  })

  it('ignores an old failure after filters reload the same alert into a newer acknowledgement', () => {
    let state = readyState([firstAlert])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 10, alertId: firstAlert.alertId,
    })
    state = reduceKeywordAlertCenter(state, { type: 'filters.changed' })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 11, mode: 'replace',
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 11,
      mode: 'replace',
      page: page([firstAlert], null),
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 12, alertId: firstAlert.alertId,
    })

    const beforeOldFailure = state
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.failed',
      requestId: 10,
      alertId: firstAlert.alertId,
      message: '旧请求失败',
    })
    expect(state).toBe(beforeOldFailure)
    expect(state.acknowledgingAlertId).toBe(firstAlert.alertId)
    expect(state.acknowledgementRequestId).toBe(12)
    expect(state.ackError).toBeNull()

    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 12,
      alertId: firstAlert.alertId,
      acknowledgedAt: '2026-09-03T02:00:00.000Z',
    })
    expect(state.items).toEqual([])
    expect(state.acknowledgingAlertId).toBeNull()
    expect(state.acknowledgementRequestId).toBeNull()
    expect(state.ackError).toBeNull()
  })

  it('ignores an old success after a newer acknowledgement starts for the same alert', () => {
    let state = readyState([firstAlert])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 20, alertId: firstAlert.alertId,
    })
    state = reduceKeywordAlertCenter(state, { type: 'filters.changed' })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.started', requestId: 21, mode: 'replace',
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'load.succeeded',
      requestId: 21,
      mode: 'replace',
      page: page([firstAlert], null),
    })
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 22, alertId: firstAlert.alertId,
    })

    const beforeOldSuccess = state
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 20,
      alertId: firstAlert.alertId,
      acknowledgedAt: '2026-09-03T02:10:00.000Z',
      status: 'all',
    })
    expect(state).toBe(beforeOldSuccess)
    expect(state.items[0]?.acknowledgedAt).toBeNull()
    expect(state.acknowledgementRequestId).toBe(22)

    state = reduceKeywordAlertCenter(state, {
      type: 'ack.failed',
      requestId: 22,
      alertId: firstAlert.alertId,
      message: '新请求失败',
    })
    expect(state.items[0]?.acknowledgedAt).toBeNull()
    expect(state.acknowledgingAlertId).toBeNull()
    expect(state.acknowledgementRequestId).toBeNull()
    expect(state.ackError).toEqual({
      alertId: firstAlert.alertId,
      message: '新请求失败',
    })
  })

  it('keeps one busy alert and ignores a blocked acknowledgement for a different alert', () => {
    let state = readyState([firstAlert, secondAlert])
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 30, alertId: firstAlert.alertId,
    })
    const firstBusy = state
    state = reduceKeywordAlertCenter(state, {
      type: 'ack.started', requestId: 31, alertId: secondAlert.alertId,
    })
    expect(state).toBe(firstBusy)

    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 31,
      alertId: secondAlert.alertId,
      acknowledgedAt: '2026-09-03T02:20:00.000Z',
      status: 'all',
    })
    expect(state).toBe(firstBusy)
    expect(state.acknowledgingAlertId).toBe(firstAlert.alertId)
    expect(state.items[1]?.acknowledgedAt).toBeNull()

    state = reduceKeywordAlertCenter(state, {
      type: 'ack.succeeded',
      requestId: 30,
      alertId: firstAlert.alertId,
      acknowledgedAt: '2026-09-03T02:30:00.000Z',
      status: 'all',
    })
    expect(state.items[0]?.acknowledgedAt).toBe('2026-09-03T02:30:00.000Z')
    expect(state.items[1]?.acknowledgedAt).toBeNull()
    expect(state.acknowledgingAlertId).toBeNull()
    expect(state.acknowledgementRequestId).toBeNull()
  })

  it('realtime.received increments revision without inserting the unscoped event as a row', () => {
    const event: WsKeywordAlertEvent = {
      type: 'keyword_alert',
      alertId: '00000000-0000-4000-8000-000000000103',
      severity: 'urgent',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T02:00:00.000Z',
    }
    const state = readyState([firstAlert])

    const next = reduceKeywordAlertCenter(state, {
      type: 'realtime.received', event,
    })

    expect(next.realtimeRevision).toBe(1)
    expect(next.items).toEqual([firstAlert])
    expect(next.items.some(item => item.alertId === event.alertId)).toBe(false)
  })
})
