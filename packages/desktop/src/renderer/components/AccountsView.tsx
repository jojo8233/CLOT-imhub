import { useStore } from '../store.js'
import { PLATFORM_LABEL, STATUS_LABEL, theme } from '../theme.js'
import { Chip, EmptyHint, PlatformIcon, StatusDot, relativeTime } from './ui.js'

/**
 * 账号状态总览。管理员要一眼看出哪个号掉线了，所以状态放在卡片最显眼的位置，
 * 断线和降级用色块而不只是小圆点——一排绿点里混一个红点很容易被跳过。
 */
/** 在线是唯一"一切正常"的状态，只有它配得上柠檬绿；其余一律用各自的告警色 */
const online2 = (status: string): boolean => status === 'connected'

export function AccountsView({ onOpenChat, onAddAccount }: {
  onOpenChat(): void
  onAddAccount(): void
}) {
  const accounts = useStore(s => s.accounts)
  const conversations = useStore(s => s.conversations)
  const setActiveAccount = useStore(s => s.setActiveAccount)

  const online = accounts.filter(a => a.status === 'connected').length

  return (
    <div className="ih-scroll" style={{ flex: 1, minWidth: 0, background: theme.color.surface }}>
      <div style={{
        padding: `${theme.space.xl}px ${theme.space.xl}px ${theme.space.lg}px`,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy, letterSpacing: -.6 }}>账号状态</div>
          <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 3 }}>
            {accounts.length} 个账号，{online} 个在线
          </div>
        </div>
        <button
          onClick={onAddAccount}
          className="ih-btn"
          style={{
            padding: '10px 20px', borderRadius: theme.radius.pill, border: 'none',
            background: theme.color.ink, color: theme.color.lime,
            fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
          }}
        >
          + 添加账号
        </button>
      </div>

      {accounts.length === 0 ? (
        <EmptyHint>还没有账号</EmptyHint>
      ) : (
        <div style={{
          padding: `0 ${theme.space.xl}px ${theme.space.xl}px`,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: theme.space.lg,
        }}>
          {accounts.map(a => {
            const convs = conversations.filter(c => c.account_id === a.id)
            const last = convs.reduce<string | null>(
              (acc, c) => (c.last_message_at ?? '') > (acc ?? '') ? c.last_message_at : acc,
              null,
            )
            const statusColor = theme.color.status[a.status as keyof typeof theme.color.status]
              ?? theme.color.status.pending_auth
            return (
              <div key={a.id} style={{
                background: theme.color.bg, borderRadius: theme.radius.xl,
                border: `1px solid ${theme.color.border}`, boxShadow: theme.shadow.sm, overflow: 'hidden',
              }}>
                <div style={{ height: 5, background: online2(a.status) ? theme.color.lime : statusColor }} />
                <div style={{ padding: theme.space.lg }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.sm }}>
                    <PlatformIcon platform={a.platform} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontSize: theme.font.size.md, fontWeight: theme.font.weight.heavy,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {a.display_name}
                      </div>
                      <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>
                        {PLATFORM_LABEL[a.platform] ?? a.platform}
                      </div>
                    </div>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '4px 11px', borderRadius: theme.radius.pill,
                      background: online2(a.status) ? theme.color.lime : `${statusColor}1a`,
                      color: online2(a.status) ? theme.color.onLime : statusColor,
                      fontSize: theme.font.size.xs, fontWeight: theme.font.weight.heavy,
                    }}>
                      <StatusDot status={a.status} size={6} />
                      {STATUS_LABEL[a.status] ?? a.status}
                    </span>
                  </div>

                  <div style={{
                    marginTop: theme.space.md, display: 'flex', flexWrap: 'wrap', gap: 6,
                  }}>
                    <Chip>{convs.length} 个会话</Chip>
                    {last && <Chip>最近 {relativeTime(last)}</Chip>}
                    {a.history_available_from && (
                      <Chip>历史自 {a.history_available_from.slice(0, 10)}</Chip>
                    )}
                  </div>

                  <div className="ih-selectable" style={{
                    marginTop: theme.space.sm, fontSize: theme.font.size.xs,
                    color: theme.color.textFaint, wordBreak: 'break-all',
                  }}>
                    {a.id}
                  </div>

                  <button
                    onClick={() => { setActiveAccount(a.id); onOpenChat() }}
                    className="ih-btn"
                    style={{
                      marginTop: theme.space.md, width: '100%', padding: '10px 0',
                      borderRadius: theme.radius.pill, border: `1px solid ${theme.color.borderStrong}`,
                      background: theme.color.bg, color: theme.color.text,
                      fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
                    }}
                  >
                    查看会话
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
