import { accountsForPlatform, CHAT_PLATFORMS, type ChatPlatform } from '../navigation.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, STATUS_LABEL, theme } from '../theme.js'
import { Avatar, PlatformIcon, StatusDot } from './ui.js'

/** 顶部两级导航：一级选平台，二级只展示该平台账号。 */
interface Props {
  currentUserName: string | null
  onLogout(): void
  onChangePassword(): void
  onAddAccount(platform: ChatPlatform): void
  canAddAccount: boolean
}

export function AccountTabs({ currentUserName, onLogout, onChangePassword, onAddAccount, canAddAccount }: Props) {
  const accounts = useStore(s => s.accounts)
  const conversations = useStore(s => s.conversations)
  const activePlatform = useStore(s => s.activePlatform)
  const activeAccountId = useStore(s => s.activeAccountId)
  const setActivePlatform = useStore(s => s.setActivePlatform)
  const setActiveAccount = useStore(s => s.setActiveAccount)

  const platformAccounts = accountsForPlatform(accounts, activePlatform)
  const countOf = (accountId: string): number =>
    conversations.filter(conversation => conversation.account_id === accountId).length

  return (
    <header style={{
      height: 104, flexShrink: 0, display: 'flex', alignItems: 'stretch',
      borderBottom: `1px solid ${theme.color.border}`, background: theme.color.bg,
    }}>
      <Brand />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          height: 46, flexShrink: 0, display: 'flex', alignItems: 'center',
          gap: theme.space.sm, padding: `0 ${theme.space.md}px`,
          borderBottom: `1px solid ${theme.color.border}`,
        }}>
          {CHAT_PLATFORMS.map(platform => (
            <PlatformTab
              key={platform}
              platform={platform}
              count={accountsForPlatform(accounts, platform).length}
              active={platform === activePlatform}
              onClick={() => setActivePlatform(platform)}
            />
          ))}
        </div>

        <div className="ih-scroll" style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center',
          gap: theme.space.sm, padding: `0 ${theme.space.md}px`, overflowX: 'auto', overflowY: 'hidden',
        }}>
          {platformAccounts.length === 0 ? (
            <span style={{ fontSize: theme.font.size.sm, color: theme.color.textFaint, whiteSpace: 'nowrap' }}>
              暂无 {PLATFORM_LABEL[activePlatform]} 账号
            </span>
          ) : platformAccounts.map(account => (
            <AccountTab
              key={account.id}
              label={account.display_name}
              platform={account.platform}
              status={account.status}
              active={activeAccountId === account.id}
              onClick={() => setActiveAccount(account.id)}
              badge={countOf(account.id)}
            />
          ))}
          {canAddAccount && <button
            className="ih-tab"
            onClick={() => onAddAccount(activePlatform)}
            title={`添加 ${PLATFORM_LABEL[activePlatform]} 账号`}
            aria-label={`添加 ${PLATFORM_LABEL[activePlatform]} 账号`}
            style={{
              width: 34, height: 34, flexShrink: 0, borderRadius: '50%',
              border: `1px dashed ${theme.color.borderStrong}`, background: 'transparent',
              color: theme.color.textMuted, fontSize: 17, lineHeight: 1,
            }}
          >
            +
          </button>}
        </div>
      </div>

      <CurrentUser
        currentUserName={currentUserName}
        onLogout={onLogout}
        onChangePassword={onChangePassword}
      />
    </header>
  )
}

function Brand() {
  return (
    <div style={{
      width: 190, flexShrink: 0, display: 'flex', alignItems: 'center',
      gap: theme.space.sm, padding: `0 ${theme.space.lg}px`,
      borderRight: `1px solid ${theme.color.border}`,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: theme.radius.md, flexShrink: 0,
        background: theme.color.ink, color: theme.color.lime,
        fontSize: 15, fontWeight: theme.font.weight.heavy,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        IH
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy, letterSpacing: -.3 }}>im-hub</div>
        <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>跨境客服工作台</div>
      </div>
    </div>
  )
}

function CurrentUser({ currentUserName, onLogout, onChangePassword }: {
  currentUserName: string | null
  onLogout(): void
  onChangePassword(): void
}) {
  return (
    <div style={{
      width: 156, flexShrink: 0, display: 'flex', alignItems: 'center', gap: theme.space.sm,
      padding: `0 ${theme.space.lg}px`, borderLeft: `1px solid ${theme.color.border}`,
    }}>
      <Avatar name={currentUserName} size={30} />
      <div style={{ minWidth: 0, overflow: 'hidden' }}>
        <div style={{
          fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
          whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden',
        }}>
          {currentUserName ?? '—'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onChangePassword}
            style={{
              padding: 0, border: 'none', background: 'none',
              fontSize: theme.font.size.xs, color: theme.color.textFaint,
            }}
          >
            修改密码
          </button>
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

function PlatformTab({ platform, count, active, onClick }: {
  platform: ChatPlatform
  count: number
  active: boolean
  onClick(): void
}) {
  return (
    <button
      className="ih-tab"
      onClick={onClick}
      aria-pressed={active}
      style={{
        height: 32, display: 'flex', alignItems: 'center', gap: 7,
        padding: `0 ${theme.space.md}px`, borderRadius: theme.radius.pill,
        border: `1px solid ${active ? 'transparent' : theme.color.border}`,
        background: active ? theme.color.ink : theme.color.card,
        color: active ? theme.color.onInk : theme.color.text,
        fontSize: theme.font.size.sm,
        fontWeight: active ? theme.font.weight.heavy : theme.font.weight.bold,
      }}
    >
      <PlatformIcon platform={platform} size={16} />
      {PLATFORM_LABEL[platform]}
      <span style={{
        minWidth: 18, height: 18, padding: '0 5px', borderRadius: theme.radius.pill,
        background: active ? theme.color.lime : theme.color.surface,
        color: active ? theme.color.onLime : theme.color.textMuted,
        fontSize: theme.font.size.xs, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {count}
      </span>
    </button>
  )
}

function AccountTab({ label, platform, status, active, onClick, badge }: {
  label: string
  platform: string
  status: string
  active: boolean
  onClick(): void
  badge: number
}) {
  return (
    <button
      className="ih-tab"
      onClick={onClick}
      title={`${label} · ${STATUS_LABEL[status] ?? status}`}
      aria-pressed={active}
      style={{
        flexShrink: 0, height: 36, display: 'flex', alignItems: 'center', gap: theme.space.sm,
        padding: `0 ${theme.space.md}px`, borderRadius: theme.radius.pill,
        border: `1px solid ${active ? theme.color.limeDeep : theme.color.border}`,
        background: active ? theme.color.limeSoft : theme.color.card,
        color: theme.color.text, fontSize: theme.font.size.base,
        fontWeight: active ? theme.font.weight.heavy : theme.font.weight.medium,
      }}
    >
      <span style={{ position: 'relative', display: 'flex' }}>
        <PlatformIcon platform={platform} size={16} />
        <span style={{ position: 'absolute', right: -2, bottom: -2 }}>
          <StatusDot status={status} size={7} />
        </span>
      </span>
      <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {badge > 0 && (
        <span style={{
          minWidth: 18, height: 18, padding: '0 5px', borderRadius: theme.radius.pill,
          background: active ? theme.color.white : theme.color.surface,
          color: theme.color.textMuted, fontSize: theme.font.size.xs,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {badge}
        </span>
      )}
    </button>
  )
}
