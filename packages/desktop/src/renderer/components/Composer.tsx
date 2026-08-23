import { useState } from 'react'
import { api } from '../api/client.js'
import { useStore } from '../store.js'

export function Composer() {
  const conversationId = useStore(s => s.activeConversationId)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSend(): Promise<void> {
    if (!conversationId || draft.trim() === '') return
    setSending(true)
    setError(null)
    try {
      const res = await api.send(conversationId, draft, 'en')
      setSent(res.sentText)
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ borderTop: '1px solid #e2e8f0', padding: 12 }}>
      {sent && <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>已发送译文：{sent}</div>}
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 6 }}>{error}</div>}
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="输入中文，发送时自动翻译"
        style={{ width: '100%', height: 70, resize: 'none', padding: 8, fontSize: 14 }}
      />
      <button onClick={() => void handleSend()} disabled={sending || !conversationId} style={{ marginTop: 8 }}>
        {sending ? '发送中…' : '发送'}
      </button>
    </div>
  )
}
