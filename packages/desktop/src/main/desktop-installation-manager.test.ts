import { describe, expect, it, vi } from 'vitest'
import type { DesktopCleanupTask, DesktopInstallationSyncResult } from '@im-hub/shared'

import { DesktopInstallationManager } from './desktop-installation-manager.js'

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555'
const WEB_ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SIGNAL_ACCOUNT_ID = '99999999-8888-4777-8666-555555555555'
const CLEANUP_TASK_ID = '12121212-3434-4567-8abc-909090909090'
const CREDENTIAL = 'credential-sentinel-that-must-stay-in-main-process'
const TOKEN = 'session-token-sentinel'

function task(overrides: Partial<DesktopCleanupTask> = {}): DesktopCleanupTask {
  return {
    id: CLEANUP_TASK_ID,
    installationId: INSTALLATION_ID,
    accountId: WEB_ACCOUNT_ID,
    mode: 'automatic',
    reason: 'ownership_changed',
    state: 'pending',
    createdAt: '2026-09-05T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function successfulSync(accountIds: string[]): DesktopInstallationSyncResult {
  return { readyAccountIds: accountIds, blockedAccountIds: [], manualRequiredAccountIds: [] }
}

describe('DesktopInstallationManager', () => {
  it('登记后先清理并完成自动任务，再同步挂载，设备凭证只放在主进程请求头', async () => {
    const calls: string[] = []
    const requests: Array<{ input: string; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ input: url, init })
      if (url.endsWith('/register')) {
        calls.push('register')
        return json({ registered: true })
      }
      if (url.endsWith('/claim')) {
        calls.push('claim')
        return json({ tasks: [task()] })
      }
      if (url.endsWith(`/${CLEANUP_TASK_ID}/complete`)) {
        calls.push(`complete:${CLEANUP_TASK_ID}`)
        return json({ completed: true })
      }
      calls.push('sync-mounts')
      return json(successfulSync([WEB_ACCOUNT_ID]))
    })
    const purgeAccount = vi.fn(async (accountId: string) => {
      calls.push(`purge:${accountId}`)
    })
    const manager = new DesktopInstallationManager({
      serverUrl: 'http://localhost:4000',
      clientVersion: '1.2.3',
      identity: { installationId: INSTALLATION_ID, credential: CREDENTIAL },
      fetch: fetcher,
      purgeAccount,
    })

    await expect(manager.syncMounts(TOKEN, [WEB_ACCOUNT_ID])).resolves.toEqual(
      successfulSync([WEB_ACCOUNT_ID]),
    )
    expect(calls).toEqual([
      'register',
      'claim',
      `purge:${WEB_ACCOUNT_ID}`,
      `complete:${CLEANUP_TASK_ID}`,
      'sync-mounts',
    ])
    for (const request of requests) {
      expect(request.init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        'X-Im-Hub-Installation-Id': INSTALLATION_ID,
        'X-Im-Hub-Device-Credential': CREDENTIAL,
      })
      expect(String(request.init?.body ?? '')).not.toContain(CREDENTIAL)
    }
  })

  it('自动清理失败时不确认任务，并保持账号阻断以便下次重试', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/register')) return json({ registered: true })
      if (url.endsWith('/claim')) return json({ tasks: [task()] })
      if (url.endsWith('/sync-mounts')) {
        calls.push('sync')
        return json(successfulSync([]))
      }
      calls.push('complete')
      return json({ completed: true })
    })
    const manager = new DesktopInstallationManager({
      serverUrl: 'http://localhost:4000',
      clientVersion: '1.2.3',
      identity: { installationId: INSTALLATION_ID, credential: CREDENTIAL },
      fetch: fetcher,
      purgeAccount: vi.fn().mockRejectedValue(new Error('partition busy')),
    })

    await expect(manager.syncMounts(TOKEN, [WEB_ACCOUNT_ID])).resolves.toEqual({
      readyAccountIds: [],
      blockedAccountIds: [WEB_ACCOUNT_ID],
      manualRequiredAccountIds: [],
    })
    expect(calls).toEqual(['sync'])
  })

  it('忽略已完成的重复任务，Signal/人工任务从不传给分区清理器', async () => {
    const purgeAccount = vi.fn().mockResolvedValue(undefined)
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/register')) return json({ registered: true })
      if (url.endsWith('/claim')) {
        return json({ tasks: [
          task({ state: 'completed', completedAt: '2026-09-05T00:01:00.000Z' }),
          task({
            id: 'abababab-cdcd-4efe-8123-456789abcdef',
            accountId: SIGNAL_ACCOUNT_ID,
            mode: 'manual_required',
            reason: 'signal_official_unlink',
          }),
          task({
            id: 'edededed-abab-4cdc-9234-567890abcdef',
            installationId: '77777777-6666-4555-8444-333333333333',
            accountId: WEB_ACCOUNT_ID,
            mode: 'manual_required',
            reason: 'unsupported_client_override',
          }),
        ] })
      }
      if (url.endsWith('/sync-mounts')) {
        const accountIds = JSON.parse(String(init?.body)).accountIds as string[]
        return json(successfulSync(accountIds))
      }
      throw new Error(`unexpected request ${url}`)
    })
    const manager = new DesktopInstallationManager({
      serverUrl: 'http://localhost:4000',
      clientVersion: '1.2.3',
      identity: { installationId: INSTALLATION_ID, credential: CREDENTIAL },
      fetch: fetcher,
      purgeAccount,
    })

    await expect(manager.syncMounts(TOKEN, [WEB_ACCOUNT_ID, SIGNAL_ACCOUNT_ID])).resolves.toEqual({
      readyAccountIds: [WEB_ACCOUNT_ID],
      blockedAccountIds: [SIGNAL_ACCOUNT_ID],
      manualRequiredAccountIds: [SIGNAL_ACCOUNT_ID],
    })
    expect(purgeAccount).not.toHaveBeenCalled()
  })

  it('批量同步遇到待人工清理时逐账号核对，不把 Signal 交给清理器', async () => {
    const purgeAccount = vi.fn().mockResolvedValue(undefined)
    let bulkAttempted = false
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/register')) return json({ registered: true })
      if (url.endsWith('/claim')) return json({ tasks: [] })
      const accountIds = JSON.parse(String(init?.body)).accountIds as string[]
      if (accountIds.length > 1) {
        bulkAttempted = true
        return json({ code: 'DEVICE_CLEANUP_PENDING' }, 409)
      }
      return accountIds[0] === SIGNAL_ACCOUNT_ID
        ? json({ code: 'DEVICE_CLEANUP_PENDING' }, 409)
        : json(successfulSync(accountIds))
    })
    const manager = new DesktopInstallationManager({
      serverUrl: 'http://localhost:4000',
      clientVersion: '1.2.3',
      identity: { installationId: INSTALLATION_ID, credential: CREDENTIAL },
      fetch: fetcher,
      purgeAccount,
    })

    await expect(manager.syncMounts(TOKEN, [WEB_ACCOUNT_ID, SIGNAL_ACCOUNT_ID])).resolves.toEqual({
      readyAccountIds: [WEB_ACCOUNT_ID],
      blockedAccountIds: [SIGNAL_ACCOUNT_ID],
      manualRequiredAccountIds: [SIGNAL_ACCOUNT_ID],
    })
    expect(bulkAttempted).toBe(true)
    expect(purgeAccount).not.toHaveBeenCalled()
  })
})
