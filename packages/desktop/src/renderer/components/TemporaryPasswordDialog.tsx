import { useEffect, useRef, useState } from 'react'
import { theme } from '../theme.js'

interface ClipboardWriter { writeText(value: string): Promise<void> }

export function copyTemporaryPassword(value: string, clipboard: ClipboardWriter): Promise<void> {
  return clipboard.writeText(value)
}

export function closeTemporaryPassword(clear: () => void, close: () => void): void {
  clear()
  close()
}

export function TemporaryPasswordDialog({
  temporaryPassword,
  expiresAt,
  onClear,
  onClose,
}: {
  temporaryPassword: string
  expiresAt: string
  onClear(): void
  onClose(): void
}) {
  const secret = useRef(temporaryPassword)
  const [copied, setCopied] = useState(false)
  useEffect(() => () => { secret.current = '' }, [])

  function close(): void {
    secret.current = ''
    closeTemporaryPassword(onClear, onClose)
  }

  return <TemporaryPasswordDialogContent
    temporaryPassword={temporaryPassword}
    expiresAt={expiresAt}
    copied={copied}
    onCopy={() => {
      const clipboard = navigator.clipboard
      if (!clipboard) return
      void copyTemporaryPassword(secret.current, clipboard).then(() => setCopied(true))
    }}
    onClose={close}
  />
}

export function TemporaryPasswordDialogContent({
  temporaryPassword,
  expiresAt,
  copied,
  onCopy,
  onClose,
}: {
  temporaryPassword: string
  expiresAt: string
  copied: boolean
  onCopy(): void
  onClose(): void
}) {
  return (
    <div style={overlayStyle} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="临时密码" style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: theme.font.size.lg }}>临时密码</h2>
        <p style={{ color: theme.color.textMuted }}>仅显示这一次。员工首次登录后必须立即设置新密码。</p>
        <code className="ih-selectable" style={passwordStyle}>{temporaryPassword}</code>
        <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint, marginTop: 8 }}>
          有效期至 {expiresAt}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="ih-btn" type="button" onClick={onCopy}>{copied ? '已复制' : '复制'}</button>
          <button className="ih-btn" type="button" onClick={onClose}
            style={{ background: theme.color.ink, color: theme.color.lime }}>我已保存，关闭</button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 120, display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: 'rgba(35,37,35,.38)',
}
const dialogStyle: React.CSSProperties = {
  width: 460, maxWidth: '90vw', padding: 24, borderRadius: theme.radius.xl,
  background: theme.color.card, color: theme.color.text, boxShadow: theme.shadow.lg,
}
const passwordStyle: React.CSSProperties = {
  display: 'block', padding: '14px 16px', borderRadius: theme.radius.md,
  background: theme.color.surface, color: theme.color.text, fontSize: theme.font.size.md,
  wordBreak: 'break-all',
}
