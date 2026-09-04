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
  type KeywordAlertListItem,
  type KeywordAlertSeverity,
  type KeywordAlertStatusFilter,
  type Platform,
  type Role,
} from '@im-hub/shared'
import {
  api,
  NetworkError,
  UnauthorizedError,
  type AccountRow,
} from '../api/client.js'
import {
  initialKeywordAlertCenterState,
  reduceKeywordAlertCenter,
  type KeywordAlertCenterState,
  type KeywordAlertLoadMode,
} from '../keyword-alert-center.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { KeywordRuleManager } from './KeywordRuleManager.js'

const PAGE_LIMIT = 50

type AlertSection = 'alerts' | 'rules'

export interface KeywordAlertContentProps {
  state: KeywordAlertCenterState
  role: Role
  status: KeywordAlertStatusFilter
  severity: KeywordAlertSeverity | null
  platform: Platform | null
  accountId: string | null
  accounts: ReadonlyArray<Pick<AccountRow, 'id' | 'platform' | 'display_name'>>
  activeSection: AlertSection
  ruleManager?: ReactNode
  onStatusChange(value: KeywordAlertStatusFilter): void
  onSeverityChange(value: KeywordAlertSeverity | null): void
  onPlatformChange(value: Platform | null): void
  onAccountChange(value: string | null): void
  onSectionChange(value: AlertSection): void
  onRefresh(): void
  onLoadMore(): void
  onRetry(): void
  onAcknowledge(alertId: string): void
}

interface ActiveAcknowledgement {
  alertId: string
  requestId: number
}

export function keywordAlertReplacementIdentity({
  role,
  status,
  severity,
  platform,
  accountId,
}: {
  role: Role
  status: KeywordAlertStatusFilter
  severity: KeywordAlertSeverity | null
  platform: Platform | null
  accountId: string | null
}): string {
  return JSON.stringify([role, status, severity, platform, accountId])
}

export function keywordAlertStateForReplacement(
  state: KeywordAlertCenterState,
  stateIdentity: string,
  replacementIdentity: string,
): KeywordAlertCenterState {
  return stateIdentity === replacementIdentity
    ? state
    : initialKeywordAlertCenterState()
}

const SEVERITY_LABEL: Record<KeywordAlertSeverity, string> = {
  normal: '普通',
  important: '重要',
  urgent: '紧急',
}

const SEVERITY_COLOR: Record<KeywordAlertSeverity, string> = {
  normal: theme.color.textMuted,
  important: theme.color.gold,
  urgent: theme.color.danger,
}

function alertLoadError(error: unknown): string | null {
  if (error instanceof UnauthorizedError) return null
  return error instanceof NetworkError
    ? '连不上服务端，请稍后重试'
    : '关键词告警加载失败，请稍后重试'
}

function alertAcknowledgeError(error: unknown): string | null {
  if (error instanceof UnauthorizedError) return null
  return error instanceof NetworkError
    ? '连不上服务端，请稍后重试'
    : '确认失败，请稍后重试'
}

export function KeywordAlertCenterView({
  role,
  realtimeRevision,
  onAcknowledged,
}: {
  role: Role
  realtimeRevision: number
  onAcknowledged(): void
}): ReactNode {
  const accounts = useStore(store => store.accounts)
  const [state, dispatch] = useReducer(
    reduceKeywordAlertCenter,
    initialKeywordAlertCenterState(),
  )
  const [selectedStatus, setSelectedStatus] = useState<KeywordAlertStatusFilter>('pending')
  const [severity, setSeverity] = useState<KeywordAlertSeverity | null>(null)
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<AlertSection>('alerts')
  const controllerRef = useRef<AbortController | null>(null)
  const loadRequestIdRef = useRef(0)
  const acknowledgementRequestIdRef = useRef(0)
  const activeAcknowledgementRef = useRef<ActiveAcknowledgement | null>(null)
  const mountedRef = useRef(false)
  const previousRoleRef = useRef(role)
  const status: KeywordAlertStatusFilter = role === 'auditor' ? 'all' : selectedStatus

  const accountMatchesPlatform = useCallback((candidateId: string, target: Platform | null) => {
    const account = accounts.find(value => value.id === candidateId)
    return Boolean(account && (!target || account.platform === target))
  }, [accounts])
  const effectiveAccountId = accountId && accountMatchesPlatform(accountId, platform)
    ? accountId
    : null
  const replacementIdentity = keywordAlertReplacementIdentity({
    role,
    status,
    severity,
    platform,
    accountId: effectiveAccountId,
  })
  const stateReplacementIdentityRef = useRef(replacementIdentity)
  const visibleState = keywordAlertStateForReplacement(
    state,
    stateReplacementIdentityRef.current,
    replacementIdentity,
  )

  const cancelActiveLoad = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const invalidateFilters = useCallback(() => {
    cancelActiveLoad()
    acknowledgementRequestIdRef.current += 1
    activeAcknowledgementRef.current = null
    dispatch({ type: 'filters.changed' })
  }, [cancelActiveLoad])

  const startLoad = useCallback((
    mode: KeywordAlertLoadMode,
    cursor: string | null = null,
  ) => {
    if (mode === 'append' && controllerRef.current) return
    if (mode === 'replace') cancelActiveLoad()
    const controller = new AbortController()
    controllerRef.current = controller
    const requestId = ++loadRequestIdRef.current
    dispatch({ type: 'load.started', requestId, mode })
    void api.searchKeywordAlerts({
      status,
      ...(severity ? { severity } : {}),
      ...(platform ? { platform } : {}),
      ...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    }, controller.signal).then(page => {
      if (controller.signal.aborted) return
      dispatch({ type: 'load.succeeded', requestId, mode, page })
    }).catch(error => {
      if (controller.signal.aborted) return
      const message = alertLoadError(error)
      if (message) dispatch({ type: 'load.failed', requestId, mode, message })
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null
    })
  }, [cancelActiveLoad, effectiveAccountId, platform, severity, status])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelActiveLoad()
      acknowledgementRequestIdRef.current += 1
      activeAcknowledgementRef.current = null
    }
  }, [cancelActiveLoad])

  useEffect(() => {
    if (previousRoleRef.current === role) return
    previousRoleRef.current = role
    invalidateFilters()
    if (role === 'auditor') setActiveSection('alerts')
  }, [invalidateFilters, role])

  useEffect(() => {
    if (accountId && effectiveAccountId === null) {
      invalidateFilters()
      setAccountId(null)
    }
  }, [accountId, effectiveAccountId, invalidateFilters])

  // 角色或账号范围变化的失效 effect 必须先运行，再开始新一代请求；否则后置
  // abort 会把刚按新 scope 发出的请求取消，且依赖已稳定后不会自动补发。
  useEffect(() => {
    stateReplacementIdentityRef.current = replacementIdentity
    startLoad('replace')
    return cancelActiveLoad
  }, [cancelActiveLoad, realtimeRevision, replacementIdentity, startLoad])

  const changeStatus = useCallback((value: KeywordAlertStatusFilter) => {
    if (role === 'auditor' || value === status) return
    invalidateFilters()
    setSelectedStatus(value)
  }, [invalidateFilters, role, status])

  const changeSeverity = useCallback((value: KeywordAlertSeverity | null) => {
    if (value === severity) return
    invalidateFilters()
    setSeverity(value)
  }, [invalidateFilters, severity])

  const changePlatform = useCallback((value: Platform | null) => {
    if (value === platform) return
    invalidateFilters()
    setPlatform(value)
    setAccountId(current => current && accountMatchesPlatform(current, value) ? current : null)
  }, [accountMatchesPlatform, invalidateFilters, platform])

  const changeAccount = useCallback((value: string | null) => {
    if (value === effectiveAccountId) return
    invalidateFilters()
    setAccountId(value)
  }, [effectiveAccountId, invalidateFilters])

  const loadMore = useCallback(() => {
    if (!state.nextCursor || state.activeLoad || controllerRef.current) return
    startLoad('append', state.nextCursor)
  }, [startLoad, state.activeLoad, state.nextCursor])

  const acknowledge = useCallback((alertId: string) => {
    if (role === 'auditor' || activeAcknowledgementRef.current) return
    if (!state.items.some(item => item.alertId === alertId)) return
    const requestId = ++acknowledgementRequestIdRef.current
    const attempt = { alertId, requestId }
    activeAcknowledgementRef.current = attempt
    dispatch({ type: 'ack.started', alertId, requestId })
    void api.acknowledgeKeywordAlert(alertId).then(result => {
      if (!mountedRef.current
        || activeAcknowledgementRef.current?.alertId !== alertId
        || activeAcknowledgementRef.current.requestId !== requestId) return
      activeAcknowledgementRef.current = null
      dispatch({
        type: 'ack.succeeded',
        alertId,
        requestId,
        acknowledgedAt: result.acknowledgedAt,
        status,
      })
      onAcknowledged()
    }).catch(error => {
      if (!mountedRef.current
        || activeAcknowledgementRef.current?.alertId !== alertId
        || activeAcknowledgementRef.current.requestId !== requestId) return
      activeAcknowledgementRef.current = null
      const message = alertAcknowledgeError(error)
      if (message) dispatch({ type: 'ack.failed', alertId, requestId, message })
    })
  }, [onAcknowledged, role, state.items, status])

  const filteredAccounts = useMemo(() => platform
    ? accounts.filter(account => account.platform === platform)
    : accounts, [accounts, platform])

  return (
    <KeywordAlertContent
      state={visibleState}
      role={role}
      status={status}
      severity={severity}
      platform={platform}
      accountId={effectiveAccountId}
      accounts={filteredAccounts}
      activeSection={activeSection}
      ruleManager={role === 'owner' ? <KeywordRuleManager /> : null}
      onStatusChange={changeStatus}
      onSeverityChange={changeSeverity}
      onPlatformChange={changePlatform}
      onAccountChange={changeAccount}
      onSectionChange={setActiveSection}
      onRefresh={() => startLoad('replace')}
      onLoadMore={loadMore}
      onRetry={() => startLoad('replace')}
      onAcknowledge={acknowledge}
    />
  )
}

function formatAlertTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

function AlertNotice({
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

function AlertRow({
  item,
  role,
  acknowledgementBusy,
  acknowledging,
  acknowledgementError,
  onAcknowledge,
}: {
  item: KeywordAlertListItem
  role: Role
  acknowledgementBusy: boolean
  acknowledging: boolean
  acknowledgementError: string | null
  onAcknowledge(): void
}) {
  const canAcknowledge = role !== 'auditor'
    && item.requiresAcknowledgement
    && item.acknowledgedAt === null
  return (
    <article style={alertRowStyle}>
      <div style={alertRowHeaderStyle}>
        <span style={{
          ...severityStyle,
          color: SEVERITY_COLOR[item.severity],
          borderColor: SEVERITY_COLOR[item.severity],
        }}>
          {SEVERITY_LABEL[item.severity]}
        </span>
        <time dateTime={item.matchedAt} style={mutedTextStyle}>{formatAlertTime(item.matchedAt)}</time>
      </div>
      <div style={alertTitleStyle}>
        {item.conversationDisplayName ?? '未命名会话'}
      </div>
      <div style={mutedTextStyle}>
        {PLATFORM_LABEL[item.platform] ?? item.platform} · {item.accountDisplayName}
      </div>
      <div style={keywordStyle}>命中关键词：<span className="ih-selectable">{item.pattern}</span></div>
      {item.messageDeleted ? (
        <div style={deletedStyle}>原消息已删除</div>
      ) : (
        <>
          <div className="ih-selectable" style={excerptStyle}>{item.excerpt ?? '当前消息没有可显示的正文'}</div>
          {item.messageChangedAfterMatch && <div style={editedStyle}>命中后已编辑</div>}
        </>
      )}
      {canAcknowledge && (
        <div style={acknowledgeStyle}>
          {acknowledgementError && <span role="alert" style={ackErrorStyle}>{acknowledgementError}</span>}
          <button
            className="ih-btn"
            type="button"
            data-acknowledge-button={item.alertId}
            disabled={acknowledgementBusy}
            onClick={onAcknowledge}
            style={primaryButtonStyle}
          >
            {acknowledging
              ? '正在确认…'
              : acknowledgementBusy
                ? '等待当前确认…'
              : acknowledgementError
                ? '重试确认'
                : '确认告警'}
          </button>
        </div>
      )}
      {item.acknowledgedAt && (
        <div style={acknowledgedStyle}>已确认 · {formatAlertTime(item.acknowledgedAt)}</div>
      )}
    </article>
  )
}

export function KeywordAlertContent({
  state,
  role,
  status,
  severity,
  platform,
  accountId,
  accounts,
  activeSection,
  ruleManager,
  onStatusChange,
  onSeverityChange,
  onPlatformChange,
  onAccountChange,
  onSectionChange,
  onRefresh,
  onLoadMore,
  onRetry,
  onAcknowledge,
}: KeywordAlertContentProps) {
  const showRules = role === 'owner' && activeSection === 'rules'
  const firstLoading = !state.hasLoaded && !state.error

  return (
    <section style={shellStyle}>
      <header style={headerStyle}>
        <div>
          <h2 style={titleStyle}>关键词告警</h2>
          <div style={subtitleStyle}>仅显示当前账号权限范围内的客户入站告警</div>
        </div>
        {!showRules && (
          <button className="ih-btn" type="button" onClick={onRefresh} style={secondaryButtonStyle}>
            {state.activeLoad?.mode === 'replace' && state.hasLoaded ? '正在刷新…' : '刷新'}
          </button>
        )}
      </header>

      {role === 'owner' && (
        <nav aria-label="关键词告警页面" style={sectionTabsStyle}>
          <button
            className="ih-tab"
            type="button"
            aria-pressed={!showRules}
            onClick={() => onSectionChange('alerts')}
            style={sectionTabStyle(!showRules)}
          >
            告警列表
          </button>
          <button
            className="ih-tab"
            type="button"
            aria-pressed={showRules}
            onClick={() => onSectionChange('rules')}
            style={sectionTabStyle(showRules)}
          >
            规则管理
          </button>
        </nav>
      )}

      {showRules ? ruleManager : (
        <>
          <div style={filterAreaStyle}>
            <div role="group" aria-label="告警状态" style={statusTabsStyle}>
              {role === 'auditor' ? (
                <button className="ih-tab" type="button" aria-pressed style={statusTabStyle(true)}>
                  全部告警
                </button>
              ) : (
                <>
                  <StatusTab value="pending" current={status} onChange={onStatusChange}>未确认</StatusTab>
                  <StatusTab value="acknowledged" current={status} onChange={onStatusChange}>已确认</StatusTab>
                  <StatusTab value="all" current={status} onChange={onStatusChange}>全部告警</StatusTab>
                </>
              )}
            </div>
            <div style={filterControlsStyle}>
              <select
                aria-label="等级筛选"
                value={severity ?? ''}
                onChange={event => onSeverityChange(
                  event.currentTarget.value === ''
                    ? null
                    : event.currentTarget.value as KeywordAlertSeverity,
                )}
                style={controlStyle}
              >
                <option value="">全部等级</option>
                <option value="normal">普通</option>
                <option value="important">重要</option>
                <option value="urgent">紧急</option>
              </select>
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
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>{account.display_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="ih-scroll" style={timelineStyle}>
            {firstLoading ? (
              <AlertNotice>正在加载关键词告警…</AlertNotice>
            ) : state.error && !state.hasLoaded ? (
              <AlertNotice tone="error">
                {state.error}
                <button className="ih-btn" type="button" onClick={onRetry} style={inlineButtonStyle}>
                  重试
                </button>
              </AlertNotice>
            ) : (
              <>
                {state.error && state.hasLoaded && (
                  <AlertNotice tone="error">
                    {state.error}
                    <button className="ih-btn" type="button" onClick={onRetry} style={inlineButtonStyle}>
                      重试
                    </button>
                  </AlertNotice>
                )}
                {state.hasLoaded && state.items.length === 0 && !state.error ? (
                  <AlertNotice>当前没有关键词告警</AlertNotice>
                ) : (
                  <div style={alertListStyle}>
                    {state.items.map(item => (
                      <AlertRow
                        key={item.alertId}
                        item={item}
                        role={role}
                        acknowledgementBusy={state.acknowledgingAlertId !== null}
                        acknowledging={state.acknowledgingAlertId === item.alertId}
                        acknowledgementError={state.ackError?.alertId === item.alertId
                          ? state.ackError.message
                          : null}
                        onAcknowledge={() => onAcknowledge(item.alertId)}
                      />
                    ))}
                    {state.appendError && (
                      <AlertNotice tone="error">
                        {state.appendError}
                        <button className="ih-btn" type="button" onClick={onLoadMore} style={inlineButtonStyle}>
                          重试加载更多
                        </button>
                      </AlertNotice>
                    )}
                    {!state.appendError && state.activeLoad?.mode === 'append' && (
                      <AlertNotice>正在加载更多…</AlertNotice>
                    )}
                    {!state.appendError && state.nextCursor && !state.activeLoad && (
                      <button className="ih-btn" type="button" onClick={onLoadMore} style={loadMoreButtonStyle}>
                        加载更多
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function StatusTab({
  value,
  current,
  onChange,
  children,
}: {
  value: KeywordAlertStatusFilter
  current: KeywordAlertStatusFilter
  onChange(value: KeywordAlertStatusFilter): void
  children: string
}) {
  const active = current === value
  return (
    <button
      className="ih-tab"
      type="button"
      aria-pressed={active}
      onClick={() => onChange(value)}
      style={statusTabStyle(active)}
    >
      {children}
    </button>
  )
}

const shellStyle: CSSProperties = {
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
  gap: theme.space.md,
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

const sectionTabsStyle: CSSProperties = {
  display: 'flex',
  gap: theme.space.xs,
  padding: `${theme.space.sm}px ${theme.space.xl}px 0`,
  background: theme.color.card,
}

const sectionTabStyle = (active: boolean): CSSProperties => ({
  padding: '8px 14px',
  border: 0,
  borderBottom: `2px solid ${active ? theme.color.ink : 'transparent'}`,
  background: 'transparent',
  color: active ? theme.color.text : theme.color.textMuted,
  fontWeight: active ? theme.font.weight.bold : theme.font.weight.medium,
})

const filterAreaStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: theme.space.sm,
  padding: theme.space.md,
  borderBottom: `1px solid ${theme.color.border}`,
  background: theme.color.card,
}

const statusTabsStyle: CSSProperties = {
  display: 'flex',
  gap: theme.space.xs,
}

const statusTabStyle = (active: boolean): CSSProperties => ({
  padding: '8px 12px',
  border: `1px solid ${active ? theme.color.ink : theme.color.borderStrong}`,
  borderRadius: theme.radius.pill,
  background: active ? theme.color.ink : theme.color.card,
  color: active ? theme.color.onInk : theme.color.text,
  fontWeight: theme.font.weight.bold,
})

const filterControlsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: theme.space.sm,
}

const controlStyle: CSSProperties = {
  minWidth: 140,
  padding: '8px 10px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.white,
  color: theme.color.text,
  font: 'inherit',
}

const timelineStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: theme.space.lg,
}

const alertListStyle: CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: theme.space.md,
}

const alertRowStyle: CSSProperties = {
  padding: theme.space.lg,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
  background: theme.color.card,
  boxShadow: theme.shadow.sm,
}

const alertRowHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: theme.space.sm,
}

const severityStyle: CSSProperties = {
  padding: '2px 8px',
  border: '1px solid',
  borderRadius: theme.radius.pill,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.bold,
}

const mutedTextStyle: CSSProperties = {
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
}

const alertTitleStyle: CSSProperties = {
  marginTop: theme.space.sm,
  fontSize: theme.font.size.md,
  fontWeight: theme.font.weight.heavy,
}

const keywordStyle: CSSProperties = {
  marginTop: theme.space.md,
  fontSize: theme.font.size.sm,
  fontWeight: theme.font.weight.bold,
}

const excerptStyle: CSSProperties = {
  marginTop: theme.space.sm,
  padding: theme.space.md,
  borderRadius: theme.radius.md,
  background: theme.color.surface,
  color: theme.color.text,
  fontSize: theme.font.size.sm,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const deletedStyle: CSSProperties = {
  marginTop: theme.space.sm,
  color: theme.color.danger,
  fontSize: theme.font.size.sm,
}

const editedStyle: CSSProperties = {
  marginTop: theme.space.xs,
  color: theme.color.gold,
  fontSize: theme.font.size.xs,
}

const acknowledgeStyle: CSSProperties = {
  marginTop: theme.space.md,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: theme.space.sm,
}

const ackErrorStyle: CSSProperties = {
  color: theme.color.danger,
  fontSize: theme.font.size.xs,
}

const acknowledgedStyle: CSSProperties = {
  marginTop: theme.space.md,
  color: theme.color.green,
  fontSize: theme.font.size.xs,
  textAlign: 'right',
}

const primaryButtonStyle: CSSProperties = {
  minHeight: 34,
  padding: '0 12px',
  border: 0,
  borderRadius: theme.radius.md,
  background: theme.color.ink,
  color: theme.color.onInk,
  fontWeight: theme.font.weight.bold,
}

const secondaryButtonStyle: CSSProperties = {
  minHeight: 34,
  padding: '0 12px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.card,
  color: theme.color.text,
}

const inlineButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  marginLeft: theme.space.sm,
}

const loadMoreButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  alignSelf: 'center',
}
