import { useStore } from '../store.js'
import { PLATFORM_LABEL, STATUS_LABEL, theme } from '../theme.js'
import { Composer } from './Composer.js'
import { MessageList } from './MessageList.js'
import { Avatar, Chip, IconButton, StatusDot } from './ui.js'

interface Props {
  focus: boolean
  onToggleFocus(): void
}

/** 中间聊天区：会话抬头 + 消息流 + 输入区。三块的边界靠底色区分，不再堆分割线。 */
export function ChatPanel({ focus, onToggleFocus }: Props) {
  const conversations = useStore(s => s.conversations)
  const accounts = useStore(s => s.accounts)
  const activeId = useStore(s => s.activeConversationId)

  const conv = conversations.find(c => c.id === activeId) ?? null
  const account = accounts.find(a => a.id === conv?.account_id) ?? null
  const name = conv ? (conv.contact_display_name ?? conv.contact_external_id) : null

  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: theme.color.chat,
    }}>
      <div style={{
        height: 68, flexShrink: 0, display: 'flex', alignItems: 'center', gap: theme.space.md,
        padding: `0 ${theme.space.xl}px`, background: theme.color.bg,
        borderBottom: `1px solid ${theme.color.border}`,
      }}>
        {conv ? (
          <>
            <Avatar name={name} seed={conv.contact_external_id} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy, letterSpacing: -.3,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {name}
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 1,
                fontSize: theme.font.size.xs, color: theme.color.textMuted,
              }}>
                {account && (
                  <>
                    <StatusDot status={account.status} size={7} />
                    <span>
                      {PLATFORM_LABEL[account.platform] ?? account.platform} · {account.display_name} ·{' '}
                      {STATUS_LABEL[account.status] ?? account.status}
                    </span>
                  </>
                )}
              </div>
            </div>
            {conv.target_lang
              ? <Chip tone="accent">🔒 回复语言 {conv.target_lang}</Chip>
              : <Chip>自动跟随客户语言</Chip>}
            <FocusToggle focus={focus} onToggle={onToggleFocus} />
          </>
        ) : (
          <>
            <span style={{
              flex: 1, fontSize: theme.font.size.md,
              fontWeight: 600, color: theme.color.textFaint,
            }}>
              未选择会话
            </span>
            <FocusToggle focus={focus} onToggle={onToggleFocus} />
          </>
        )}
      </div>

      <MessageList />
      <Composer />
    </div>
  )
}

/** 收起两侧辅助栏，把空间全给聊天。再点一次恢复用户自己拖出来的宽度。 */
function FocusToggle({ focus, onToggle }: { focus: boolean; onToggle(): void }) {
  return (
    <IconButton
      onClick={onToggle}
      label={focus ? '退出专注聊天' : '专注聊天'}
      title={focus ? '退出专注，恢复上次的栏宽' : '收起会话列表与客户资料'}
    >
      {focus ? '><' : '<>'}
    </IconButton>
  )
}
