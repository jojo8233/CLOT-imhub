import { useStore } from '../store.js'
import { STATUS_LABEL, theme } from '../theme.js'
import { Avatar, PlatformIcon, StatusDot } from './ui.js'

/**
 * 顶栏：品牌块 + 账号标签页 + 当前用户。
 *
 * 账号标签页是这套界面的主轴——一个员工同时挂着好几个平台账号，
 * 切账号的动作必须一直在视线里，不能藏进菜单。选中的账号会过滤下方会话列表。
 */

interface Props {
  currentUserName: string | null
  onLogout(): void
  onAddAccount(): void
}

export function AccountTabs({ currentUserName, onLogout, onAddAccount }: Props) {
  const accounts = useStore(s => s.accounts)
  const activeAccountId = useStore(s => s.activeAccountId)
  const setActiveAccount = useStore(s => s.setActiveAccount)
  const conversations = useStore(s => s.conversations)

  const countOf = (accountId: string): number =>
    conversations.filter(c => c.account_id === accountId).length

  return (
      <div style={{
        height: 60, flexShrink: 0, display: 'flex', alignItems: 'center',
        borderBottom: `1px solid ${theme.color.border}`, background: theme.color.bg,
      }}>
        {/* 品牌块。参考稿里它自成一格，右侧有一道竖线把它和标签页分开 */}
        <div style={{
          width: 190, flexShrink: 0, height: '100%', display: 'flex', alignItems: 'center',
          gap: theme.space.sm, padding: `0 ${theme.space.lg}px`,
          borderRight: `1px solid ${theme.color.border}`,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: theme.radius.md, flexShrink: 0,
            background: `linear-gradient(135deg, ${theme.color.navy}, ${theme.color.accent})`,
            color: '#fff', fontSize: 15, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            IH
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: theme.font.size.md, fontWeight: 700, letterSpacing: .2 }}>im-hub</div>
            <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>跨境客服工作台</div>
          </div>
        </div>

        {/* 标签页横向滚动：账号多了不折行、不挤压，跟参考稿一致 */}
        <div className="ih-scroll" style={{
          flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center',
          gap: theme.space.sm, padding: `0 ${theme.space.md}px`, overflowX: 'auto', overflowY: 'hidden',
        }}>
          <AccountTab
            label="全部"
            active={activeAccountId === null}
            onClick={() => setActiveAccount(null)}
            badge={conversations.length}
          />
          {accounts.map(a => (
            <AccountTab
              key={a.id}
              label={a.display_name}
              platform={a.platform}
              status={a.status}
              active={activeAccountId === a.id}
              onClick={() => setActiveAccount(a.id)}
              badge={countOf(a.id)}
            />
          ))}
          <button
            className="ih-tab"
            onClick={onAddAccount}
            title="添加账号"
            style={{
              width: 30, height: 30, flexShrink: 0, borderRadius: theme.radius.md,
              border: `1px dashed ${theme.color.borderStrong}`, background: 'transparent',
              color: theme.color.textMuted, fontSize: 17, lineHeight: 1,
            }}
          >
            +
          </button>
        </div>

        {/* 当前用户 */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: theme.space.sm,
          padding: `0 ${theme.space.lg}px`, borderLeft: `1px solid ${theme.color.border}`, height: '100%',
        }}>
          <Avatar name={currentUserName} size={30} />
          <div style={{ maxWidth: 96, overflow: 'hidden' }}>
            <div style={{
              fontSize: theme.font.size.base, fontWeight: 600,
              whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden',
            }}>
              {currentUserName ?? '—'}
            </div>
            <button
              onClick={onLogout}
              style={{
                padding: 0, border: 'none', background: 'none',
                fontSize: theme.font.size.xs, color: theme.color.textFaint,
              }}
            >
              登出
            </button>
          </div>
        </div>
      </div>

  )
}

function AccountTab({ label, platform, status, active, onClick, badge }: {
  label: string
  platform?: string
  status?: string
  active: boolean
  onClick(): void
  badge?: number
}) {
  return (
    <button
      className="ih-tab"
      onClick={onClick}
      title={status ? `${label} · ${STATUS_LABEL[status] ?? status}` : label}
      style={{
        flexShrink: 0, height: 34, display: 'flex', alignItems: 'center', gap: theme.space.sm,
        padding: `0 ${theme.space.md}px`, borderRadius: theme.radius.md,
        border: `1px solid ${active ? 'transparent' : theme.color.border}`,
        background: active ? theme.color.navy : theme.color.bg,
        color: active ? '#fff' : theme.color.text,
        fontSize: theme.font.size.base, fontWeight: active ? 600 : 500,
      }}
    >
      {platform && (
        <span style={{ position: 'relative', display: 'flex' }}>
          <PlatformIcon platform={platform} size={16} />
          {status && (
            <span style={{ position: 'absolute', right: -2, bottom: -2 }}>
              <StatusDot status={status} size={7} />
            </span>
          )}
        </span>
      )}
      <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {badge !== undefined && badge > 0 && (
        <span style={{
          minWidth: 18, height: 18, padding: '0 5px', borderRadius: theme.radius.pill,
          background: active ? 'rgba(255,255,255,.22)' : theme.color.surface,
          color: active ? '#fff' : theme.color.textMuted,
          fontSize: theme.font.size.xs, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {badge}
        </span>
      )}
    </button>
  )
}
