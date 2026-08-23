import type { WsServerEvent } from '@im-hub/shared'

const BASE = (window as unknown as { imHub: { serverUrl: string } }).imHub.serverUrl

// P0: 模块级变量存 token。connectWs 必须在 login 成功之后调用——
// App.tsx 里严格按 login -> listAccounts/listConversations -> connectWs 的顺序 await，
// 保证这一点。如果谁在 login 之前调 connectWs，首帧会发 {type:'auth', token:null}，
// 服务端 JSON.parse 后 msg.token 是 null，鉴权直接失败，5 秒内连接被 close(1008)。
// 不会崩溃，但连接建立不起来——P0 没有对这种误用做编译期防护或运行时提示。
let token: string | null = null

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

export interface AccountRow {
  id: string
  platform: string
  display_name: string
  status: string
  history_available_from: string | null
}

export interface ConversationRow {
  id: string
  account_id: string
  contact_display_name: string | null
  contact_external_id: string
  last_message_at: string | null
}

export interface MessageRow {
  id: string
  direction: 'in' | 'out'
  body: string
  sent_at: string
  translated_text: string | null
}

export const api = {
  async login(email: string, password: string): Promise<void> {
    const res = await request<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    token = res.token
  },
  listAccounts: () => request<{ accounts: AccountRow[] }>('/api/accounts'),
  listConversations: () => request<{ conversations: ConversationRow[] }>('/api/conversations'),
  listMessages: (id: string) => request<{ messages: MessageRow[] }>(`/api/conversations/${id}/messages`),
  send: (conversationId: string, body: string, targetLang: string) =>
    request<{ sentText: string; provider: string }>('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify({ conversationId, body, targetLang }),
    }),
  /**
   * 鉴权走首帧消息，不走 query string —— token 有 12 小时有效期，
   * 出现在 URL 里会被反向代理/服务端访问日志记下来，query string 鉴权就是把这个
   * 长期有效凭证写进日志。握手：先建连接（不带 token）；onopen 时发
   * {type:'auth', token}；服务端校验通过回 {type:'auth_ok'}，之后才推业务事件；
   * 5 秒内没收到合法 auth 帧服务端会 close(1008)。
   *
   * P0 现状：auth 失败或服务端主动断开（比如 token 过期）时，onclose 只是静默——
   * 没有自动重连，也没有把"实时更新已经断线"这件事告诉用户。断线后消息列表仍然
   * 可以手动刷新（切换会话会重新拉取），但翻译结果的实时推送会从此收不到，
   * 界面上不会有任何提示。这是已知的 P0 局限，留给后续任务补重连与断线提示。
   */
  connectWs(onEvent: (e: WsServerEvent) => void): WebSocket {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as WsServerEvent | { type: 'auth_ok' }
      if (msg.type === 'auth_ok') return
      onEvent(msg as WsServerEvent)
    }
    return ws
  },
}
