import type {
  KeywordAlertListItem,
  KeywordAlertListPage,
  KeywordAlertStatusFilter,
  WsKeywordAlertEvent,
} from '@im-hub/shared'

export type KeywordAlertLoadMode = 'replace' | 'append'

export interface KeywordAlertCenterState {
  items: KeywordAlertListItem[]
  nextCursor: string | null
  activeLoad: { requestId: number; mode: KeywordAlertLoadMode } | null
  acknowledgingAlertId: string | null
  error: string | null
  appendError: string | null
  ackError: { alertId: string; message: string } | null
  realtimeRevision: number
  hasLoaded: boolean
}

export type KeywordAlertCenterAction =
  | { type: 'filters.changed' }
  | { type: 'load.started'; requestId: number; mode: KeywordAlertLoadMode }
  | {
    type: 'load.succeeded'
    requestId: number
    mode: KeywordAlertLoadMode
    page: KeywordAlertListPage
  }
  | {
    type: 'load.failed'
    requestId: number
    mode: KeywordAlertLoadMode
    message: string
  }
  | { type: 'ack.started'; alertId: string }
  | {
    type: 'ack.succeeded'
    alertId: string
    acknowledgedAt: string
    status?: KeywordAlertStatusFilter
  }
  | { type: 'ack.failed'; alertId: string; message: string }
  | { type: 'realtime.received'; event: WsKeywordAlertEvent }

export function initialKeywordAlertCenterState(): KeywordAlertCenterState {
  return {
    items: [],
    nextCursor: null,
    activeLoad: null,
    acknowledgingAlertId: null,
    error: null,
    appendError: null,
    ackError: null,
    realtimeRevision: 0,
    hasLoaded: false,
  }
}

function isActiveLoad(
  state: KeywordAlertCenterState,
  action: { requestId: number; mode: KeywordAlertLoadMode },
): boolean {
  return state.activeLoad?.requestId === action.requestId
    && state.activeLoad.mode === action.mode
}

function copyItems(items: KeywordAlertListItem[]): KeywordAlertListItem[] {
  return items.map(item => ({ ...item }))
}

function appendUniqueItems(
  current: KeywordAlertListItem[],
  incoming: KeywordAlertListItem[],
): KeywordAlertListItem[] {
  const seen = new Set(current.map(item => item.alertId))
  const result = [...current]
  for (const item of incoming) {
    if (seen.has(item.alertId)) continue
    seen.add(item.alertId)
    result.push({ ...item })
  }
  return result
}

export function reduceKeywordAlertCenter(
  state: KeywordAlertCenterState,
  action: KeywordAlertCenterAction,
): KeywordAlertCenterState {
  switch (action.type) {
    case 'filters.changed':
      return {
        ...initialKeywordAlertCenterState(),
        realtimeRevision: state.realtimeRevision,
      }

    case 'load.started':
      if (action.mode === 'append' && (state.activeLoad || !state.nextCursor)) {
        return state
      }
      return {
        ...state,
        activeLoad: { requestId: action.requestId, mode: action.mode },
        error: action.mode === 'replace' ? null : state.error,
        appendError: null,
      }

    case 'load.succeeded': {
      if (!isActiveLoad(state, action)) return state
      const items = action.mode === 'append'
        ? appendUniqueItems(state.items, action.page.items)
        : copyItems(action.page.items)
      return {
        ...state,
        items,
        nextCursor: action.page.nextCursor,
        activeLoad: null,
        error: null,
        appendError: null,
        hasLoaded: true,
      }
    }

    case 'load.failed':
      if (!isActiveLoad(state, action)) return state
      return action.mode === 'append'
        ? { ...state, activeLoad: null, appendError: action.message }
        : { ...state, activeLoad: null, error: action.message, appendError: null }

    case 'ack.started':
      if (state.acknowledgingAlertId
        || !state.items.some(item => item.alertId === action.alertId)) {
        return state
      }
      return {
        ...state,
        acknowledgingAlertId: action.alertId,
        ackError: null,
      }

    case 'ack.succeeded':
      if (state.acknowledgingAlertId !== action.alertId) return state
      return {
        ...state,
        items: action.status === 'all'
          ? state.items.map(item => item.alertId === action.alertId
            ? { ...item, acknowledgedAt: action.acknowledgedAt }
            : item)
          : state.items.filter(item => item.alertId !== action.alertId),
        acknowledgingAlertId: null,
        ackError: null,
      }

    case 'ack.failed':
      if (state.acknowledgingAlertId !== action.alertId) return state
      return {
        ...state,
        acknowledgingAlertId: null,
        ackError: { alertId: action.alertId, message: action.message },
      }

    case 'realtime.received':
      return {
        ...state,
        realtimeRevision: state.realtimeRevision + 1,
      }
  }
}
