import { useState } from 'react'
import { api, NetworkError, UnauthorizedError, type SessionUser } from '../api/client.js'
import { theme } from '../theme.js'

interface Props {
  onLoginSuccess(user: SessionUser): void
}

export function LoginPage({ onLoginSuccess }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (submitting || email.trim() === '' || password === '') return
    setSubmitting(true)
    setError(null)
    try {
      const user = await api.login(email.trim(), password)
      onLoginSuccess(user)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setError('邮箱或密码不对')
      } else if (err instanceof NetworkError) {
        setError('连不上服务端，检查它是否在运行')
      } else {
        setError(err instanceof Error ? err.message : '登录失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: theme.color.surface,
      fontFamily: theme.font.sans,
    }}>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 360,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          borderRadius: theme.radius.lg,
          boxShadow: theme.shadow.lg,
          padding: theme.space.xxl,
          boxSizing: 'border-box',
        }}
      >
        <div style={{
          fontSize: theme.font.size.xl,
          fontWeight: 700,
          color: theme.color.text,
          marginBottom: theme.space.xs,
        }}>
          im-hub
        </div>
        <div style={{
          fontSize: theme.font.size.base,
          color: theme.color.textMuted,
          marginBottom: theme.space.xl,
        }}>
          跨境客服工作台
        </div>

        <label style={{
          display: 'block',
          fontSize: theme.font.size.sm,
          color: theme.color.textMuted,
          marginBottom: theme.space.xs,
        }}>
          邮箱
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          disabled={submitting}
          placeholder="you@example.com"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: theme.font.size.md,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.sm,
            boxSizing: 'border-box',
            marginBottom: theme.space.md,
            color: theme.color.text,
            background: theme.color.bg,
          }}
        />

        <label style={{
          display: 'block',
          fontSize: theme.font.size.sm,
          color: theme.color.textMuted,
          marginBottom: theme.space.xs,
        }}>
          密码
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          placeholder="••••••••"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: theme.font.size.md,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.sm,
            boxSizing: 'border-box',
            marginBottom: theme.space.lg,
            color: theme.color.text,
            background: theme.color.bg,
          }}
        />

        {error && (
          <div style={{
            fontSize: theme.font.size.sm,
            color: theme.color.danger,
            background: theme.color.dangerSoft,
            borderRadius: theme.radius.sm,
            padding: '8px 10px',
            marginBottom: theme.space.md,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || email.trim() === '' || password === ''}
          style={{
            width: '100%',
            padding: '10px 0',
            fontSize: theme.font.size.md,
            fontWeight: 600,
            color: '#ffffff',
            background: submitting ? theme.color.accentHover : theme.color.accent,
            border: 'none',
            borderRadius: theme.radius.sm,
            cursor: submitting ? 'default' : 'pointer',
          }}
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
