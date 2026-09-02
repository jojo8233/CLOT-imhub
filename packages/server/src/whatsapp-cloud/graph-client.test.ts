import { describe, expect, it, vi } from 'vitest'
import { WhatsAppGraphClient, WhatsAppGraphError } from './graph-client.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function client(fetchImpl: typeof fetch): WhatsAppGraphClient {
  return new WhatsAppGraphClient({
    version: 'v25.0', appId: 'app-test', appSecret: 'secret-test', fetchImpl,
  })
}

describe('WhatsAppGraphClient', () => {
  it('只有 Meta 返回最终 wamid 才报告发送成功', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ messages: [{ id: 'wamid.final' }] }))
    await expect(client(fetchImpl).sendText('opaque-token', 'phone-test', 'customer-test', 'hello'))
      .resolves.toBe('wamid.final')

    const [, init] = fetchImpl.mock.calls[0] ?? []
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer opaque-token' })
    expect(String(init?.body)).not.toContain('opaque-token')
  })

  it('2xx 无最终 ID 与网络中断都归类为 unknown，禁止调用层盲重试', async () => {
    await expect(client(vi.fn(async () => json({ messages: [] }))).sendText(
      'token', 'phone', 'recipient', 'body',
    )).rejects.toMatchObject({ kind: 'unknown', code: 'missing_platform_message_id' })

    await expect(client(vi.fn(async () => { throw new Error('socket reset') })).sendText(
      'token', 'phone', 'recipient', 'body',
    )).rejects.toMatchObject({ kind: 'unknown', code: 'graph_transport_unknown' })
  })

  it('4xx 是明确失败但不回显 Meta 响应正文；408/5xx 保持 unknown', async () => {
    const promise = client(vi.fn(async () => json({ error: { message: 'sensitive detail' } }, 400)))
      .sendText('token', 'phone', 'recipient', 'body')
    await expect(promise).rejects.toMatchObject({ kind: 'definite', code: 'graph_http_400' })
    await expect(promise).rejects.not.toThrow('sensitive detail')

    await expect(client(vi.fn(async () => json({}, 408))).sendText(
      'token', 'phone', 'recipient', 'body',
    )).rejects.toMatchObject({ kind: 'unknown', code: 'graph_http_408' })
    await expect(client(vi.fn(async () => json({}, 503))).sendText(
      'token', 'phone', 'recipient', 'body',
    )).rejects.toMatchObject({ kind: 'unknown', code: 'graph_http_503' })
  })

  it('授权时验证 phone-number id 确实属于 WABA 并订阅 Webhook', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'opaque-token' }))
      .mockResolvedValueOnce(json({ data: [{ id: 'phone-selected' }] }))
      .mockResolvedValueOnce(json({ success: true }))
    const graph = client(fetchImpl)
    await expect(graph.exchangeEmbeddedSignupCode('short-code')).resolves.toBe('opaque-token')
    await expect(graph.assertPhoneBelongsToWaba('opaque-token', 'waba', 'phone-selected')).resolves.toBeUndefined()
    await expect(graph.subscribeWaba('opaque-token', 'waba')).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('Graph 版本必须显式且合法', () => {
    expect(() => new WhatsAppGraphClient({
      version: 'latest', appId: 'app', appSecret: 'secret', fetchImpl: vi.fn(),
    })).toThrow('invalid Graph API version')
    expect(WhatsAppGraphError).toBeDefined()
  })
})
