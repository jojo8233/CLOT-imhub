import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  emptyCustomerProfile,
  type CustomerProfileListItem,
} from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import type { AccountRow } from '../api/client.js'
import {
  initialCustomerProfileLibraryState,
  type CustomerProfileLibraryState,
} from '../customer-profile-library.js'
import {
  CustomerProfileLibraryContent,
  type CustomerProfileLibraryContentProps,
} from './CustomerProfileLibraryView.js'

type ContentOverrides = Pick<CustomerProfileLibraryContentProps, 'state'>
  & Partial<Omit<CustomerProfileLibraryContentProps, 'state'>>

function renderContent(overrides: ContentOverrides): string {
  const defaults: Omit<CustomerProfileLibraryContentProps, 'state'> = {
    selectedItem: null,
    queryInput: '',
    platform: null,
    accountId: null,
    accounts: [] as ReadonlyArray<Pick<AccountRow, 'id' | 'platform' | 'display_name'>>,
    hasFilters: false,
    detail: null as ReactNode,
    onQueryInputChange: () => undefined,
    onPlatformChange: () => undefined,
    onAccountChange: () => undefined,
    onRefresh: () => undefined,
    onSelect: () => undefined,
    onLoadMore: () => undefined,
    onRetry: () => undefined,
  }
  const props: CustomerProfileLibraryContentProps = {
    ...defaults,
    ...overrides,
    state: overrides.state,
  }
  return renderToStaticMarkup(<CustomerProfileLibraryContent {...props} />)
}

function viewState(
  overrides: Partial<CustomerProfileLibraryState> = {},
): CustomerProfileLibraryState {
  return { ...initialCustomerProfileLibraryState(), ...overrides }
}

const profileItem: CustomerProfileListItem = {
  conversationId: '00000000-0000-4000-8000-000000000201',
  accountId: '00000000-0000-4000-8000-000000000202',
  platform: 'telegram',
  accountDisplayName: 'Synthetic Account',
  conversationDisplayName: 'Synthetic Customer',
  profile: {
    ...emptyCustomerProfile('00000000-0000-4000-8000-000000000201'),
    name: 'Synthetic Customer',
    revision: 1,
    updatedAt: '2026-09-03T00:00:00.000Z',
  },
}

const readyState = (items: CustomerProfileListItem[], nextCursor: string | null) =>
  viewState({ items, nextCursor, hasLoaded: true })
const loadingState = () =>
  viewState({ activeLoad: { requestId: 1, mode: 'replace' } })
const emptyState = () => viewState({ hasLoaded: true })
const failedState = () =>
  viewState({ error: '客户档案库加载失败，请稍后重试' })
const appendFailedState = () => viewState({
  items: [profileItem],
  hasLoaded: true,
  appendError: '连不上服务端，请稍后重试',
})

describe('CustomerProfileLibraryContent', () => {
  it('renders search controls, result metadata and selected profile detail', () => {
    const html = renderContent({
      state: readyState([profileItem], null),
      selectedItem: profileItem,
      detail: <div>Selected profile detail</div>,
    })
    expect(html).toContain('客户档案库')
    expect(html).toContain('搜索客户档案')
    expect(html).toContain('Synthetic Account')
    expect(html).toContain('Synthetic Customer')
    expect(html).toContain('Selected profile detail')
  })

  it('renders distinct initial, empty-filter, first-load-error and append-error states', () => {
    expect(renderContent({ state: loadingState(), selectedItem: null }))
      .toContain('正在加载客户档案库')
    expect(renderContent({ state: emptyState(), selectedItem: null, hasFilters: false }))
      .toContain('还没有客户档案')
    expect(renderContent({ state: emptyState(), selectedItem: null, hasFilters: true }))
      .toContain('没有匹配的客户档案')
    expect(renderContent({ state: failedState(), selectedItem: null })).toContain('重试')
    expect(renderContent({ state: appendFailedState(), selectedItem: null }))
      .toContain('重试加载更多')
  })
})
