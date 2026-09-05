import { useEffect, useReducer, useRef, useState } from 'react'
import { api, HttpError, NetworkError, type SessionUser } from '../api/client.js'
import { theme } from '../theme.js'
import { passwordChangeError } from './InitialPasswordPage.js'

export interface ChangePasswordFormState {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

export type ChangePasswordFormAction =
  | { type: 'current'; value: string }
  | { type: 'new'; value: string }
  | { type: 'confirm'; value: string }
  | { type: 'clear' }

const EMPTY_PASSWORDS: ChangePasswordFormState = {
  currentPassword: '', newPassword: '', confirmPassword: '',
}

export function changePasswordFormReducer(
  state: ChangePasswordFormState,
  action: ChangePasswordFormAction,
): ChangePasswordFormState {
  if (action.type === 'current') return { ...state, currentPassword: action.value }
  if (action.type === 'new') return { ...state, newPassword: action.value }
  if (action.type === 'confirm') return { ...state, confirmPassword: action.value }
  return EMPTY_PASSWORDS
}

export function ChangePasswordDialog({
  onChanged,
  onClose,
}: {
  onChanged(user: SessionUser): void
  onClose(): void
}) {
  const [passwords, dispatch] = useReducer(changePasswordFormReducer, EMPTY_PASSWORDS)
  const secrets = useRef(passwords)
  secrets.current = passwords
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => { secrets.current = EMPTY_PASSWORDS }, [])

  function close(): void {
    if (submitting) return
    dispatch({ type: 'clear' })
    secrets.current = EMPTY_PASSWORDS
    onClose()
  }

  async function submit(): Promise<void> {
    if (submitting || passwords.currentPassword === '') return
    const validation = passwordChangeError(passwords.newPassword, passwords.confirmPassword)
    if (validation) {
      setError(validation)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const user = await api.changePassword(passwords.currentPassword, passwords.newPassword)
      dispatch({ type: 'clear' })
      secrets.current = EMPTY_PASSWORDS
      onChanged(user)
      onClose()
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 403) {
        setError('当前密码不正确')
      } else if (cause instanceof NetworkError) {
        setError('连不上服务端，请稍后重试')
      } else {
        setError(cause instanceof Error ? cause.message : '修改密码失败')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return <ChangePasswordDialogContent
    currentPassword={passwords.currentPassword}
    newPassword={passwords.newPassword}
    confirmPassword={passwords.confirmPassword}
    submitting={submitting}
    error={error}
    onCurrentPassword={value => dispatch({ type: 'current', value })}
    onNewPassword={value => dispatch({ type: 'new', value })}
    onConfirmPassword={value => dispatch({ type: 'confirm', value })}
    onSubmit={() => void submit()}
    onClose={close}
  />
}

export function ChangePasswordDialogContent({
  currentPassword,
  newPassword,
  confirmPassword,
  submitting,
  error,
  onCurrentPassword,
  onNewPassword,
  onConfirmPassword,
  onSubmit,
  onClose,
}: {
  currentPassword: string
  newPassword: string
  confirmPassword: string
  submitting: boolean
  error: string | null
  onCurrentPassword(value: string): void
  onNewPassword(value: string): void
  onConfirmPassword(value: string): void
  onSubmit(): void
  onClose(): void
}) {
  return (
    <div role="presentation" style={overlayStyle} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <form role="dialog" aria-modal="true" aria-label="修改密码"
        onSubmit={(event) => { event.preventDefault(); onSubmit() }} style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: theme.font.size.lg }}>修改密码</h2>
        <p style={{ margin: `${theme.space.sm}px 0 ${theme.space.lg}px`, color: theme.color.textMuted }}>
          修改后其他已登录会话会立即失效。
        </p>
        <DialogPasswordInput label="当前密码" value={currentPassword} disabled={submitting}
          autoComplete="current-password" onChange={onCurrentPassword} />
        <DialogPasswordInput label="新密码（12–128 个字符）" value={newPassword} disabled={submitting}
          autoComplete="new-password" onChange={onNewPassword} />
        <DialogPasswordInput label="再次输入新密码" value={confirmPassword} disabled={submitting}
          autoComplete="new-password" onChange={onConfirmPassword} />
        {error && <div role="alert" style={errorStyle}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space.sm }}>
          <button type="button" disabled={submitting} onClick={onClose} className="ih-btn">取消</button>
          <button type="submit" disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
            className="ih-btn" style={{ background: theme.color.ink, color: theme.color.lime }}>
            {submitting ? '保存中…' : '保存新密码'}
          </button>
        </div>
      </form>
    </div>
  )
}

function DialogPasswordInput({
  label, value, disabled, autoComplete, onChange,
}: {
  label: string
  value: string
  disabled: boolean
  autoComplete: 'current-password' | 'new-password'
  onChange(value: string): void
}) {
  return (
    <label style={{ display: 'grid', gap: 4, marginBottom: 12, color: theme.color.textMuted }}>
      <span style={{ fontSize: theme.font.size.sm }}>{label}</span>
      <input type="password" value={value} disabled={disabled} autoComplete={autoComplete}
        onChange={event => onChange(event.target.value)} style={inputStyle} />
    </label>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: 'rgba(35,37,35,.34)', fontFamily: theme.font.sans,
}
const dialogStyle: React.CSSProperties = {
  width: 420, padding: theme.space.xl, borderRadius: theme.radius.xl,
  background: theme.color.card, boxShadow: theme.shadow.lg, color: theme.color.text,
}
const inputStyle: React.CSSProperties = {
  padding: '10px 12px', border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md, background: theme.color.white, color: theme.color.text,
}
const errorStyle: React.CSSProperties = {
  marginBottom: theme.space.md, padding: '8px 10px', borderRadius: theme.radius.sm,
  color: theme.color.danger, background: theme.color.dangerSoft, fontSize: theme.font.size.sm,
}
