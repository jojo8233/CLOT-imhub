import { z } from 'zod'

const tokenResponse = z.object({ access_token: z.string().min(1) })
const phoneListResponse = z.object({ data: z.array(z.object({ id: z.string().min(1) })) })
const successResponse = z.object({ success: z.literal(true) })
const sendResponse = z.object({
  messages: z.array(z.object({ id: z.string().regex(/^wamid\./) })).min(1),
})

export type WhatsAppGraphFailureKind = 'definite' | 'unknown'

export class WhatsAppGraphError extends Error {
  constructor(
    message: string,
    public readonly kind: WhatsAppGraphFailureKind,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'WhatsAppGraphError'
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface WhatsAppGraphClientOptions {
  version: string
  appId: string
  appSecret: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

/**
 * 单次 Graph 调用封装。这里刻意没有重试器：发送超时可能已被 Meta 接受，自动重试会重复发信。
 */
export class WhatsAppGraphClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: WhatsAppGraphClientOptions) {
    if (!/^v\d+\.\d+$/.test(options.version)) throw new Error('invalid Graph API version')
    this.baseUrl = `https://graph.facebook.com/${options.version}`
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async exchangeEmbeddedSignupCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.options.appId,
      client_secret: this.options.appSecret,
      code,
    })
    const response = await this.request(`${this.baseUrl}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const parsed = tokenResponse.safeParse(await this.readJson(response))
    if (!parsed.success) throw new WhatsAppGraphError('Meta token 响应不完整', 'definite', 'invalid_token_response')
    return parsed.data.access_token
  }

  async assertPhoneBelongsToWaba(
    accessToken: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(wabaId)}/phone_numbers`)
    url.searchParams.set('fields', 'id')
    url.searchParams.set('limit', '100')
    const response = await this.request(url, { headers: this.auth(accessToken) })
    const parsed = phoneListResponse.safeParse(await this.readJson(response))
    if (!parsed.success || !parsed.data.data.some(phone => phone.id === phoneNumberId)) {
      throw new WhatsAppGraphError('所选号码不属于该 WABA', 'definite', 'phone_waba_mismatch')
    }
  }

  async subscribeWaba(accessToken: string, wabaId: string): Promise<void> {
    const response = await this.request(
      `${this.baseUrl}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { method: 'POST', headers: this.auth(accessToken) },
    )
    const parsed = successResponse.safeParse(await this.readJson(response))
    if (!parsed.success) {
      throw new WhatsAppGraphError('WABA Webhook 订阅响应不完整', 'definite', 'invalid_subscribe_response')
    }
  }

  async sendText(
    accessToken: string,
    phoneNumberId: string,
    recipient: string,
    body: string,
  ): Promise<string> {
    const response = await this.request(
      `${this.baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { ...this.auth(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          text: { preview_url: false, body },
        }),
      },
    )
    const parsed = sendResponse.safeParse(await this.readJson(response))
    const platformMessageId = parsed.success ? parsed.data.messages[0]?.id : undefined
    if (!platformMessageId) {
      // 2xx 却没有最终 wamid：请求是否被接受无法证明，必须待对账，不能当 definite failure 重发。
      throw new WhatsAppGraphError('Meta 未返回最终消息 ID', 'unknown', 'missing_platform_message_id')
    }
    return platformMessageId
  }

  private auth(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}` }
  }

  private async request(input: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal })
      if (!response.ok) {
        // 4xx（除 request timeout）是平台明确拒绝；408/5xx 可能发生在请求已被上游
        // 接受之后，发送调用层必须按结果未知处理，不能自动换 attempt 重发。
        const kind: WhatsAppGraphFailureKind = response.status === 408 || response.status >= 500
          ? 'unknown'
          : 'definite'
        throw new WhatsAppGraphError(
          kind === 'definite' ? 'Meta Graph API 明确拒绝请求' : 'Meta Graph API 结果未知',
          kind,
          `graph_http_${response.status}`,
        )
      }
      return response
    } catch (error) {
      if (error instanceof WhatsAppGraphError) throw error
      throw new WhatsAppGraphError('Meta Graph API 结果未知', 'unknown', 'graph_transport_unknown')
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new WhatsAppGraphError('Meta Graph API 响应无法解析', 'unknown', 'invalid_graph_json')
    }
  }
}
