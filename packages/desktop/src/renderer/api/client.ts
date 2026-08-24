import type { WsServerEvent } from '@im-hub/shared'

/**
 * preload 注入的配置。取不到时降级到默认值而不是抛异常——
 * 这一行跑在模块顶层，抛出去会让 React 连挂载都来不及，
 * 结果是一片白屏加零提示，排查起来极其痛苦。
 */
const injected = (globalThis as { imHub?: { serverUrl?: string } }).imHub
if (!injected?.serverUrl) {
  console.error('[client] preload 未注入 window.imHub，降级使用 http://localhost:4000。检查 sandbox 与 preload 路径。')
}
const BASE = injected?.serverUrl ?? 'http://localhost:4000'

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
  /**
   * null = 自动跟随客户语言，有值 = 员工锁定。
   * 注：设计文档写的是 GET /api/conversations 不返回这个字段，但实测服务端已经在返回——
   * 直接用它做语言选择器的初始值，比只靠 translate-preview 响应回填更可靠。
   */
  target_lang: string | null
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
  /**
   * 只翻译，不发送。用来在发送前生成可编辑的预览 + 回译对照。
   * backTranslated 为 null 表示回译服务当次失败，translated/targetLang/provider 仍然可用。
   */
  translatePreview: (conversationId: string, text: string) =>
    request<{ translated: string; backTranslated: string | null; targetLang: string; provider: string }>(
      '/api/messages/translate-preview',
      { method: 'POST', body: JSON.stringify({ conversationId, text }) },
    ),
  /**
   * preTranslated: true 时 body 必须是员工在预览框里最终确认过的文本，服务端原样发出、
   * 不再翻译一次——重译结果可能和预览不一致，那样"先看后发"就没意义了。
   * targetLang 在 preTranslated: true 时服务端会忽略，只在 preTranslated: false（旧行为）时使用。
   */
  send: (conversationId: string, body: string, opts: { preTranslated: boolean; targetLang?: string }) =>
    request<{ platformMessageId: string; sentText: string; provider?: string }>('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify({ conversationId, body, preTranslated: opts.preTranslated, targetLang: opts.targetLang }),
    }),
  /** targetLang 为 null 表示解锁、恢复自动跟随客户语言。 */
  updateTargetLang: (conversationId: string, targetLang: string | null) =>
    request<{ id: string; targetLang: string | null }>(
      `/api/conversations/${conversationId}/target-lang`,
      { method: 'PATCH', body: JSON.stringify({ targetLang }) },
    ),
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
