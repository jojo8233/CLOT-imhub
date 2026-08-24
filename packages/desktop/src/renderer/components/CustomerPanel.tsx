import { useMemo } from 'react'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Avatar, Chip, EmptyHint, NotWired, SectionTitle, relativeTime } from './ui.js'

/**
 * 右侧客户信息栏。
 *
 * 分成两层，界线要让用户一眼看出来：
 *
 *   上层「互动情况」——全是库里查得到的事实，可信；
 *   下层「客户档案」——需要从聊天记录里提取，服务端还没有这张表，所以一律显示
 *   「尚未提取」并且编辑按钮是灰的。
 *
 * 宁可空着也不填占位文字：这块内容将来要拿去做客户跟进判断，一旦有假数据混进去，
 * 用户没法分辨哪条是真提取的、哪条是界面编的。
 */

/** 档案字段。顺序就是员工读的顺序，改动这个数组即可增删。 */
const PROFILE_FIELDS = [
  { key: 'name', label: '姓名', hint: '客户自称或签名里出现的名字' },
  { key: 'ageLocation', label: '年龄 / 居住地', hint: '提到的年龄段、城市或时区' },
  { key: 'occupation', label: '职业 / 退休状况', hint: '在职、行业，或已退休' },
  { key: 'family', label: '家庭 / 婚姻状况', hint: '同住家人、子女、婚姻' },
  { key: 'interests', label: '兴趣', hint: '反复提到的爱好与话题' },
  { key: 'other', label: '其他', hint: '不属于以上几类但值得记的' },
] as const

export function CustomerPanel() {
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
          <EmptyHint>选中一个会话后<br />这里显示该客户的资料</EmptyHint>
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

          {/* 客户档案：等服务端 */}
          <SectionTitle extra={<NotWired what="客户档案" />}>客户档案</SectionTitle>
          <div style={{ padding: `0 ${theme.space.lg}px` }}>
            {PROFILE_FIELDS.map(f => (
              <div key={f.key} style={{
                padding: `${theme.space.sm}px 0`,
                borderBottom: `1px solid ${theme.color.border}`,
              }}>
                <div style={{
                  fontSize: theme.font.size.xs, color: theme.color.textMuted,
                  marginBottom: 2, fontWeight: theme.font.weight.medium,
                }}>
                  {f.label}
                </div>
                <div title={f.hint} style={{
                  fontSize: theme.font.size.base, color: theme.color.textFaint, fontStyle: 'italic',
                }}>
                  尚未提取
                </div>
              </div>
            ))}
          </div>

          <div style={{
            margin: theme.space.lg, padding: theme.space.md,
            background: theme.color.surface, borderRadius: theme.radius.lg,
            fontSize: theme.font.size.xs, color: theme.color.textMuted, lineHeight: 1.8,
          }}>
            <div style={{ fontWeight: 600, color: theme.color.text, marginBottom: 4 }}>档案还差什么</div>
            服务端目前没有存档案的表。要让这几栏活起来，需要：一张
            <code style={{ background: theme.color.white, padding: '1px 5px', borderRadius: 4, margin: '0 3px' }}>
              customer_profiles
            </code>
            表（跟会话一对一）、一个读写接口（手动补充要能存），以及从聊天记录里提取摘要的那一步。
            <div style={{ marginTop: 6 }}>
              自动提取和手动补充是两件事，手动那条路先通了，员工就能自己记，不必等模型。
            </div>
          </div>

          <div style={{ padding: `0 ${theme.space.lg}px ${theme.space.xl}px`, display: 'flex', gap: theme.space.sm }}>
            <button
              disabled
              title="等 customer_profiles 表和读写接口"
              className="ih-btn"
              style={{
                flex: 1, padding: '10px 0', borderRadius: theme.radius.pill, border: 'none',
                background: theme.color.ink, color: theme.color.lime,
                fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
              }}
            >
              手动补充
            </button>
            <button
              disabled
              title="等摘要提取接入"
              className="ih-btn"
              style={{
                flex: 1, padding: '10px 0', borderRadius: theme.radius.pill,
                border: `1px solid ${theme.color.borderStrong}`, background: theme.color.card,
                color: theme.color.text, fontSize: theme.font.size.base,
                fontWeight: theme.font.weight.bold,
              }}
            >
              重新提取
            </button>
          </div>
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
