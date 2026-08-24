import { useEffect, useRef } from 'react'
import { useStore } from '../store.js'
import { theme } from '../theme.js'
import { EmptyHint, clockTime } from './ui.js'

export function MessageList() {
  const messages = useStore(s => s.messages)
  const activeId = useStore(s => s.activeConversationId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 新消息进来、或切到别的会话时都要贴底。不这么做的话，WS 推来的消息会落在
  // 视口下方看不见的地方，界面上像是没收到。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, activeId])

  if (messages.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EmptyHint>{activeId ? '这个会话还没有消息' : '从左边选一个会话开始'}</EmptyHint>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="ih-scroll"
      style={{ flex: 1, padding: `${theme.space.lg}px ${theme.space.xl}px`, background: theme.color.chat }}
    >
      {messages.map(m => {
        const out = m.direction === 'out'
        return (
          <div key={m.id} style={{
            display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', marginBottom: theme.space.md,
          }}>
            <div className="ih-selectable" style={{
              maxWidth: '76%', minWidth: 0,
              padding: `${theme.space.md}px ${theme.space.lg}px`,
              // 靠自己那一侧的角收小，气泡才有指向感
              borderRadius: out
                ? `${theme.radius.xl}px ${theme.radius.sm}px ${theme.radius.xl}px ${theme.radius.xl}px`
                : `${theme.radius.sm}px ${theme.radius.xl}px ${theme.radius.xl}px ${theme.radius.xl}px`,
              // 自己发的用深靛蓝实心，客户的用白底描边——一眼分清方向，
              // 不用去读左右对齐（窄窗口里对齐差别会变得不明显）
              background: out ? theme.color.inkSoft : theme.color.white,
              color: out ? theme.color.onInk : theme.color.text,
              border: out ? 'none' : `1px solid ${theme.color.border}`,
              boxShadow: theme.shadow.sm,
            }}>
              <div style={{ fontSize: theme.font.size.md, lineHeight: 1.6, wordBreak: 'break-word' }}>
                {m.body}
              </div>

              {/* translated_text 为 null 时显示"翻译中…"。这里区分不了"还在排队"和
                  "翻译引擎全挂了"——服务端翻译失败时没有推任何事件，消息会永远停在
                  这个状态。要修得让服务端在失败时推一个带错误标记的事件。 */}
              {m.translated_text
                ? (
                  <div style={{
                    marginTop: theme.space.sm, paddingTop: theme.space.sm,
                    borderTop: `1px solid ${out ? theme.color.onInkLine : theme.color.border}`,
                    fontSize: theme.font.size.base, lineHeight: 1.6,
                    color: out ? theme.color.onInkMuted : theme.color.textMuted,
                    wordBreak: 'break-word',
                  }}>
                    {m.translated_text}
                  </div>
                )
                : (
                  <div style={{
                    marginTop: theme.space.xs, fontSize: theme.font.size.xs,
                    color: out ? theme.color.onInkFaint : theme.color.textFaint,
                  }}>
                    翻译中…
                  </div>
                )}

              <div style={{
                marginTop: theme.space.xs, fontSize: theme.font.size.xs, textAlign: 'right',
                color: out ? theme.color.onInkFaint : theme.color.textFaint,
              }}>
                {clockTime(m.sent_at)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
