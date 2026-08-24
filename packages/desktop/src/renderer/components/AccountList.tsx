import { useStore } from '../store.js'
import { theme } from '../theme.js'

const STATUS_COLOR: Record<string, string> = theme.color.status

interface Props {
  /** null = 还没拿到（理论上不该发生：走到主界面时一定已经登录），照样兜底不崩。 */
  currentUserName?: string | null
  onLogout?(): void
}

export function AccountList({ currentUserName, onLogout }: Props) {
  const accounts = useStore(s => s.accounts)
  return (
    <aside style={{
      width: 220, borderRight: `1px solid ${theme.color.border}`, overflowY: 'auto',
      display: 'flex', flexDirection: 'column', background: theme.color.bg,
    }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {accounts.map(a => (
          <div key={a.id} style={{ padding: '10px 12px', display: 'flex', gap: theme.space.sm, alignItems: 'center' }}>
            <span style={{
              width: 8, height: 8, borderRadius: 4, flexShrink: 0,
              background: STATUS_COLOR[a.status] ?? theme.color.status.pending_auth,
            }} />
            <div>
              <div style={{ fontSize: theme.font.size.base, color: theme.color.text }}>{a.display_name}</div>
              <div style={{ fontSize: theme.font.size.xs, color: theme.color.textMuted }}>{a.platform}</div>
              {a.history_available_from && (
                <div style={{ fontSize: theme.font.size.xs - 1, color: theme.color.status.degraded }}>
                  历史起始 {a.history_available_from.slice(0, 10)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {/* 左下角当前用户 + 登出。下个任务统一重排主界面布局时再收拾样式。 */}
      <div style={{
        borderTop: `1px solid ${theme.color.border}`, padding: '8px 12px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm,
      }}>
        <span style={{
          fontSize: theme.font.size.xs, color: theme.color.textMuted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {currentUserName ?? ''}
        </span>
        <button
          onClick={onLogout}
          style={{
            fontSize: theme.font.size.xs, padding: '2px 8px', cursor: 'pointer',
            color: theme.color.textMuted, background: theme.color.surface,
            border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.sm,
          }}
        >
          登出
        </button>
      </div>
    </aside>
  )
}
