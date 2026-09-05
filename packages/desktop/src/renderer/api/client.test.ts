import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyCustomerProfile, type KeywordRule } from '@im-hub/shared'
import { api, logout, UnauthorizedError } from './client.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function statusResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sessionFixture() {
  const session = {
    save: vi.fn().mockResolvedValue(true),
    load: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
  }
  ;(globalThis as { imHub?: unknown }).imHub = {
    serverUrl: 'http://localhost:4000',
    session,
  }
  return session
}

describe('desktop auth session lifecycle', () => {
  afterEach(async () => {
    await logout()
    delete (globalThis as { imHub?: unknown }).imHub
    vi.unstubAllGlobals()
  })

  it('临时密码登录只保留内存 setup token，绝不持久化', async () => {
    const session = sessionFixture()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      kind: 'password_change_required',
      setupToken: 'setup-token-must-not-persist',
      user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
    })))

    const result = await api.login('agent@example.test', 'temporary-password')

    expect(result.kind).toBe('password_change_required')
    expect(session.save).not.toHaveBeenCalled()
    expect(JSON.stringify(session.save.mock.calls)).not.toContain('setup-token-must-not-persist')
  })

  it('首次改密用专用授权完成，并只持久化返回的普通会话', async () => {
    const session = sessionFixture()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        kind: 'password_change_required',
        setupToken: 'setup-token-main-memory-only',
        user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        kind: 'authenticated',
        token: 'ordinary-session-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await api.login('agent@example.test', 'temporary-password')
    const user = await api.completeInitialPassword('replacement-password')

    expect(user).toEqual({ id: 'user-1', role: 'agent', displayName: 'Agent' })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'InitialPassword setup-token-main-memory-only',
    })
    expect(session.save).toHaveBeenCalledWith({
      token: 'ordinary-session-token',
      user,
    })
    expect(JSON.stringify(session.save.mock.calls)).not.toContain('setup-token-main-memory-only')
  })

  it('普通改密先持久化替换会话，之后请求只使用新 token', async () => {
    const session = sessionFixture()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        kind: 'authenticated',
        token: 'old-session-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        kind: 'authenticated',
        token: 'new-session-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
      }))
      .mockResolvedValueOnce(jsonResponse({ accounts: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const login = await api.login('agent@example.test', 'old-password-value')
    if (login.kind !== 'authenticated') throw new Error('expected authenticated login')
    await api.changePassword('old-password-value', 'replacement-password')
    await api.listAccounts()

    expect(session.save).toHaveBeenLastCalledWith({
      token: 'new-session-token',
      user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
    })
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer new-session-token',
    })
  })

  it('任何普通会话 401 都清除内存和加密存档', async () => {
    const session = sessionFixture()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        kind: 'authenticated',
        token: 'soon-revoked-token',
        user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
      }))
      .mockResolvedValueOnce(statusResponse(401, { error: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)
    const login = await api.login('agent@example.test', 'valid-password')
    if (login.kind !== 'authenticated') throw new Error('expected authenticated login')
    session.clear.mockClear()

    await expect(api.listAccounts()).rejects.toBeInstanceOf(UnauthorizedError)
    expect(session.clear).toHaveBeenCalledOnce()
  })
})

function authenticatedFetch(responseBody: unknown) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({
      token: 'test-token',
      user: { id: 'user-1', role: 'owner', displayName: 'Test' },
    }))
    .mockResolvedValueOnce(jsonResponse(responseBody))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loginSyntheticOwner(): Promise<void> {
  await api.login('owner@example.test', 'synthetic-password')
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

  it('档案库搜索只把关键词放进 POST JSON 并支持取消', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        token: 'test-token',
        user: { id: 'user-1', role: 'owner', displayName: 'Test' },
      }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await api.login('owner@example.test', 'synthetic-password')
    await api.searchCustomerProfiles(
      { q: 'Synthetic query', limit: 50 },
      controller.signal,
    )

    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/customer-profiles/search')
    expect(fetchMock.mock.calls[1]?.[0]).not.toContain('Synthetic')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      signal: controller.signal,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      q: 'Synthetic query',
      limit: 50,
    })
  })
})

describe('organization admin API contracts', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await logout()
  })

  it('员工、团队和账号检索都使用可取消的 POST JSON，不把检索词放入 URL', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ kind: 'authenticated', token: 'owner-token', user: {
        id: 'owner-1', role: 'owner', displayName: 'Owner',
      } }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ items: [], nextCursor: null })))
    vi.stubGlobal('fetch', fetchMock)
    const login = await api.login('owner@example.test', 'owner-password')
    if (login.kind !== 'authenticated') throw new Error('expected owner session')
    const controller = new AbortController()

    await api.searchAdminUsers({ q: 'private@example.test', limit: 20 }, controller.signal)
    await api.searchAdminTeams({ q: 'Private team', limit: 20 }, controller.signal)
    await api.searchAdminAccounts({ q: 'Private account', limit: 20 }, controller.signal)

    for (const request of fetchMock.mock.calls.slice(1)) {
      expect(request[1]).toMatchObject({ method: 'POST', signal: controller.signal })
      expect(String(request[0])).not.toContain('Private')
      expect(String(request[0])).not.toContain('private%40')
    }
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      q: 'private@example.test', limit: 20,
    })
  })

  it('修改与预览传递 base revision，执行只传短时 operation token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ kind: 'authenticated', token: 'owner-token', user: {
        id: 'owner-1', role: 'owner', displayName: 'Owner',
      } }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1', revision: 4 } }))
      .mockResolvedValueOnce(jsonResponse({ preview: {
        operationToken: 'preview-token', expiresAt: '2026-09-05T01:00:00.000Z', summary: {},
      } }))
      .mockResolvedValueOnce(jsonResponse({ account: { id: 'account-1', revision: 6 } }))
    vi.stubGlobal('fetch', fetchMock)
    const login = await api.login('owner@example.test', 'owner-password')
    if (login.kind !== 'authenticated') throw new Error('expected owner session')

    await api.updateAdminUser('user-1', { displayName: 'Renamed', baseRevision: 3 })
    await api.previewAdminAccountAssignment('account-1', {
      ownerUserId: 'user-2', teamId: null, allowManualCleanup: false, baseRevision: 5,
    })
    await api.assignAdminAccount('account-1', { operationToken: 'preview-token' })

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      displayName: 'Renamed', baseRevision: 3,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ baseRevision: 5 })
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      operationToken: 'preview-token',
    })
  })

  it('稳定提取服务端错误 code 与最新快照', async () => {
    const current = { id: 'user-1', revision: 8 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ kind: 'authenticated', token: 'owner-token', user: {
        id: 'owner-1', role: 'owner', displayName: 'Owner',
      } }))
      .mockResolvedValueOnce(statusResponse(409, {
        error: 'revision conflict', code: 'REVISION_CONFLICT', current,
      }))
    vi.stubGlobal('fetch', fetchMock)
    const login = await api.login('owner@example.test', 'owner-password')
    if (login.kind !== 'authenticated') throw new Error('expected owner session')

    await expect(api.updateAdminUser('user-1', {
      displayName: 'Renamed', baseRevision: 7,
    })).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
      details: expect.objectContaining({ current }),
    })
  })
})

describe('keyword alert API contracts', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await logout()
  })

  it('searches with POST JSON outside the URL and forwards the abort signal', async () => {
    const fetchMock = authenticatedFetch({ items: [], nextCursor: 'next-page' })
    const controller = new AbortController()
    await loginSyntheticOwner()

    const result = await api.searchKeywordAlerts({
      status: 'pending',
      severity: 'urgent',
      platform: 'telegram',
      accountId: '00000000-0000-4000-8000-000000000010',
      limit: 50,
      cursor: 'opaque-cursor',
    }, controller.signal)

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe('http://localhost:4000/api/keyword-alerts/search')
    expect(request?.[1]?.method).toBe('POST')
    expect(request?.[1]?.signal).toBe(controller.signal)
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      status: 'pending',
      severity: 'urgent',
      platform: 'telegram',
      accountId: '00000000-0000-4000-8000-000000000010',
      limit: 50,
      cursor: 'opaque-cursor',
    })
    expect(result).toEqual({ items: [], nextCursor: 'next-page' })
  })

  it('gets the unacknowledged count without a request body or signal', async () => {
    const fetchMock = authenticatedFetch({ count: 3 })
    await loginSyntheticOwner()

    const result = await api.getKeywordAlertUnacknowledgedCount()

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe('http://localhost:4000/api/keyword-alerts/unacknowledged-count')
    expect(request?.[1]?.method).toBeUndefined()
    expect(request?.[1]?.body).toBeUndefined()
    expect(request?.[1]?.signal).toBeUndefined()
    expect(result).toEqual({ count: 3 })
  })

  it('acknowledges one alert with PATCH and no request body or signal', async () => {
    const fetchMock = authenticatedFetch({ acknowledgedAt: '2026-09-03T01:00:00.000Z' })
    await loginSyntheticOwner()

    const result = await api.acknowledgeKeywordAlert(
      '00000000-0000-4000-8000-000000000101',
    )

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe(
      'http://localhost:4000/api/keyword-alerts/00000000-0000-4000-8000-000000000101/acknowledge',
    )
    expect(request?.[1]?.method).toBe('PATCH')
    expect(request?.[1]?.body).toBeUndefined()
    expect(request?.[1]?.signal).toBeUndefined()
    expect(result).toEqual({ acknowledgedAt: '2026-09-03T01:00:00.000Z' })
  })

  it('lists keyword rules with GET and no request body or signal', async () => {
    const fetchMock = authenticatedFetch({ rules: [], degradedScanCount: 2 })
    await loginSyntheticOwner()

    const result = await api.listKeywordRules()

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe('http://localhost:4000/api/keyword-rules')
    expect(request?.[1]?.method).toBeUndefined()
    expect(request?.[1]?.body).toBeUndefined()
    expect(request?.[1]?.signal).toBeUndefined()
    expect(result).toEqual({ rules: [], degradedScanCount: 2 })
  })

  it('creates a keyword rule with the shared create body', async () => {
    const rule: KeywordRule = {
      id: '00000000-0000-4000-8000-000000000201',
      pattern: 'Synthetic',
      severity: 'normal',
      enabled: true,
      revision: 1,
      effectiveAt: '2026-09-03T00:00:00.000Z',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    }
    const fetchMock = authenticatedFetch(rule)
    await loginSyntheticOwner()

    const result = await api.createKeywordRule({
      pattern: 'Synthetic', severity: 'normal', enabled: true,
    })

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe('http://localhost:4000/api/keyword-rules')
    expect(request?.[1]?.method).toBe('POST')
    expect(request?.[1]?.signal).toBeUndefined()
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      pattern: 'Synthetic', severity: 'normal', enabled: true,
    })
    expect(result).toEqual(rule)
  })

  it('updates a keyword rule with PATCH and the shared revision body', async () => {
    const rule: KeywordRule = {
      id: '00000000-0000-4000-8000-000000000201',
      pattern: 'Synthetic',
      severity: 'normal',
      enabled: false,
      revision: 2,
      effectiveAt: '2026-09-03T01:00:00.000Z',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T01:00:00.000Z',
    }
    const fetchMock = authenticatedFetch(rule)
    await loginSyntheticOwner()

    const result = await api.updateKeywordRule(rule.id, {
      baseRevision: 1, enabled: false,
    })

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe(`http://localhost:4000/api/keyword-rules/${rule.id}`)
    expect(request?.[1]?.method).toBe('PATCH')
    expect(request?.[1]?.signal).toBeUndefined()
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      baseRevision: 1, enabled: false,
    })
    expect(result).toEqual(rule)
  })

  it('deletes a keyword rule with DELETE and an exact baseRevision body', async () => {
    const fetchMock = authenticatedFetch({ deleted: true })
    await loginSyntheticOwner()

    const result = await api.deleteKeywordRule(
      '00000000-0000-4000-8000-000000000201',
      2,
    )

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe(
      'http://localhost:4000/api/keyword-rules/00000000-0000-4000-8000-000000000201',
    )
    expect(request?.[1]?.method).toBe('DELETE')
    expect(request?.[1]?.signal).toBeUndefined()
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ baseRevision: 2 })
    expect(result).toEqual({ deleted: true })
  })

  it('retries degraded scans with POST and an exact empty JSON body', async () => {
    const fetchMock = authenticatedFetch({ retried: 4 })
    await loginSyntheticOwner()

    const result = await api.retryKeywordAlertScans()

    const request = fetchMock.mock.calls[1]
    expect(request?.[0]).toBe('http://localhost:4000/api/keyword-alert-scans/retry')
    expect(request?.[1]?.method).toBe('POST')
    expect(request?.[1]?.signal).toBeUndefined()
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({})
    expect(result).toEqual({ retried: 4 })
  })
})
