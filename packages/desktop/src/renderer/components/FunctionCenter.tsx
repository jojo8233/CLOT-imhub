import { useStore } from '../store.js'
import { theme } from '../theme.js'
import { NotWired } from './ui.js'

/**
 * 左侧功能中心。可收起成一条图标栏——五列布局在 1280 宽的窗口里会把聊天区挤没，
 * 收起后聊天区能多拿回 190px。
 *
 * 名单里既有做完的也有没做的，没做的一律打「未接入」并且不可点。参考稿里这些
 * 入口全是活的，我们不是；不标出来的话，用户得一个个点过去才知道哪些是空的。
 * 顺带这份名单也就是路线图，接完一个把 view 填上、ready 改 true。
 */

export type ViewKey = 'chat' | 'accounts'

interface Entry {
  /** 图标块里的字。参考稿用的就是单字，比抽象图形更好认 */
  glyph: string
  tint: string
  title: string
  desc: string
  /** 有 view 表示点了会切视图；有 action 表示点了触发动作；都没有就是没做完 */
  view?: ViewKey
  action?: 'addAccount'
}

const ENTRIES: Entry[] = [
  { glyph: '+', tint: '#0a6fe8', title: '添加账号', desc: '接入新的聊天平台账号', action: 'addAccount' },
  { glyph: '话', tint: '#101a5c', title: '会话工作台', desc: '收发消息、发送前译文校对', view: 'chat' },
  { glyph: '号', tint: '#22b573', title: '账号状态', desc: '各账号在线情况与历史起点', view: 'accounts' },
  { glyph: '警', tint: '#e0364a', title: '关键词警报', desc: '命中敏感词时通知管理员' },
  { glyph: '译', tint: '#e79a1a', title: '翻译历史', desc: '原文、译文与回译留痕' },
  { glyph: '词', tint: '#8b5cf6', title: '术语表', desc: '固定人名、品牌与产品译法' },
  { glyph: '档', tint: '#0891b2', title: '客户档案库', desc: '跨会话汇总的客户信息' },
  { glyph: '搜', tint: '#64748b', title: '全局搜索', desc: '跨账号检索消息与联系人' },
]

interface Props {
  view: ViewKey
  onSelectView(v: ViewKey): void
  onAddAccount(): void
}

export function FunctionCenter({ view, onSelectView, onAddAccount }: Props) {
  const open = useStore(s => s.panelOpen)
  const togglePanel = useStore(s => s.togglePanel)

  function activate(e: Entry): void {
    if (e.action === 'addAccount') onAddAccount()
    else if (e.view) onSelectView(e.view)
  }

  return (
    <aside style={{
      width: open ? 250 : 62, flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${theme.color.border}`, background: theme.color.bg,
      transition: 'width .16s ease',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: open ? 'space-between' : 'center',
        padding: open ? `${theme.space.lg}px ${theme.space.lg}px ${theme.space.md}px` : `${theme.space.lg}px 0 ${theme.space.md}px`,
      }}>
        {open && (
          <div>
            <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy, letterSpacing: -.3 }}>功能中心</div>
            <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint, marginTop: 1 }}>
              {ENTRIES.filter(e => e.view ?? e.action).length} / {ENTRIES.length} 项已接入
            </div>
          </div>
        )}
        <button
          className="ih-btn"
          onClick={togglePanel}
          title={open ? '收起功能中心' : '展开功能中心'}
          style={{
            width: 32, height: 32, flexShrink: 0, borderRadius: '50%',
            border: `1px solid ${theme.color.border}`, background: theme.color.card,
            color: theme.color.text, fontSize: 13,
          }}
        >
          {open ? '‹' : '›'}
        </button>
      </div>

      <div className="ih-scroll" style={{ flex: 1, padding: `0 ${open ? theme.space.md : 8}px ${theme.space.md}px` }}>
        {ENTRIES.map(e => {
          const wired = Boolean(e.view ?? e.action)
          const active = e.view !== undefined && e.view === view
          return (
            <button
              key={e.title}
              className={wired ? 'ih-row' : undefined}
              disabled={!wired}
              onClick={() => activate(e)}
              title={open ? undefined : `${e.title}${wired ? '' : '（未接入）'}`}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: theme.space.md,
                padding: open ? theme.space.sm : 6, marginBottom: 4, textAlign: 'left',
                justifyContent: open ? 'flex-start' : 'center',
                border: '1px solid transparent',
                borderRadius: theme.radius.lg,
                background: active ? theme.color.ink : 'transparent',
                opacity: wired ? 1 : .78,
              }}
            >
              <span style={{
                width: 32, height: 32, flexShrink: 0, borderRadius: theme.radius.md,
                // 选中行是黑底，图标块反过来用绿；未接入的退成灰
                background: active ? theme.color.lime : wired ? theme.color.card : theme.color.surface,
                color: active ? theme.color.onLime : wired ? theme.color.text : theme.color.textFaint,
                fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {e.glyph}
              </span>
              {open && (
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
                    color: active ? theme.color.onInk : theme.color.text,
                  }}>
                    {e.title}
                    {!wired && <NotWired what={e.title} />}
                  </span>
                  <span style={{
                    display: 'block', fontSize: theme.font.size.xs,
                    color: active ? theme.color.onInkMuted : theme.color.textMuted,
                    marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {e.desc}
                  </span>
                </span>
              )}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
