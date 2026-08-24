import { useMemo, useState } from 'react'
import { useStore } from '../store.js'
import { theme } from '../theme.js'
import { Avatar, Chip, EmptyHint, relativeTime } from './ui.js'

type Filter = 'all' | 'today'

/**
 * 会话列表。搜索和「今天」都是纯前端过滤——列表上限 200 条，本地过滤够用，
 * 而且不用等网络往返。真要做跨账号全量检索得走服务端，那是功能中心里
 * 标着「未接入」的全局搜索。
 */
export function ConversationList() {
  const conversations = useStore(s => s.conversations)
  const accounts = useStore(s => s.accounts)
  const activeAccountId = useStore(s => s.activeAccountId)
  const activeId = useStore(s => s.activeConversationId)
  const setActive = useStore(s => s.setActiveConversation)

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const scoped = useMemo(
    () => activeAccountId ? conversations.filter(c => c.account_id === activeAccountId) : conversations,
    [conversations, activeAccountId],
  )

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const todayPrefix = new Date().toISOString().slice(0, 10)
    return scoped.filter(c => {
      if (filter === 'today' && (c.last_message_at ?? '').slice(0, 10) !== todayPrefix) return false
      if (needle === '') return true
      return `${c.contact_display_name ?? ''} ${c.contact_external_id}`.toLowerCase().includes(needle)
    })
  }, [scoped, q, filter])

  const accountName = accounts.find(a => a.id === activeAccountId)?.display_name

  return (
    <div style={{
      width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${theme.color.border}`, background: theme.color.bg,
    }}>
      <div style={{ padding: theme.space.md, borderBottom: `1px solid ${theme.color.border}` }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: theme.space.sm,
        }}>
          <span style={{ fontSize: theme.font.size.md, fontWeight: 700 }}>会话</span>
          <span style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>
            {accountName ?? '全部账号'} · {shown.length}
          </span>
        </div>

        <div style={{ position: 'relative', marginBottom: theme.space.sm }}>
          <span style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            fontSize: theme.font.size.sm, color: theme.color.textFaint, pointerEvents: 'none',
          }}>
            ⌕
          </span>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索联系人"
            style={{
              width: '100%', padding: '7px 10px 7px 26px', fontSize: theme.font.size.base,
              border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md,
              background: theme.color.surface, color: theme.color.text,
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {([['all', '所有'], ['today', '今天']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{
                padding: '4px 12px', borderRadius: theme.radius.pill,
                border: `1px solid ${filter === key ? 'transparent' : theme.color.border}`,
                background: filter === key ? theme.color.accentSoft : 'transparent',
                color: filter === key ? theme.color.accent : theme.color.textMuted,
                fontSize: theme.font.size.xs, fontWeight: 600,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ih-scroll" style={{ flex: 1, padding: 6 }}>
        {shown.length === 0 && (
          <EmptyHint>
            {conversations.length === 0
              ? <>还没有会话。<br />客户发来第一条消息后就会出现在这里。</>
              : <>没有匹配的会话。<br />换个关键词或切回「所有」。</>}
          </EmptyHint>
        )}
        {shown.map(c => {
          const name = c.contact_display_name ?? c.contact_external_id
          const on = c.id === activeId
          return (
            <div
              key={c.id}
              className="ih-row"
              onClick={() => setActive(c.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: theme.space.sm,
                padding: theme.space.sm, borderRadius: theme.radius.lg, marginBottom: 2,
                cursor: 'pointer',
                background: on ? theme.color.accentSoft : 'transparent',
                boxShadow: on ? `inset 0 0 0 1px ${theme.color.accent}` : undefined,
              }}
            >
              <Avatar name={name} seed={c.contact_external_id} size={38} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: theme.font.size.base, fontWeight: 600,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {name}
                  </span>
                  <span style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint, flexShrink: 0 }}>
                    {relativeTime(c.last_message_at)}
                  </span>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 2,
                  fontSize: theme.font.size.xs, color: theme.color.textMuted,
                }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.contact_external_id}
                  </span>
                  {c.target_lang && <Chip tone="accent" style={{ flexShrink: 0 }}>🔒 {c.target_lang}</Chip>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
