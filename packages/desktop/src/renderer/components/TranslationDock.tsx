import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Chip } from './ui.js'

/**
 * 固定在原生客户端下方的统一翻译输入坞。
 *
 * M1 只建立位置、样式和禁用态。M2 接入 NativeComposerBridge 后才允许把译文
 * 写入原生输入框并触发原生发送；现在提前启用会造成“按钮能点但可能发错会话”。
 */
export function TranslationDock() {
  const accounts = useStore(s => s.accounts)
  const activeAccountId = useStore(s => s.activeAccountId)
  const active = accounts.find(account => account.id === activeAccountId) ?? null

  const reason = active
    ? `等待 ${PLATFORM_LABEL[active.platform] ?? active.platform} 原生输入桥接（M2）`
    : '先选择或添加当前平台账号'

  return (
    <section style={{
      flexShrink: 0, padding: `${theme.space.sm}px ${theme.space.md}px ${theme.space.md}px`,
      borderTop: `1px solid ${theme.color.border}`, background: theme.color.chat,
    }}>
      <div style={{
        maxWidth: 760, margin: '0 auto', padding: `${theme.space.md}px ${theme.space.lg}px`,
        border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.xl,
        background: theme.color.card, boxShadow: theme.shadow.md,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: theme.space.md, marginBottom: 6,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: theme.font.size.xs, color: theme.color.textFaint, fontWeight: theme.font.weight.bold,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: theme.color.textFaint }} />
            中文原文
          </div>
          <Chip tone="muted" style={{ border: `1px dashed ${theme.color.borderStrong}` }}>
            {reason}
          </Chip>
        </div>

        <textarea
          disabled
          aria-label="中文原文"
          placeholder="输入中文，回车翻译（Shift+回车换行）"
          style={{
            width: '100%', height: 54, resize: 'none', padding: '10px 14px',
            border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
            background: theme.color.white, color: theme.color.text,
            fontFamily: theme.font.sans, fontSize: theme.font.size.md, lineHeight: 1.5,
          }}
        />

        <div style={{
          display: 'flex', alignItems: 'center', gap: theme.space.sm,
          marginTop: theme.space.md, paddingTop: theme.space.md,
          borderTop: `1px solid ${theme.color.border}`,
        }}>
          <span style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint }}>回复语言</span>
          <select
            disabled
            aria-label="回复语言"
            style={{
              height: 30, minWidth: 94, padding: '0 28px 0 10px',
              border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.pill,
              background: theme.color.white, color: theme.color.textMuted,
              fontSize: theme.font.size.sm,
            }}
          >
            <option>自动</option>
          </select>
          <Chip tone="muted">🔒 自动</Chip>

          <div style={{ flex: 1 }} />
          <button disabled style={secondaryButton}>翻译</button>
          <button disabled style={primaryButton}>发送</button>
        </div>
      </div>
    </section>
  )
}

const secondaryButton = {
  height: 34, padding: '0 16px', border: 'none', background: 'transparent',
  color: theme.color.textFaint, fontSize: theme.font.size.base,
}

const primaryButton = {
  height: 36, padding: '0 20px', border: 'none', borderRadius: theme.radius.pill,
  background: theme.color.surface, color: theme.color.textFaint,
  fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold,
}
