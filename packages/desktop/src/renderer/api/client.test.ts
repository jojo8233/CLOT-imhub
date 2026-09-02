import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyCustomerProfile } from '@im-hub/shared'
import { api, logout } from './client.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('desktop API request headers', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await logout()
  })

  it('有 body 才声明 JSON，无 body POST 能进入 Fastify 路由', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        token: 'test-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Test' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        grant: 'test-grant',
        expiresAt: '2026-08-27T00:05:00.000Z',
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await api.login('agent@example.com', 'dev-password')
    await api.createNativeControlGrant('c675fe45-aab5-42d3-b3bc-377d3c1d21a6')
    await api.relinkAccount('c675fe45-aab5-42d3-b3bc-377d3c1d21a6')

    const loginHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    const grantHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>
    const relinkHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>
    expect(loginHeaders['Content-Type']).toBe('application/json')
    expect(grantHeaders['Content-Type']).toBeUndefined()
    expect(relinkHeaders['Content-Type']).toBeUndefined()
  })

  it('客户档案 GET 可取消，PUT 发送完整六字段和 expectedRevision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        token: 'test-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Test' },
      }))
      .mockResolvedValueOnce(jsonResponse(emptyCustomerProfile('conversation-1')))
      .mockResolvedValueOnce(jsonResponse({
        ...emptyCustomerProfile('conversation-1'),
        name: 'Synthetic Name',
        revision: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
      }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await api.login('agent@example.test', 'synthetic-password')
    await api.getCustomerProfile('conversation-1', controller.signal)
    await api.updateCustomerProfile('conversation-1', {
      name: 'Synthetic Name',
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      expectedRevision: 0,
    })

    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      '/api/conversations/conversation-1/customer-profile',
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal: controller.signal })
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('PUT')
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      name: 'Synthetic Name',
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      expectedRevision: 0,
    })
  })
})
