import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  PLATFORMS,
  type CustomerProfile,
  type CustomerProfileListItem,
  type Platform,
} from '@im-hub/shared'
import {
  api,
  NetworkError,
  UnauthorizedError,
  type AccountRow,
} from '../api/client.js'
import {
  initialCustomerProfileLibraryState,
  reduceCustomerProfileLibrary,
  type CustomerProfileLibraryLoadMode,
  type CustomerProfileLibraryState,
} from '../customer-profile-library.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { CustomerProfileSection } from './CustomerProfileSection.js'

const PAGE_LIMIT = 50

export interface CustomerProfileLibraryContentProps {
  state: CustomerProfileLibraryState
  selectedItem: CustomerProfileListItem | null
  queryInput: string
  platform: Platform | null
  accountId: string | null
  accounts: ReadonlyArray<Pick<AccountRow, 'id' | 'platform' | 'display_name'>>
  hasFilters: boolean
  detail: ReactNode
  onQueryInputChange(value: string): void
  onPlatformChange(value: Platform | null): void
  onAccountChange(value: string | null): void
  onRefresh(): void
  onSelect(conversationId: string): void
  onLoadMore(): void
  onRetry(): void
}

function profileTitle(item: CustomerProfileListItem): string {
  return item.profile.name ?? item.conversationDisplayName ?? '未命名客户'
}

function profilePreview(item: CustomerProfileListItem): string {
  return item.profile.ageLocation
    ?? item.profile.occupation
    ?? item.profile.family
    ?? item.profile.interests
    ?? item.profile.other
    ?? '仅有姓名信息'
}

export function CustomerProfileLibraryView({ readOnly }: { readOnly: boolean }) {
  const accounts = useStore(state => state.accounts)
  const [state, dispatch] = useReducer(
    reduceCustomerProfileLibrary,
    initialCustomerProfileLibraryState(),
  )
  const [queryInput, setQueryInput] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)

  const accountMatchesPlatform = useCallback((candidateId: string, target: Platform | null) => {
    const account = accounts.find(value => value.id === candidateId)
    return Boolean(account && (!target || account.platform === target))
  }, [accounts])

  const effectiveAccountId = accountId && accountMatchesPlatform(accountId, platform)
    ? accountId
    : null

  const invalidateVisibleResults = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    dispatch({ type: 'filters.changed' })
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(queryInput.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    if (accountId && effectiveAccountId === null) setAccountId(null)
  }, [accountId, effectiveAccountId])

  const startLoad = useCallback((
    mode: CustomerProfileLibraryLoadMode,
    cursor: string | null = null,
  ) => {
    if (mode === 'append' && controllerRef.current) return
    if (mode === 'replace') invalidateVisibleResults()

    const controller = new AbortController()
    controllerRef.current = controller
    const requestId = ++requestIdRef.current
    dispatch({ type: 'load.started', requestId, mode })

    void api.searchCustomerProfiles({
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      ...(platform ? { platform } : {}),
      ...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }, controller.signal).then(page => {
      if (controller.signal.aborted) return
      dispatch({ type: 'load.succeeded', requestId, mode, page })
    }).catch(error => {
      if (controller.signal.aborted || error instanceof UnauthorizedError) return
      dispatch({
        type: 'load.failed',
        requestId,
        mode,
        message: error instanceof NetworkError
          ? '连不上服务端，请稍后重试'
          : '客户档案库加载失败，请稍后重试',
      })
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null
    })
  }, [debouncedQuery, effectiveAccountId, invalidateVisibleResults, platform])

  useEffect(() => {
    startLoad('replace')
    return () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [startLoad])

  const handleQueryInputChange = useCallback((value: string) => {
    if (value.trim() !== debouncedQuery) invalidateVisibleResults()
    setQueryInput(value)
  }, [debouncedQuery, invalidateVisibleResults])

  const handlePlatformChange = useCallback((value: Platform | null) => {
    if (value === platform) return
    invalidateVisibleResults()
    setPlatform(value)
    setAccountId(current => current && accountMatchesPlatform(current, value) ? current : null)
  }, [accountMatchesPlatform, invalidateVisibleResults, platform])

  const handleAccountChange = useCallback((value: string | null) => {
    if (value === effectiveAccountId) return
    invalidateVisibleResults()
    setAccountId(value)
  }, [effectiveAccountId, invalidateVisibleResults])

  const handleLoadMore = useCallback(() => {
    if (!state.nextCursor || state.activeLoad || controllerRef.current) return
    startLoad('append', state.nextCursor)
  }, [startLoad, state.activeLoad, state.nextCursor])

  const handleProfileSaved = useCallback((profile: CustomerProfile) => {
    dispatch({ type: 'profile.saved', profile })
    startLoad('replace')
  }, [startLoad])

  const selectedItem = useMemo(() => state.items.find(
    item => item.conversationId === state.selectedConversationId,
  ) ?? null, [state.items, state.selectedConversationId])

  const hasFilters = queryInput.trim() !== '' || platform !== null || effectiveAccountId !== null
  const detail = selectedItem ? (
    <CustomerProfileSection
      conversationId={selectedItem.conversationId}
      readOnly={readOnly}
      onSaved={handleProfileSaved}
    />
  ) : null

  return (
    <CustomerProfileLibraryContent
      state={state}
      selectedItem={selectedItem}
      queryInput={queryInput}
      platform={platform}
      accountId={effectiveAccountId}
      accounts={accounts}
      hasFilters={hasFilters}
      detail={detail}
      onQueryInputChange={handleQueryInputChange}
      onPlatformChange={handlePlatformChange}
      onAccountChange={handleAccountChange}
      onRefresh={() => startLoad('replace')}
      onSelect={conversationId => dispatch({ type: 'selection.changed', conversationId })}
      onLoadMore={handleLoadMore}
      onRetry={() => startLoad('replace')}
    />
  )
}

export function CustomerProfileLibraryContent({
  state,
  selectedItem,
  queryInput,
  platform,
  accountId,
  accounts,
  hasFilters,
  detail,
  onQueryInputChange,
  onPlatformChange,
  onAccountChange,
  onRefresh,
  onSelect,
  onLoadMore,
  onRetry,
}: CustomerProfileLibraryContentProps) {
  const filteredAccounts = platform
    ? accounts.filter(account => account.platform === platform)
    : accounts
  const firstLoading = !state.hasLoaded
    && state.activeLoad?.mode === 'replace'
    && !state.error

  return (
    <section style={libraryShellStyle}>
      <header style={headerStyle}>
        <div>
          <h2 style={titleStyle}>客户档案库</h2>
          <div style={subtitleStyle}>检索当前账号权限范围内的人工客户档案</div>
        </div>
        <button className="ih-btn" type="button" onClick={onRefresh} style={secondaryButtonStyle}>
          刷新
        </button>
      </header>

      <div style={filterBarStyle}>
        <input
          aria-label="搜索客户档案"
          value={queryInput}
          onChange={event => onQueryInputChange(event.currentTarget.value)}
          placeholder="搜索客户档案"
          style={{ ...controlStyle, flex: '1 1 260px' }}
        />
        <select
          aria-label="平台筛选"
          value={platform ?? ''}
          onChange={event => onPlatformChange(
            event.currentTarget.value === '' ? null : event.currentTarget.value as Platform,
          )}
          style={controlStyle}
        >
          <option value="">全部平台</option>
          {PLATFORMS.map(value => (
            <option key={value} value={value}>{PLATFORM_LABEL[value] ?? value}</option>
          ))}
        </select>
        <select
          aria-label="账号筛选"
          value={accountId ?? ''}
          onChange={event => onAccountChange(event.currentTarget.value || null)}
          style={controlStyle}
        >
          <option value="">全部账号</option>
          {filteredAccounts.map(account => (
            <option key={account.id} value={account.id}>{account.display_name}</option>
          ))}
        </select>
      </div>

      <div style={bodyStyle}>
        <div className="ih-scroll" style={masterStyle}>
          {firstLoading ? (
            <LibraryNotice>正在加载客户档案库…</LibraryNotice>
          ) : state.error && !state.hasLoaded ? (
            <LibraryNotice tone="error">
              {state.error}
              <button className="ih-btn" type="button" onClick={onRetry} style={inlineButtonStyle}>
                重试
              </button>
            </LibraryNotice>
          ) : state.hasLoaded && state.items.length === 0 ? (
            <LibraryNotice>{hasFilters ? '没有匹配的客户档案' : '还没有客户档案'}</LibraryNotice>
          ) : (
            <>
              {state.items.map(item => {
                const selected = selectedItem?.conversationId === item.conversationId
                return (
                  <button
                    key={item.conversationId}
                    className="ih-btn ih-row"
                    type="button"
                    onClick={() => onSelect(item.conversationId)}
                    style={{
                      ...rowStyle,
                      background: selected ? theme.color.limeSoft : 'transparent',
                      borderColor: selected ? theme.color.limeDeep : theme.color.border,
                    }}
                  >
                    <span style={rowTitleStyle}>{profileTitle(item)}</span>
                    <span style={rowMetaStyle}>
                      {PLATFORM_LABEL[item.platform] ?? item.platform} · {item.accountDisplayName}
                    </span>
                    <span className="ih-selectable" style={rowPreviewStyle}>
                      {profilePreview(item)}
                    </span>
                  </button>
                )
              })}
              {state.appendError && (
                <LibraryNotice tone="error">
                  {state.appendError}
                  <button className="ih-btn" type="button" onClick={onLoadMore} style={inlineButtonStyle}>
                    重试加载更多
                  </button>
                </LibraryNotice>
              )}
              {!state.appendError && state.activeLoad?.mode === 'append' && (
                <LibraryNotice>正在加载更多…</LibraryNotice>
              )}
              {!state.appendError && state.nextCursor && !state.activeLoad && (
                <button className="ih-btn" type="button" onClick={onLoadMore} style={loadMoreStyle}>
                  加载更多
                </button>
              )}
            </>
          )}
        </div>

        <div className="ih-scroll" style={detailStyle}>
          {selectedItem && detail
            ? detail
            : <LibraryNotice>请选择一位客户查看档案</LibraryNotice>}
        </div>
      </div>
    </section>
  )
}

function LibraryNotice({
  children,
  tone = 'normal',
}: {
  children: ReactNode
  tone?: 'normal' | 'error'
}) {
  return (
    <div style={{
      padding: theme.space.xl,
      textAlign: 'center',
      color: tone === 'error' ? theme.color.danger : theme.color.textMuted,
      fontSize: theme.font.size.sm,
      lineHeight: 1.7,
    }}>
      {children}
    </div>
  )
}

const libraryShellStyle: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: theme.color.bg,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: `${theme.space.lg}px ${theme.space.xl}px`,
  borderBottom: `1px solid ${theme.color.border}`,
  background: theme.color.card,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: theme.font.size.lg,
  fontWeight: theme.font.weight.heavy,
}

const subtitleStyle: CSSProperties = {
  marginTop: theme.space.xs,
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
}

const filterBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: theme.space.sm,
  padding: theme.space.md,
  borderBottom: `1px solid ${theme.color.border}`,
  background: theme.color.card,
}

const controlStyle: CSSProperties = {
  minWidth: 150,
  padding: '9px 11px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.white,
  color: theme.color.text,
  font: 'inherit',
}

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
}

const masterStyle: CSSProperties = {
  width: 360,
  minWidth: 280,
  padding: theme.space.md,
  borderRight: `1px solid ${theme.color.border}`,
}

const detailStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: theme.color.card,
}

const rowStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: theme.space.xs,
  marginBottom: theme.space.sm,
  padding: theme.space.md,
  textAlign: 'left',
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
  color: theme.color.text,
}

const rowTitleStyle: CSSProperties = {
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.bold,
}

const rowMetaStyle: CSSProperties = {
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
}

const rowPreviewStyle: CSSProperties = {
  overflow: 'hidden',
  color: theme.color.textMuted,
  fontSize: theme.font.size.sm,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const secondaryButtonStyle: CSSProperties = {
  padding: '8px 13px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.pill,
  background: theme.color.card,
  color: theme.color.text,
}

const inlineButtonStyle: CSSProperties = {
  marginLeft: theme.space.sm,
  padding: '4px 9px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.pill,
  background: theme.color.card,
  color: theme.color.text,
}

const loadMoreStyle: CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.pill,
  background: theme.color.card,
  color: theme.color.text,
}
