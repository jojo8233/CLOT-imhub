import { afterEach, describe, expect, it, vi } from 'vitest'
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
})
