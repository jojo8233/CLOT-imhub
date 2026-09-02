import {
  emptyCustomerProfile,
  type CustomerProfileListItem,
  type CustomerProfileListPage,
} from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import {
  initialCustomerProfileLibraryState,
  reduceCustomerProfileLibrary,
  type CustomerProfileLibraryState,
} from './customer-profile-library.js'

function item(conversationId: string, name: string): CustomerProfileListItem {
  return {
    conversationId,
    accountId: '00000000-0000-4000-8000-000000000010',
    platform: 'telegram',
    accountDisplayName: 'Synthetic Account',
    conversationDisplayName: name,
    profile: {
      ...emptyCustomerProfile(conversationId),
      name,
      revision: 1,
      updatedAt: '2026-09-03T00:00:00.000Z',
    },
  }
}

function page(
  items: CustomerProfileListItem[],
  nextCursor: string | null,
): CustomerProfileListPage {
  return { items, nextCursor }
}

function readyState(
  items: CustomerProfileListItem[],
  nextCursor: string | null,
): CustomerProfileLibraryState {
  return {
    ...initialCustomerProfileLibraryState(),
    items,
    nextCursor,
    hasLoaded: true,
  }
}

const oldItem = item('00000000-0000-4000-8000-000000000101', 'Old')
const newItem = item('00000000-0000-4000-8000-000000000102', 'New')
const firstItem = item('00000000-0000-4000-8000-000000000103', 'First')
const secondItem = item('00000000-0000-4000-8000-000000000104', 'Second')

describe('customer profile library state', () => {
  it('ignores a stale replacement response after a newer request starts', () => {
    let state = initialCustomerProfileLibraryState()
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 1,
      mode: 'replace',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 2,
      mode: 'replace',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 1,
      mode: 'replace',
      page: page([oldItem], null),
    })
    expect(state.items).toEqual([])
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 2,
      mode: 'replace',
      page: page([newItem], null),
    })
    expect(state.items).toEqual([newItem])
  })

  it('appends with conversation deduplication and preserves loaded rows on append failure', () => {
    let state = readyState([firstItem], 'cursor-2')
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 2,
      mode: 'append',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 2,
      mode: 'append',
      page: page([firstItem, secondItem], null),
    })
    expect(state.items).toEqual([firstItem, secondItem])
    state = { ...state, nextCursor: 'cursor-3' }
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 3,
      mode: 'append',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.failed',
      requestId: 3,
      mode: 'append',
      message: '连不上服务端，请稍后重试',
    })
    expect(state.items).toEqual([firstItem, secondItem])
    expect(state.nextCursor).toBe('cursor-3')
    expect(state.appendError).toBe('连不上服务端，请稍后重试')
  })

  it('clears invalid selection and applies a successful profile save to the selected item', () => {
    let state = readyState([firstItem], null)
    state = reduceCustomerProfileLibrary(state, {
      type: 'selection.changed',
      conversationId: firstItem.conversationId,
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'profile.saved',
      profile: { ...firstItem.profile, name: 'Updated', revision: 2 },
    })
    expect(state.items[0]?.profile.name).toBe('Updated')
    state = reduceCustomerProfileLibrary(state, { type: 'filters.changed' })
    expect(state.selectedConversationId).toBeNull()
  })

  it('preserves a valid selection across same-filter replacement and clears it if absent', () => {
    let state = readyState([firstItem], null)
    state = reduceCustomerProfileLibrary(state, {
      type: 'selection.changed',
      conversationId: firstItem.conversationId,
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 1,
      mode: 'replace',
    })

    expect(state.items).toEqual([firstItem])
    expect(state.selectedConversationId).toBe(firstItem.conversationId)

    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 1,
      mode: 'replace',
      page: page([firstItem], null),
    })
    expect(state.selectedConversationId).toBe(firstItem.conversationId)

    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 2,
      mode: 'replace',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 2,
      mode: 'replace',
      page: page([secondItem], null),
    })
    expect(state.selectedConversationId).toBeNull()
  })

  it('reports replacement failure without pretending the first load completed', () => {
    let state = initialCustomerProfileLibraryState()
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 1,
      mode: 'replace',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.failed',
      requestId: 1,
      mode: 'replace',
      message: '客户档案库加载失败，请稍后重试',
    })

    expect(state).toMatchObject({
      items: [],
      activeLoad: null,
      error: '客户档案库加载失败，请稍后重试',
      appendError: null,
      hasLoaded: false,
    })
  })

  it('records an empty successful replacement as a completed load', () => {
    let state = initialCustomerProfileLibraryState()
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 1,
      mode: 'replace',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.succeeded',
      requestId: 1,
      mode: 'replace',
      page: page([], null),
    })

    expect(state).toMatchObject({
      items: [],
      nextCursor: null,
      activeLoad: null,
      error: null,
      hasLoaded: true,
    })
  })

  it('rejects selection of a conversation that is not in the current result set', () => {
    let state = readyState([firstItem], null)
    state = reduceCustomerProfileLibrary(state, {
      type: 'selection.changed',
      conversationId: secondItem.conversationId,
    })

    expect(state.selectedConversationId).toBeNull()
  })

  it('allows only one append load at a time and requires a next cursor', () => {
    let state = readyState([firstItem], 'cursor-2')
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 1,
      mode: 'append',
    })
    state = reduceCustomerProfileLibrary(state, {
      type: 'load.started',
      requestId: 2,
      mode: 'append',
    })
    expect(state.activeLoad).toEqual({ requestId: 1, mode: 'append' })

    const exhausted = readyState([firstItem], null)
    expect(reduceCustomerProfileLibrary(exhausted, {
      type: 'load.started',
      requestId: 3,
      mode: 'append',
    }).activeLoad).toBeNull()
  })
})
