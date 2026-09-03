import type {
  CustomerProfile,
  CustomerProfileListItem,
  CustomerProfileListPage,
} from '@im-hub/shared'

export type CustomerProfileLibraryLoadMode = 'replace' | 'append'

export interface CustomerProfileLibraryState {
  items: CustomerProfileListItem[]
  nextCursor: string | null
  selectedConversationId: string | null
  activeLoad: { requestId: number; mode: CustomerProfileLibraryLoadMode } | null
  error: string | null
  appendError: string | null
  hasLoaded: boolean
}

export type CustomerProfileLibraryAction =
  | { type: 'filters.changed' }
  | { type: 'load.started'; requestId: number; mode: CustomerProfileLibraryLoadMode }
  | {
    type: 'load.succeeded'
    requestId: number
    mode: CustomerProfileLibraryLoadMode
    page: CustomerProfileListPage
  }
  | {
    type: 'load.failed'
    requestId: number
    mode: CustomerProfileLibraryLoadMode
    message: string
  }
  | { type: 'selection.changed'; conversationId: string | null }
  | { type: 'profile.saved'; profile: CustomerProfile }

export function initialCustomerProfileLibraryState(): CustomerProfileLibraryState {
  return {
    items: [],
    nextCursor: null,
    selectedConversationId: null,
    activeLoad: null,
    error: null,
    appendError: null,
    hasLoaded: false,
  }
}

function isActiveLoad(
  state: CustomerProfileLibraryState,
  action: { requestId: number; mode: CustomerProfileLibraryLoadMode },
): boolean {
  return state.activeLoad?.requestId === action.requestId
    && state.activeLoad.mode === action.mode
}

function appendUniqueItems(
  current: CustomerProfileListItem[],
  incoming: CustomerProfileListItem[],
): CustomerProfileListItem[] {
  const seen = new Set(current.map(item => item.conversationId))
  const result = [...current]
  for (const item of incoming) {
    if (seen.has(item.conversationId)) continue
    seen.add(item.conversationId)
    result.push(item)
  }
  return result
}

export function reduceCustomerProfileLibrary(
  state: CustomerProfileLibraryState,
  action: CustomerProfileLibraryAction,
): CustomerProfileLibraryState {
  switch (action.type) {
    case 'filters.changed':
      return initialCustomerProfileLibraryState()

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
        : action.page.items
      const selectedConversationId = state.selectedConversationId
        && items.some(item => item.conversationId === state.selectedConversationId)
        ? state.selectedConversationId
        : null
      return {
        ...state,
        items,
        nextCursor: action.page.nextCursor,
        selectedConversationId,
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

    case 'selection.changed':
      return {
        ...state,
        selectedConversationId: action.conversationId
          && state.items.some(item => item.conversationId === action.conversationId)
          ? action.conversationId
          : null,
      }

    case 'profile.saved':
      return {
        ...state,
        items: state.items.map(item => item.conversationId === action.profile.conversationId
          ? { ...item, profile: action.profile }
          : item),
      }
  }
}
