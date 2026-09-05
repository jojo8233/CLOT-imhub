import { useEffect, useRef, useState } from 'react'
import type { AdminMutationPreview } from '@im-hub/shared'
import type { MutationOutcome } from '../organization-admin/employee-controller.js'
import { theme } from '../theme.js'

export function AdminConfirmationDialog({
  title,
  preview,
  outcome,
  requiresCurrentPassword = false,
  onConfirm,
  onCancel,
}: {
  title: string
  preview: AdminMutationPreview
  outcome: MutationOutcome
  requiresCurrentPassword?: boolean
  onConfirm(currentPassword?: string): void
  onCancel(): void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const secret = useRef('')
  secret.current = currentPassword
  useEffect(() => () => { secret.current = '' }, [])
  return <AdminConfirmationDialogContent
    title={title}
    preview={preview}
    outcome={outcome}
    currentPassword={currentPassword}
    requiresCurrentPassword={requiresCurrentPassword}
    onCurrentPassword={setCurrentPassword}
    onConfirm={() => onConfirm(requiresCurrentPassword ? currentPassword : undefined)}
    onCancel={() => {
      secret.current = ''
      setCurrentPassword('')
      onCancel()
    }}
  />
}

export function AdminConfirmationDialogContent({
  title,
  preview,
  outcome,
  currentPassword,
  requiresCurrentPassword,
  onCurrentPassword,
  onConfirm,
  onCancel,
}: {
  title: string
  preview: AdminMutationPreview
  outcome: MutationOutcome
  currentPassword: string
  requiresCurrentPassword: boolean
  onCurrentPassword(value: string): void
  onConfirm(): void
  onCancel(): void
}) {
  const busy = outcome === 'executing' || outcome === 'unknown'
  return (
    <div style={overlayStyle} role="presentation">
      <div role="dialog" aria-modal="true" aria-label={title} style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: theme.font.size.lg }}>{title}</h2>
        <p style={{ color: theme.color.textMuted }}>请核对本次操作影响。确认后服务端仍会重新验证最新数据。</p>
        <div style={{ display: 'grid', gap: 8, margin: '16px 0' }}>
          {Object.entries(preview.summary).map(([label, count]) => (
            <div key={label} style={summaryStyle}>
              <span>{label}</span><strong>{count}</strong>
            </div>
          ))}
        </div>
        {requiresCurrentPassword && (
          <label style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
            <span style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted }}>当前 owner 密码</span>
            <input
              type="password"
              autoComplete="current-password"
              disabled={busy}
              onChange={event => onCurrentPassword(event.target.value)}
              style={inputStyle}
            />
          </label>
        )}
        {outcome === 'unknown' && (
          <div role="alert" style={noticeStyle}>网络中断，操作结果待核对；刷新完成前不能重复执行。</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="ih-btn" type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="ih-btn" type="button"
            disabled={busy || (requiresCurrentPassword && currentPassword.length < 12)}
            onClick={onConfirm} style={{ background: theme.color.ink, color: theme.color.lime }}>
            {outcome === 'executing' ? '执行中…' : outcome === 'unknown' ? '结果待核对' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 110, display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: 'rgba(35,37,35,.34)',
}
const dialogStyle: React.CSSProperties = {
  width: 430, maxWidth: '90vw', padding: 24, borderRadius: theme.radius.xl,
  background: theme.color.card, color: theme.color.text, boxShadow: theme.shadow.lg,
}
const summaryStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', padding: '9px 12px',
  borderRadius: theme.radius.md, background: theme.color.surface,
}
const inputStyle: React.CSSProperties = {
  padding: '10px 12px', border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md, background: theme.color.white,
}
const noticeStyle: React.CSSProperties = {
  marginBottom: 12, padding: '8px 10px', color: theme.color.danger,
  background: theme.color.dangerSoft, borderRadius: theme.radius.sm,
}
