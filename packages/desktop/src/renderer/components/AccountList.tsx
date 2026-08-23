import { useStore } from '../store.js'

const STATUS_COLOR: Record<string, string> = {
  connected: '#22c55e',
  reconnecting: '#eab308',
  degraded: '#f97316',
  disconnected: '#ef4444',
  pending_auth: '#94a3b8',
}

export function AccountList() {
  const accounts = useStore(s => s.accounts)
  return (
    <aside style={{ width: 220, borderRight: '1px solid #e2e8f0', overflowY: 'auto' }}>
      {accounts.map(a => (
        <div key={a.id} style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{
            width: 8, height: 8, borderRadius: 4, flexShrink: 0,
            background: STATUS_COLOR[a.status] ?? '#94a3b8',
          }} />
          <div>
            <div style={{ fontSize: 13 }}>{a.display_name}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{a.platform}</div>
            {a.history_available_from && (
              <div style={{ fontSize: 10, color: '#f97316' }}>
                历史起始 {a.history_available_from.slice(0, 10)}
              </div>
            )}
          </div>
        </div>
      ))}
    </aside>
  )
}
