import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  CUSTOMER_PROFILE_MAX_CODE_POINTS,
  type CustomerProfileField,
} from '@im-hub/shared'
import { api, HttpError, NetworkError } from '../api/client.js'
import {
  initialCustomerProfileEditorState,
  reduceCustomerProfileEditor,
  type CustomerProfileEditorState,
} from '../customer-profile-editor.js'
import { theme } from '../theme.js'
import { Chip, SectionTitle } from './ui.js'

const PROFILE_FIELDS: ReadonlyArray<{
  key: CustomerProfileField
  label: string
  hint: string
  singleLine: boolean
}> = [
  { key: 'name', label: '姓名', hint: '客户自称或签名里出现的名字', singleLine: true },
  { key: 'ageLocation', label: '年龄 / 居住地', hint: '年龄段、城市、国家或时区', singleLine: false },
  { key: 'occupation', label: '职业 / 退休状况', hint: '在职、行业，或已退休', singleLine: false },
  { key: 'family', label: '家庭 / 婚姻状况', hint: '同住家人、子女、婚姻', singleLine: false },
  { key: 'interests', label: '兴趣', hint: '反复提到的爱好与话题', singleLine: false },
  { key: 'other', label: '其他', hint: '不属于以上几类但值得记的', singleLine: false },
]

export function customerProfileErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) return '连不上服务端，请稍后重试'
  if (error instanceof HttpError && error.status === 403) return '当前账号只有只读权限'
  if (error instanceof HttpError && error.status === 404) return '当前会话不可见或已被删除'
  return '客户档案操作失败，请稍后重试'
}

export interface CustomerProfileSaveAttempt {
  conversationId: string
  requestId: number
}

export function reserveCustomerProfileSaveAttempt(
  activeSaveRef: { current: CustomerProfileSaveAttempt | null },
  requestIdRef: { current: number },
  state: CustomerProfileEditorState,
  readOnly: boolean,
  conversationId: string,
): CustomerProfileSaveAttempt | null {
  if (readOnly
    || state.status !== 'editing'
    || state.conversationId !== conversationId
    || !state.snapshot
    || state.activeLoad
    || state.activeSave
    || activeSaveRef.current) return null

  const attempt = {
    conversationId,
    requestId: requestIdRef.current + 1,
  }
  requestIdRef.current = attempt.requestId
  activeSaveRef.current = attempt
  return attempt
}

export function CustomerProfileSection({
  conversationId,
  readOnly,
}: {
  conversationId: string
  readOnly: boolean
}) {
  const [state, dispatch] = useReducer(
    reduceCustomerProfileEditor,
    initialCustomerProfileEditorState(),
  )
  const requestIdRef = useRef(0)
  const saveRequestIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const activeConversationIdRef = useRef(conversationId)
  const activeSaveRef = useRef<CustomerProfileSaveAttempt | null>(null)
  activeConversationIdRef.current = conversationId

  const loadProfile = useCallback((
    targetConversationId: string,
    mode: 'replace' | 'conflict',
  ) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const requestId = ++requestIdRef.current
    dispatch({
      type: 'load.started',
      conversationId: targetConversationId,
      requestId,
      mode,
    })
    void api.getCustomerProfile(targetConversationId, controller.signal).then(profile => {
      dispatch({
        type: 'load.succeeded',
        conversationId: targetConversationId,
        requestId,
        mode,
        profile,
      })
    }).catch(error => {
      if (controller.signal.aborted) return
      dispatch({
        type: 'load.failed',
        conversationId: targetConversationId,
        requestId,
        mode,
        message: customerProfileErrorMessage(error),
      })
    })
  }, [])

  useEffect(() => {
    dispatch({ type: 'conversation.changed', conversationId })
    loadProfile(conversationId, 'replace')
    return () => {
      controllerRef.current?.abort()
      activeSaveRef.current = null
    }
  }, [conversationId, loadProfile])

  const save = useCallback(async () => {
    const snapshot = state.snapshot
    const attempt = reserveCustomerProfileSaveAttempt(
      activeSaveRef,
      saveRequestIdRef,
      state,
      readOnly,
      conversationId,
    )
    if (!attempt || !snapshot) return

    const capturedConversationId = attempt.conversationId
    const requestId = attempt.requestId
    const update = {
      ...state.draft,
      expectedRevision: snapshot.revision,
    }
    dispatch({ type: 'save.started', conversationId: capturedConversationId, requestId })
    try {
      const profile = await api.updateCustomerProfile(capturedConversationId, update)
      if (activeConversationIdRef.current !== capturedConversationId
        || activeSaveRef.current?.conversationId !== capturedConversationId
        || activeSaveRef.current.requestId !== requestId) return
      activeSaveRef.current = null
      dispatch({
        type: 'save.succeeded',
        conversationId: capturedConversationId,
        requestId,
        profile,
      })
    } catch (error) {
      if (activeConversationIdRef.current !== capturedConversationId
        || activeSaveRef.current?.conversationId !== capturedConversationId
        || activeSaveRef.current.requestId !== requestId) return
      activeSaveRef.current = null
      if (error instanceof HttpError && error.status === 409) {
        loadProfile(capturedConversationId, 'conflict')
        return
      }
      dispatch({
        type: 'save.failed',
        conversationId: capturedConversationId,
        requestId,
        message: customerProfileErrorMessage(error),
      })
    }
  }, [conversationId, loadProfile, readOnly, state.activeLoad, state.draft, state.snapshot, state.status])

  const retry = useCallback(() => {
    if (!state.retryLoadMode || activeConversationIdRef.current !== conversationId) return
    loadProfile(conversationId, state.retryLoadMode)
  }, [conversationId, loadProfile, state.retryLoadMode])

  return (
    <CustomerProfileSectionView
      state={state}
      conversationId={conversationId}
      readOnly={readOnly}
      onEdit={() => dispatch({ type: 'edit.started' })}
      onCancel={() => dispatch({ type: 'edit.cancelled' })}
      onSave={() => { void save() }}
      onRetry={retry}
      onFieldChange={(field, value) => dispatch({ type: 'draft.changed', field, value })}
    />
  )
}

export function CustomerProfileSectionView({
  state,
  conversationId,
  readOnly,
  onEdit,
  onCancel,
  onSave,
  onRetry,
  onFieldChange,
}: {
  state: CustomerProfileEditorState
  conversationId: string
  readOnly: boolean
  onEdit(): void
  onCancel(): void
  onSave(): void
  onRetry(): void
  onFieldChange(field: CustomerProfileField, value: string): void
}) {
  if (state.conversationId !== conversationId) {
    return (
      <section>
        <SectionTitle extra={readOnly ? <Chip>只读</Chip> : undefined}>客户档案</SectionTitle>
        <ProfileNotice>正在加载客户档案…</ProfileNotice>
      </section>
    )
  }

  const editing = state.status === 'editing' || state.status === 'saving'
  const busy = state.status === 'saving' || state.activeLoad !== null

  return (
    <section>
      <SectionTitle extra={readOnly ? <Chip>只读</Chip> : undefined}>客户档案</SectionTitle>
      {state.status === 'loading' && !state.snapshot ? (
        <ProfileNotice>正在加载客户档案…</ProfileNotice>
      ) : state.status === 'failed' && !state.snapshot ? (
        <ProfileNotice tone="error">
          {state.error}
          {state.retryLoadMode && (
            <button className="ih-btn" onClick={onRetry} style={retryButtonStyle}>重试加载</button>
          )}
        </ProfileNotice>
      ) : (
        <>
          {state.error && <ProfileNotice tone="error">{state.error}</ProfileNotice>}
          {state.retryLoadMode && state.snapshot && (
            <div style={{ padding: `0 ${theme.space.lg}px ${theme.space.sm}px` }}>
              <button className="ih-btn" onClick={onRetry} style={retryButtonStyle}>
                重试加载
              </button>
            </div>
          )}
          <div style={{ padding: `0 ${theme.space.lg}px` }}>
            {PROFILE_FIELDS.map(field => (
              <div key={field.key} style={{
                padding: `${theme.space.sm}px 0`,
                borderBottom: `1px solid ${theme.color.border}`,
              }}>
                <label style={{
                  display: 'block',
                  fontSize: theme.font.size.xs,
                  color: theme.color.textMuted,
                  marginBottom: 4,
                  fontWeight: theme.font.weight.medium,
                }}>
                  {field.label}
                  {editing ? (
                    <>
                      {field.singleLine ? (
                        <input
                          aria-label={field.label}
                          value={state.draft[field.key] ?? ''}
                          maxLength={CUSTOMER_PROFILE_MAX_CODE_POINTS[field.key] * 2}
                          onChange={event => onFieldChange(field.key, event.currentTarget.value)}
                          disabled={busy}
                          placeholder={field.hint}
                          style={profileInputStyle}
                        />
                      ) : (
                        <textarea
                          aria-label={field.label}
                          value={state.draft[field.key] ?? ''}
                          maxLength={CUSTOMER_PROFILE_MAX_CODE_POINTS[field.key] * 2}
                          onChange={event => onFieldChange(field.key, event.currentTarget.value)}
                          disabled={busy}
                          placeholder={field.hint}
                          rows={2}
                          style={{ ...profileInputStyle, resize: 'vertical' }}
                        />
                      )}
                      {state.hasConflict && (
                        <span style={latestValueStyle}>
                          服务器最新：{state.snapshot?.[field.key] ?? '尚未填写'}
                        </span>
                      )}
                    </>
                  ) : (
                    <span title={field.hint} className="ih-selectable" style={{
                      display: 'block',
                      marginTop: 2,
                      fontSize: theme.font.size.base,
                      color: state.snapshot?.[field.key]
                        ? theme.color.text
                        : theme.color.textFaint,
                      fontStyle: state.snapshot?.[field.key] ? 'normal' : 'italic',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {state.snapshot?.[field.key] ?? '尚未填写'}
                    </span>
                  )}
                </label>
              </div>
            ))}
          </div>

          <div style={{
            padding: `${theme.space.lg}px`,
            display: 'flex',
            gap: theme.space.sm,
          }}>
            {editing ? (
              <>
                <button
                  className="ih-btn"
                  disabled={busy}
                  onClick={onCancel}
                  style={secondaryButtonStyle}
                >
                  取消
                </button>
                <button
                  className="ih-btn"
                  disabled={busy || readOnly}
                  onClick={onSave}
                  style={primaryButtonStyle}
                >
                  {state.status === 'saving' ? '保存中' : '保存'}
                </button>
              </>
            ) : !readOnly ? (
              <button className="ih-btn" onClick={onEdit} style={primaryButtonStyle}>
                手动补充
              </button>
            ) : null}
            <button
              className="ih-btn"
              disabled
              title="自动提取建议将在后续 M4 切片接入"
              style={secondaryButtonStyle}
            >
              重新提取（后续 M4）
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function ProfileNotice({
  children,
  tone = 'normal',
}: {
  children: React.ReactNode
  tone?: 'normal' | 'error'
}) {
  return (
    <div style={{
      margin: `0 ${theme.space.lg}px ${theme.space.md}px`,
      padding: theme.space.md,
      borderRadius: theme.radius.lg,
      background: tone === 'error' ? '#fff1ef' : theme.color.surface,
      color: tone === 'error' ? '#b84b41' : theme.color.textMuted,
      fontSize: theme.font.size.xs,
      lineHeight: 1.6,
    }}>
      {children}
    </div>
  )
}

const profileInputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 5,
  padding: '8px 10px',
  border: `1px solid ${theme.color.borderStrong}`,
  borderRadius: theme.radius.md,
  background: theme.color.card,
  color: theme.color.text,
  font: 'inherit',
  lineHeight: 1.5,
}

const primaryButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 12px',
  borderRadius: theme.radius.pill,
  border: 'none',
  background: theme.color.ink,
  color: theme.color.lime,
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.heavy,
}

const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 12px',
  borderRadius: theme.radius.pill,
  border: `1px solid ${theme.color.borderStrong}`,
  background: theme.color.card,
  color: theme.color.text,
  fontSize: theme.font.size.base,
  fontWeight: theme.font.weight.bold,
}

const retryButtonStyle: React.CSSProperties = {
  marginLeft: theme.space.sm,
  padding: '4px 9px',
  borderRadius: theme.radius.pill,
  border: `1px solid ${theme.color.borderStrong}`,
  background: theme.color.card,
  color: theme.color.text,
}

const latestValueStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 4,
  color: theme.color.textMuted,
  fontSize: theme.font.size.xs,
  fontWeight: theme.font.weight.medium,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}
