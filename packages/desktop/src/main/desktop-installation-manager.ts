import type {
  DesktopCleanupTask,
  DesktopInstallationSyncResult,
} from '@im-hub/shared'
import type { DesktopInstallationIdentity } from './desktop-installation-store.js'

const CLEANUP_PENDING = 'DEVICE_CLEANUP_PENDING'

export interface DesktopInstallationManagerDependencies {
  serverUrl: string
  clientVersion: string
  identity: DesktopInstallationIdentity
  fetch: typeof globalThis.fetch
  purgeAccount(accountId: string): Promise<void>
}

class DesktopInstallationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`desktop installation request failed (${status})`)
    this.name = 'DesktopInstallationRequestError'
  }
}

export class DesktopInstallationManager {
  private readonly completedTaskIds = new Set<string>()

  constructor(private readonly dependencies: DesktopInstallationManagerDependencies) {}

  async syncMounts(token: string, rawAccountIds: string[]): Promise<DesktopInstallationSyncResult> {
    const accountIds = [...new Set(rawAccountIds)]
    await this.request('/api/desktop/installations/register', token, {
      clientVersion: this.dependencies.clientVersion,
      capabilities: ['partition_cleanup_v1'],
    })

    const claimed = parseClaimResponse(await this.request(
      '/api/desktop/cleanup-tasks/claim',
      token,
      {},
    ))
    const blocked = new Set<string>()
    const manual = new Set<string>()

    for (const task of claimed.tasks) {
      if (task.state === 'completed' || this.completedTaskIds.has(task.id)) continue
      if (task.installationId !== this.dependencies.identity.installationId) continue
      if (task.mode === 'manual_required') {
        blocked.add(task.accountId)
        manual.add(task.accountId)
        continue
      }
      try {
        await this.dependencies.purgeAccount(task.accountId)
        await this.request(`/api/desktop/cleanup-tasks/${task.id}/complete`, token, {})
        this.completedTaskIds.add(task.id)
      } catch {
        // 清理或完成确认任一步失败都保持 pending；下次同步会重新领取。
        blocked.add(task.accountId)
      }
    }

    const candidates = accountIds.filter(accountId => !blocked.has(accountId))
    const synced = await this.syncCandidates(token, candidates)
    for (const accountId of synced.blockedAccountIds) blocked.add(accountId)
    for (const accountId of synced.manualRequiredAccountIds) manual.add(accountId)

    return {
      readyAccountIds: synced.readyAccountIds.filter(accountId => !blocked.has(accountId)),
      blockedAccountIds: accountIds.filter(accountId => blocked.has(accountId)),
      manualRequiredAccountIds: accountIds.filter(accountId => manual.has(accountId)),
    }
  }

  private async syncCandidates(
    token: string,
    accountIds: string[],
  ): Promise<DesktopInstallationSyncResult> {
    try {
      return parseSyncResponse(await this.request(
        '/api/desktop/installations/sync-mounts',
        token,
        { accountIds },
      ))
    } catch (error) {
      if (!(error instanceof DesktopInstallationRequestError)
        || error.status !== 409
        || error.code !== CLEANUP_PENDING) {
        throw error
      }
    }

    const readyAccountIds: string[] = []
    const blockedAccountIds: string[] = []
    const manualRequiredAccountIds: string[] = []
    for (const accountId of accountIds) {
      try {
        const result = parseSyncResponse(await this.request(
          '/api/desktop/installations/sync-mounts',
          token,
          { accountIds: [accountId] },
        ))
        readyAccountIds.push(...result.readyAccountIds)
        blockedAccountIds.push(...result.blockedAccountIds)
        manualRequiredAccountIds.push(...result.manualRequiredAccountIds)
      } catch (error) {
        if (error instanceof DesktopInstallationRequestError
          && error.status === 409
          && error.code === CLEANUP_PENDING) {
          blockedAccountIds.push(accountId)
          manualRequiredAccountIds.push(accountId)
          continue
        }
        throw error
      }
    }
    return { readyAccountIds, blockedAccountIds, manualRequiredAccountIds }
  }

  private async request(path: string, token: string, body: unknown): Promise<unknown> {
    const response = await this.dependencies.fetch(`${this.dependencies.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Im-Hub-Installation-Id': this.dependencies.identity.installationId,
        'X-Im-Hub-Device-Credential': this.dependencies.identity.credential,
      },
      body: JSON.stringify(body),
    })
    const value = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const code = record(value) && typeof value.code === 'string' ? value.code : null
      throw new DesktopInstallationRequestError(response.status, code)
    }
    return value
  }
}

function parseClaimResponse(value: unknown): { tasks: DesktopCleanupTask[] } {
  if (!record(value) || !Array.isArray(value.tasks) || !value.tasks.every(isCleanupTask)) {
    throw new Error('桌面清理任务响应无效')
  }
  return { tasks: value.tasks }
}

function isCleanupTask(value: unknown): value is DesktopCleanupTask {
  return record(value)
    && typeof value.id === 'string'
    && (typeof value.installationId === 'string' || value.installationId === null)
    && typeof value.accountId === 'string'
    && (value.mode === 'automatic' || value.mode === 'manual_required')
    && typeof value.reason === 'string'
    && (value.state === 'pending' || value.state === 'completed')
    && typeof value.createdAt === 'string'
    && (typeof value.completedAt === 'string' || value.completedAt === null)
}

function parseSyncResponse(value: unknown): DesktopInstallationSyncResult {
  if (!record(value)
    || !stringArray(value.readyAccountIds)
    || !stringArray(value.blockedAccountIds)
    || !stringArray(value.manualRequiredAccountIds)) {
    throw new Error('桌面挂载同步响应无效')
  }
  return {
    readyAccountIds: value.readyAccountIds,
    blockedAccountIds: value.blockedAccountIds,
    manualRequiredAccountIds: value.manualRequiredAccountIds,
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
