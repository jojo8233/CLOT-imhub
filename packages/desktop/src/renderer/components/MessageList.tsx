import { useStore } from '../store.js'

export function MessageList() {
  const messages = useStore(s => s.messages)
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
      {messages.map(m => (
        <div key={m.id} style={{ marginBottom: 14, textAlign: m.direction === 'out' ? 'right' : 'left' }}>
          <div style={{
            display: 'inline-block', maxWidth: '70%', padding: '8px 12px', borderRadius: 10,
            background: m.direction === 'out' ? '#dbeafe' : '#f1f5f9', textAlign: 'left',
          }}>
            <div style={{ fontSize: 14 }}>{m.body}</div>
            {/* translated_text 为 null 时显示"翻译中…"。P0 没有超时或重试提示——
                如果翻译引擎全挂，这条消息会永远停在"翻译中…"，没有办法从 UI 上区分
                "还在排队"和"已经失败"。留给后续任务：服务端在翻译失败时应该推一个
                带错误标记的事件（或写入一个哨兵值），客户端才有信息可以区分并提示重试。 */}
            {m.translated_text
              ? <div style={{
                  fontSize: 13, color: '#475569', marginTop: 4,
                  borderTop: '1px solid #cbd5e1', paddingTop: 4,
                }}>{m.translated_text}</div>
              : <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>翻译中…</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
