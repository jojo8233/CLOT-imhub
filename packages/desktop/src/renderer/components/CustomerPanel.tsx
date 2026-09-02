import { useMemo } from 'react'
import { getCurrentUser } from '../api/client.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Avatar, Chip, EmptyHint, SectionTitle, relativeTime } from './ui.js'
import { CustomerProfileSection } from './CustomerProfileSection.js'

/**
 * 右侧客户信息栏。
 *
 * 分成两层，界线要让用户一眼看出来：
 *
 *   上层「互动情况」——全是库里查得到的事实，可信；
 *   下层「客户档案」——由服务端按内部会话持久化，人工资料是当前权威值。
 *
 * 宁可空着也不填占位文字：这块内容将来要拿去做客户跟进判断，一旦有假数据混进去，
 * 用户没法分辨哪条是真提取的、哪条是界面编的。
 */

export function CustomerPanel({ nativePending = false }: { nativePending?: boolean }) {
  const conversations = useStore(s => s.conversations)
  const accounts = useStore(s => s.accounts)
  const messages = useStore(s => s.messages)
  const activeId = useStore(s => s.activeConversationId)

  const conv = conversations.find(c => c.id === activeId) ?? null
  const account = accounts.find(a => a.id === conv?.account_id) ?? null

  const stats = useMemo(() => {
    const out = messages.filter(m => m.direction === 'out').length
    return {
      total: messages.length,
      out,
      in: messages.length - out,
      first: messages[0]?.sent_at ?? null,
    }
  }, [messages])

  return (
    <aside style={{
      // 宽度由外层可拖拽容器给；栏间的分隔线由 Resizer 画，这里不再自带 border
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
      background: theme.color.bg,
    }}>
      {!conv ? (
        <>
          <SectionTitle>客户信息</SectionTitle>
          <EmptyHint>
            {nativePending ? (
              <>请先在原生客户端<br />打开一个会话</>
            ) : (
              <>选中一个会话后<br />这里显示该客户的资料</>
            )}
          </EmptyHint>
        </>
      ) : (
        <div className="ih-scroll" style={{ flex: 1 }}>
          {/* 身份 */}
          <div style={{
            margin: theme.space.md, padding: `${theme.space.xl}px ${theme.space.lg}px`,
            textAlign: 'center', background: theme.color.limeSoft, borderRadius: theme.radius.xl,
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: theme.space.md }}>
              <Avatar
                name={conv.contact_display_name ?? conv.contact_external_id}
                seed={conv.contact_external_id}
                size={68}
                tone="dark"
              />
            </div>
            <div style={{
              fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy,
              letterSpacing: -.3, color: theme.color.onLime, wordBreak: 'break-word',
            }}>
              {conv.contact_display_name ?? conv.contact_external_id}
            </div>
            <div className="ih-selectable" style={{
              fontSize: theme.font.size.xs, color: theme.color.textMuted,
              marginTop: 3, wordBreak: 'break-all',
            }}>
              {conv.contact_external_id}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: theme.space.md }}>
              {account && (
                <Chip style={{ background: theme.color.white, color: theme.color.text }}>
                  {PLATFORM_LABEL[account.platform] ?? account.platform}
                </Chip>
              )}
              {account && (
                <Chip style={{ background: theme.color.white, color: theme.color.text }}>
                  {account.display_name}
                </Chip>
              )}
            </div>
          </div>

          {/* 互动情况：全部来自数据库 */}
          <SectionTitle>互动情况</SectionTitle>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space.sm,
            padding: `0 ${theme.space.lg}px ${theme.space.md}px`,
          }}>
            <Stat label="客户发来" value={String(stats.in)} dark />
            <Stat label="我方发出" value={String(stats.out)} dark />
            <Stat label="最近活跃" value={relativeTime(conv.last_message_at) || '—'} />
            <Stat label="回复语言" value={conv.target_lang ?? '自动跟随'} />
          </div>
          <div style={{
            padding: `0 ${theme.space.lg}px ${theme.space.lg}px`,
            fontSize: theme.font.size.xs, color: theme.color.textFaint, lineHeight: 1.7,
          }}>
            统计自本会话已加载的 {stats.total} 条消息
            {stats.first && <>，最早一条 {stats.first.slice(0, 10)}</>}
          </div>

          <CustomerProfileSection
            conversationId={conv.id}
            readOnly={getCurrentUser()?.role === 'auditor'}
          />
        </div>
      )}
    </aside>
  )
}

/** dark 用在消息计数上：数字是这块里最该被一眼看到的东西 */
function Stat({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <div style={{
      padding: `${theme.space.md}px ${theme.space.md}px`, borderRadius: theme.radius.lg,
      background: dark ? theme.color.inkSoft : theme.color.card,
    }}>
      <div style={{
        fontSize: theme.font.size.xs,
        color: dark ? theme.color.onInkFaint : theme.color.textMuted,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: dark ? theme.font.size.xl : theme.font.size.md,
        fontWeight: theme.font.weight.heavy, letterSpacing: -.5, marginTop: 2,
        color: dark ? theme.color.onInk : theme.color.text,
      }}>
        {value}
      </div>
    </div>
  )
}
