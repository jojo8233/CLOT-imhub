import { useEffect, useReducer, useRef, useState } from 'react'
import { api, NetworkError, UnauthorizedError, type SessionUser } from '../api/client.js'
import { theme } from '../theme.js'

export interface PasswordFormState {
  newPassword: string
  confirmPassword: string
}

export type PasswordFormAction =
  | { type: 'new'; value: string }
  | { type: 'confirm'; value: string }
  | { type: 'clear' }

const EMPTY_PASSWORDS: PasswordFormState = { newPassword: '', confirmPassword: '' }

export function passwordFormReducer(
  state: PasswordFormState,
  action: PasswordFormAction,
): PasswordFormState {
  if (action.type === 'new') return { ...state, newPassword: action.value }
  if (action.type === 'confirm') return { ...state, confirmPassword: action.value }
  return EMPTY_PASSWORDS
}

export function passwordChangeError(newPassword: string, confirmPassword: string): string | null {
  const length = Array.from(newPassword).length
  if (length < 12 || length > 128) return '新密码必须为 12–128 个字符'
  if (newPassword !== confirmPassword) return '两次输入的新密码不一致'
  return null
}

export function InitialPasswordPage({
  displayName,
  onCompleted,
  onBackToLogin,
}: {
  displayName: string
  onCompleted(user: SessionUser): void
  onBackToLogin(): void
}) {
  const [passwords, dispatch] = useReducer(passwordFormReducer, EMPTY_PASSWORDS)
  const secrets = useRef(passwords)
  secrets.current = passwords
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => { secrets.current = EMPTY_PASSWORDS }, [])

  async function submit(): Promise<void> {
    if (submitting) return
    const validation = passwordChangeError(passwords.newPassword, passwords.confirmPassword)
    if (validation) {
      setError(validation)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const user = await api.completeInitialPassword(passwords.newPassword)
      dispatch({ type: 'clear' })
      secrets.current = EMPTY_PASSWORDS
      onCompleted(user)
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        setError('临时密码已失效，请返回登录页重新登录')
      } else if (cause instanceof NetworkError) {
        setError('连不上服务端，请返回登录页后重试')
      } else {
        setError(cause instanceof Error ? cause.message : '设置新密码失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return <InitialPasswordPageContent
    displayName={displayName}
    newPassword={passwords.newPassword}
    confirmPassword={passwords.confirmPassword}
    submitting={submitting}
    error={error}
    onNewPassword={value => dispatch({ type: 'new', value })}
    onConfirmPassword={value => dispatch({ type: 'confirm', value })}
    onSubmit={() => void submit()}
    onBackToLogin={() => {
      dispatch({ type: 'clear' })
      secrets.current = EMPTY_PASSWORDS
      onBackToLogin()
    }}
  />
}

export function InitialPasswordPageContent({
  displayName,
  newPassword,
  confirmPassword,
  submitting,
  error,
  onNewPassword,
  onConfirmPassword,
  onSubmit,
  onBackToLogin,
}: {
  displayName: string
  newPassword: string
  confirmPassword: string
  submitting: boolean
  error: string | null
  onNewPassword(value: string): void
  onConfirmPassword(value: string): void
  onSubmit(): void
  onBackToLogin?(): void
}) {
  return (
    <div style={pageStyle}>
      <form onSubmit={(event) => { event.preventDefault(); onSubmit() }} style={cardStyle}>
        <h1 style={titleStyle}>首次登录，请设置新密码</h1>
        <p style={descriptionStyle}>你好，{displayName}。新密码需为 12–128 个字符，设置完成后才能进入工作台。</p>
        <PasswordInput
          label="新密码"
          value={newPassword}
          disabled={submitting}
          autoFocus
          onChange={onNewPassword}
        />
        <PasswordInput
          label="再次输入新密码"
          value={confirmPassword}
          disabled={submitting}
          onChange={onConfirmPassword}
        />
        {error && <div role="alert" style={errorStyle}>{error}</div>}
        <button type="submit" disabled={submitting || !newPassword || !confirmPassword} style={primaryStyle}>
          {submitting ? '设置中…' : '设置密码并进入'}
        </button>
        {onBackToLogin && (
          <button type="button" disabled={submitting} onClick={onBackToLogin} style={secondaryStyle}>
            返回登录
          </button>
        )}
      </form>
    </div>
  )
}

function PasswordInput({
  label, value, disabled, autoFocus = false, onChange,
}: {
  label: string
  value: string
  disabled: boolean
  autoFocus?: boolean
  onChange(value: string): void
}) {
  return (
    <label style={labelStyle}>
      <span>{label}</span>
      <input
        type="password"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="new-password"
        onChange={event => onChange(event.target.value)}
        style={inputStyle}
      />
    </label>
  )
}

const pageStyle: React.CSSProperties = {
  height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: theme.color.page, fontFamily: theme.font.sans,
}
const cardStyle: React.CSSProperties = {
  width: 420, padding: theme.space.xxl, borderRadius: theme.radius.xxl,
  background: theme.color.card, boxShadow: theme.shadow.app, boxSizing: 'border-box',
}
const titleStyle: React.CSSProperties = {
  margin: `0 0 ${theme.space.sm}px`, fontSize: theme.font.size.xl, color: theme.color.text,
}
const descriptionStyle: React.CSSProperties = {
  margin: `0 0 ${theme.space.xl}px`, color: theme.color.textMuted, lineHeight: 1.6,
}
const labelStyle: React.CSSProperties = {
  display: 'grid', gap: theme.space.xs, marginBottom: theme.space.md,
  fontSize: theme.font.size.sm, color: theme.color.textMuted,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 14px', border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg, boxSizing: 'border-box', background: theme.color.white,
  color: theme.color.text, fontSize: theme.font.size.md,
}
const errorStyle: React.CSSProperties = {
  marginBottom: theme.space.md, padding: '8px 10px', borderRadius: theme.radius.sm,
  color: theme.color.danger, background: theme.color.dangerSoft, fontSize: theme.font.size.sm,
}
const primaryStyle: React.CSSProperties = {
  width: '100%', padding: '12px 0', border: 0, borderRadius: theme.radius.pill,
  background: theme.color.ink, color: theme.color.lime, fontWeight: theme.font.weight.heavy,
}
const secondaryStyle: React.CSSProperties = {
  width: '100%', marginTop: theme.space.sm, padding: '9px 0', border: 0,
  background: 'transparent', color: theme.color.textMuted,
}
