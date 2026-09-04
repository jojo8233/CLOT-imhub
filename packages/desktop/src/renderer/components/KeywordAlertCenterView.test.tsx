import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  KeywordAlertListItem,
  KeywordAlertSeverity,
  KeywordAlertStatusFilter,
  Platform,
  Role,
} from '@im-hub/shared'
import { describe, expect, it } from 'vitest'
import type { AccountRow } from '../api/client.js'
import {
  initialKeywordAlertCenterState,
  type KeywordAlertCenterState,
} from '../keyword-alert-center.js'
import {
  KeywordAlertContent,
  keywordAlertReplacementIdentity,
  keywordAlertStateForReplacement,
  type KeywordAlertContentProps,
} from './KeywordAlertCenterView.js'

type ContentOverrides = Partial<Omit<KeywordAlertContentProps, 'state' | 'role'>> & {
  state?: KeywordAlertCenterState
  role?: Role
}

const accounts: ReadonlyArray<Pick<AccountRow, 'id' | 'platform' | 'display_name'>> = [
  { id: 'account-telegram', platform: 'telegram', display_name: 'Synthetic Telegram' },
  { id: 'account-signal', platform: 'signal', display_name: 'Synthetic Signal' },
]

function state(overrides: Partial<KeywordAlertCenterState> = {}): KeywordAlertCenterState {
  return { ...initialKeywordAlertCenterState(), ...overrides }
}

function renderContent(overrides: ContentOverrides = {}): string {
  const defaults: KeywordAlertContentProps = {
    state: state({ hasLoaded: true }),
    role: 'owner',
    status: 'pending',
    severity: null,
    platform: null,
    accountId: null,
    accounts,
    activeSection: 'alerts',
    ruleManager: null,
    onStatusChange: () => undefined,
    onSeverityChange: () => undefined,
    onPlatformChange: () => undefined,
    onAccountChange: () => undefined,
    onSectionChange: () => undefined,
    onRefresh: () => undefined,
    onLoadMore: () => undefined,
    onRetry: () => undefined,
    onAcknowledge: () => undefined,
  }
  return renderToStaticMarkup(<KeywordAlertContent {...defaults} {...overrides} />)
}

function alertItem(overrides: Partial<KeywordAlertListItem> = {}): KeywordAlertListItem {
  return {
    alertId: 'alert-normal',
    messageId: 'message-normal',
    conversationId: 'conversation-normal',
    accountId: 'account-telegram',
    platform: 'telegram',
    severity: 'normal',
    pattern: 'Synthetic Keyword',
    accountDisplayName: 'Synthetic Telegram',
    conversationDisplayName: 'Synthetic Customer',
    excerpt: 'A short synthetic excerpt',
    matchedAt: '2026-09-03T01:30:00.000Z',
    messageChangedAfterMatch: false,
    messageDeleted: false,
    requiresAcknowledgement: true,
    acknowledgedAt: null,
    ...overrides,
  }
}

describe('KeywordAlertCenterView replacement loading', () => {
  it('starts a distinct replacement generation when the permission scope role changes', () => {
    const identity = (role: Role) => keywordAlertReplacementIdentity({
      role,
      status: 'pending',
      severity: null,
      platform: null,
      accountId: null,
    })

    expect(identity('owner')).not.toBe(identity('manager'))
    expect(identity('manager')).not.toBe(identity('agent'))
    expect(identity('agent')).toBe(identity('agent'))
  })

  it('hides rows from the previous permission scope before replacement effects run', () => {
    const staleState = state({ items: [alertItem()], hasLoaded: true })

    expect(keywordAlertStateForReplacement(staleState, 'owner-scope', 'manager-scope').items)
      .toEqual([])
    expect(keywordAlertStateForReplacement(staleState, 'manager-scope', 'manager-scope'))
      .toBe(staleState)
  })
})

describe('KeywordAlertContent role boundaries', () => {
  it.each<Role>(['owner', 'manager', 'agent'])(
    'renders pending, acknowledged and all tabs for %s',
    role => {
      const html = renderContent({ role })
      expect(html).toContain('未确认')
      expect(html).toContain('已确认')
      expect(html).toContain('全部告警')
    },
  )

  it('renders the owner rule-manager tab and node only for owner', () => {
    const ruleManager = <div>Owner-only synthetic rules</div>
    const owner = renderContent({
      role: 'owner',
      activeSection: 'rules',
      ruleManager,
    })
    expect(owner).toContain('规则管理')
    expect(owner).toContain('Owner-only synthetic rules')

    for (const role of ['manager', 'agent', 'auditor'] satisfies Role[]) {
      const html = renderContent({ role, activeSection: 'rules', ruleManager })
      expect(html).not.toContain('规则管理')
      expect(html).not.toContain('Owner-only synthetic rules')
    }
  })

  it('renders an auditor-only all-alert timeline without acknowledgement controls', () => {
    const html = renderContent({
      role: 'auditor',
      status: 'all',
      state: state({ items: [alertItem()], hasLoaded: true }),
    })
    expect(html).toContain('全部告警')
    expect(html).not.toContain('>未确认<')
    expect(html).not.toContain('>已确认<')
    expect(html).not.toContain('确认告警')
    expect(html).not.toContain('重试确认')
  })
})

describe('KeywordAlertContent alert timeline', () => {
  it('renders scoped filters, all severity labels and bounded alert metadata', () => {
    const hiddenDeletedBody = 'DELETED_BODY_MUST_STAY_HIDDEN'
    const items = [
      alertItem(),
      alertItem({
        alertId: 'alert-important',
        severity: 'important',
        platform: 'signal',
        accountId: 'account-signal',
        accountDisplayName: 'Synthetic Signal',
        conversationDisplayName: null,
        pattern: 'Important Keyword',
        excerpt: 'Edited current excerpt',
        messageChangedAfterMatch: true,
      }),
      alertItem({
        alertId: 'alert-urgent-deleted',
        severity: 'urgent',
        pattern: 'Urgent Keyword',
        excerpt: hiddenDeletedBody,
        messageDeleted: true,
      }),
    ]
    const html = renderContent({
      state: state({ items, hasLoaded: true }),
    })

    expect(html).toContain('等级筛选')
    expect(html).toContain('平台筛选')
    expect(html).toContain('账号筛选')
    expect(html).toContain('普通')
    expect(html).toContain('重要')
    expect(html).toContain('紧急')
    expect(html).toContain('Synthetic Telegram')
    expect(html).toContain('Synthetic Signal')
    expect(html).toContain('Synthetic Customer')
    expect(html).toContain('未命名会话')
    expect(html).toContain('Synthetic Keyword')
    expect(html).toContain('2026-09-03 01:30:00 UTC')
    expect(html).toContain('A short synthetic excerpt')
    expect(html).toContain('命中后已编辑')
    expect(html).toContain('原消息已删除')
    expect(html).not.toContain(hiddenDeletedBody)
    expect(html).toContain('确认告警')
  })

  it('renders loading, empty, first-load error, append error and row acknowledgement error states', () => {
    const loading = renderContent({
      state: state({ activeLoad: { requestId: 1, mode: 'replace' } }),
    })
    expect(loading).toContain('正在加载关键词告警')

    const empty = renderContent({ state: state({ hasLoaded: true }) })
    expect(empty).toContain('当前没有关键词告警')

    const failed = renderContent({
      state: state({ error: '关键词告警加载失败，请稍后重试' }),
    })
    expect(failed).toContain('关键词告警加载失败，请稍后重试')
    expect(failed).toContain('重试')

    const appendFailed = renderContent({
      state: state({
        items: [alertItem()],
        hasLoaded: true,
        nextCursor: 'next',
        appendError: '连不上服务端，请稍后重试',
      }),
    })
    expect(appendFailed).toContain('连不上服务端，请稍后重试')
    expect(appendFailed).toContain('重试加载更多')
    expect(appendFailed).toContain('Synthetic Customer')

    const ackFailed = renderContent({
      state: state({
        items: [alertItem()],
        hasLoaded: true,
        ackError: { alertId: 'alert-normal', message: '确认失败，请稍后重试' },
      }),
    })
    expect(ackFailed).toContain('确认失败，请稍后重试')
    expect(ackFailed).toContain('重试确认')
  })

  it('disables every acknowledgement action while one alert is being acknowledged', () => {
    const html = renderContent({
      state: state({
        items: [
          alertItem(),
          alertItem({
            alertId: 'alert-second',
            messageId: 'message-second',
            conversationId: 'conversation-second',
          }),
        ],
        hasLoaded: true,
        acknowledgingAlertId: 'alert-normal',
        acknowledgementRequestId: 7,
      }),
    })

    expect(html).toContain('data-acknowledge-button="alert-normal" disabled=""')
    expect(html).toContain('data-acknowledge-button="alert-second" disabled=""')
    expect(html).toContain('正在确认…')
    expect(html).toContain('等待当前确认…')
  })

  it('exposes controlled filter values without inventing unsupported values', () => {
    const severities: Array<KeywordAlertSeverity | null> = [null, 'urgent']
    const platforms: Array<Platform | null> = [null, 'telegram']
    const statuses: KeywordAlertStatusFilter[] = ['pending', 'acknowledged', 'all']
    for (const severity of severities) {
      for (const platform of platforms) {
        for (const status of statuses) {
          expect(renderContent({ severity, platform, status })).toContain('关键词告警')
        }
      }
    }
  })
})
