import { useState } from 'react'
import type { LoginResponse } from '@im-hub/shared'
import { api, NetworkError, UnauthorizedError } from '../api/client.js'
import { theme } from '../theme.js'

interface Props {
  onLoginSuccess(result: LoginResponse): void
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
      const result = await api.login(email.trim(), password)
      setPassword('')
      onLoginSuccess(result)
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
      background: theme.color.page,
      fontFamily: theme.font.sans,
    }}>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 380,
          background: theme.color.card,
          border: 'none',
          borderRadius: theme.radius.xxl,
          boxShadow: theme.shadow.app,
          padding: theme.space.xxl,
          boxSizing: 'border-box',
        }}
      >
        <div style={{
          fontSize: theme.font.size.xxl,
          fontWeight: theme.font.weight.heavy,
          letterSpacing: -1,
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
            padding: '11px 14px',
            fontSize: theme.font.size.md,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.lg,
            boxSizing: 'border-box',
            marginBottom: theme.space.md,
            color: theme.color.text,
            background: theme.color.white,
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
            padding: '11px 14px',
            fontSize: theme.font.size.md,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.lg,
            boxSizing: 'border-box',
            marginBottom: theme.space.lg,
            color: theme.color.text,
            background: theme.color.white,
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
            padding: '13px 0',
            fontSize: theme.font.size.md,
            fontWeight: theme.font.weight.heavy,
            color: theme.color.lime,
            background: submitting ? theme.color.accentHover : theme.color.ink,
            border: 'none',
            borderRadius: theme.radius.pill,
            cursor: submitting ? 'default' : 'pointer',
          }}
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
