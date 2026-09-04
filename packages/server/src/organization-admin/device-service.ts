import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  AccountConnectionMode,
  Actor,
  DesktopCleanupTask,
  DesktopInstallationCapability,
  DesktopInstallationSyncResult,
} from '@im-hub/shared'
import { DeviceRepo, type InstallationMount } from './device-repo.js'

const COMPLETED_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const ONLINE_INSTALLATION_WINDOW_MS = 5 * 60 * 1_000

export type DeviceServiceErrorCode =
  | 'DEVICE_CREDENTIAL_INVALID'
  | 'DEVICE_CLEANUP_PENDING'
  | 'ACCOUNT_NOT_OWNED'
  | 'TASK_NOT_FOUND'
  | 'TASK_INVALID_STATE'
  | 'OWNER_REQUIRED'

export class DeviceServiceError extends Error {
  constructor(readonly code: DeviceServiceErrorCode) {
    super(code)
    this.name = 'DeviceServiceError'
  }
}

export interface DeviceRegistrationInput {
  installationId: string
  credential: string
  clientVersion: string
  capabilities: DesktopInstallationCapability[]
}

export interface DeviceIdentity {
  installationId: string
  credential: string
}

export interface OwnershipChange {
  accountId: string
  previousOwnerUserId: string
  connectionMode: AccountConnectionMode
}

export interface CleanupEnqueueResult {
  pendingAutomatic: number
  manualRequired: number
  unsupportedOnlineInstallations: number
}

export class DeviceService {
  constructor(
    private readonly repo: DeviceRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async register(actor: Actor, input: DeviceRegistrationInput): Promise<{ registered: true }> {
    void actor
    await this.repo.transaction(async repo => {
      const current = await repo.findInstallation(input.installationId, true)
      if (!current) {
        await repo.createInstallation({
          id: input.installationId,
          credentialSha256: credentialDigest(input.credential).toString('hex'),
          clientVersion: input.clientVersion,
          capabilities: uniqueCapabilities(input.capabilities),
          now: this.now(),
        })
        return
      }
      assertCredential(current.credentialSha256, input.credential)
      if (current.revokedAt) throw new DeviceServiceError('DEVICE_CREDENTIAL_INVALID')
      await repo.touchInstallation(input.installationId, {
        clientVersion: input.clientVersion,
        capabilities: uniqueCapabilities(input.capabilities),
        now: this.now(),
      })
    })
    return { registered: true }
  }

  async heartbeat(
    actor: Actor,
    input: DeviceRegistrationInput,
  ): Promise<{ accepted: true }> {
    void actor
    await this.repo.transaction(async repo => {
      await this.authenticate(repo, input)
      await repo.touchInstallation(input.installationId, {
        clientVersion: input.clientVersion,
        capabilities: uniqueCapabilities(input.capabilities),
        now: this.now(),
      })
    })
    return { accepted: true }
  }

  async syncMounts(
    actor: Actor,
    input: DeviceIdentity & { accountIds: string[] },
  ): Promise<DesktopInstallationSyncResult> {
    const accountIds = [...new Set(input.accountIds)].sort()
    return this.repo.transaction(async repo => {
      await this.authenticate(repo, input)
      const accounts = await repo.findAccounts(accountIds)
      if (accounts.length !== accountIds.length
        || accounts.some(account => account.owner_user_id !== actor.userId)) {
        throw new DeviceServiceError('ACCOUNT_NOT_OWNED')
      }
      const blocked = await repo.pendingTaskAccountIds(input.installationId, accountIds)
      if (blocked.length > 0) throw new DeviceServiceError('DEVICE_CLEANUP_PENDING')

      await repo.upsertMounts(input.installationId, actor.userId, accountIds, this.now())
      return {
        readyAccountIds: accountIds,
        blockedAccountIds: [],
        manualRequiredAccountIds: [],
      }
    })
  }

  async claimAutomaticTasks(
    actor: Actor,
    input: DeviceIdentity,
  ): Promise<{ tasks: DesktopCleanupTask[] }> {
    void actor
    return this.repo.transaction(async repo => {
      await this.authenticate(repo, input)
      await repo.deleteCompletedBefore(new Date(this.now().getTime() - COMPLETED_TASK_RETENTION_MS))
      return { tasks: await repo.listAutomaticTasks(input.installationId) }
    })
  }

  async completeAutomaticTask(
    actor: Actor,
    input: DeviceIdentity & { taskId: string },
  ): Promise<{ completed: true }> {
    void actor
    return this.repo.transaction(async repo => {
      await this.authenticate(repo, input)
      const task = await repo.findCleanupTask(input.taskId, true)
      if (!task || task.installationId !== input.installationId) {
        throw new DeviceServiceError('TASK_NOT_FOUND')
      }
      if (task.mode !== 'automatic') throw new DeviceServiceError('TASK_INVALID_STATE')
      if (task.state === 'pending') {
        await repo.completeTask(task.id, this.now())
        await repo.deleteMount(input.installationId, task.accountId)
      }
      return { completed: true }
    })
  }

  async confirmManualTask(actor: Actor, taskId: string): Promise<{ confirmed: true }> {
    if (actor.role !== 'owner') throw new DeviceServiceError('OWNER_REQUIRED')
    return this.repo.transaction(async repo => {
      const task = await repo.findCleanupTask(taskId, true)
      if (!task) throw new DeviceServiceError('TASK_NOT_FOUND')
      if (task.mode !== 'manual_required') throw new DeviceServiceError('TASK_INVALID_STATE')
      if (task.state === 'pending') {
        await repo.completeTask(task.id, this.now())
        if (task.installationId) {
          await repo.deleteMount(task.installationId, task.accountId)
        }
      }
      return { confirmed: true }
    })
  }

  async enqueueOwnershipChange(
    change: OwnershipChange,
    options: { allowManualCleanup?: boolean } = {},
    transactionRepo?: DeviceRepo,
  ): Promise<CleanupEnqueueResult> {
    const execute = (repo: DeviceRepo) => this.enqueueInRepo(repo, change, options)
    return transactionRepo ? execute(transactionRepo) : this.repo.transaction(execute)
  }

  async previewOwnershipChange(
    change: OwnershipChange,
    options: { allowManualCleanup?: boolean } = {},
  ): Promise<CleanupEnqueueResult> {
    if (change.connectionMode === 'cloud_api') return emptyEnqueueResult()
    const mounts = await this.repo.listMounts(change.accountId, change.previousOwnerUserId)
    if (change.connectionMode === 'native_desktop') {
      return {
        pendingAutomatic: 0,
        manualRequired: Math.max(1, mounts.length),
        unsupportedOnlineInstallations: 0,
      }
    }
    if (mounts.length === 0) return emptyEnqueueResult()
    const unsupported = mounts.filter(mount => this.isUnsupportedOnline(mount))
    return {
      pendingAutomatic: mounts.length - (options.allowManualCleanup ? unsupported.length : 0),
      manualRequired: options.allowManualCleanup ? unsupported.length : 0,
      unsupportedOnlineInstallations: unsupported.length,
    }
  }

  private async authenticate(repo: DeviceRepo, input: DeviceIdentity): Promise<void> {
    const installation = await repo.findInstallation(input.installationId, true)
    if (!installation || installation.revokedAt) {
      throw new DeviceServiceError('DEVICE_CREDENTIAL_INVALID')
    }
    assertCredential(installation.credentialSha256, input.credential)
  }

  private async enqueueInRepo(
    repo: DeviceRepo,
    change: OwnershipChange,
    options: { allowManualCleanup?: boolean },
  ): Promise<CleanupEnqueueResult> {
    if (change.connectionMode === 'cloud_api') return emptyEnqueueResult()

    const mounts = await repo.listMounts(change.accountId, change.previousOwnerUserId)
    if (change.connectionMode === 'native_desktop') {
      if (mounts.length === 0) {
        await repo.ensurePendingTask({
          installationId: null,
          accountId: change.accountId,
          mode: 'manual_required',
          reason: 'signal_official_unlink',
        })
        return { pendingAutomatic: 0, manualRequired: 1, unsupportedOnlineInstallations: 0 }
      }
      for (const mount of mounts) {
        await repo.ensurePendingTask({
          installationId: mount.installationId,
          accountId: change.accountId,
          mode: 'manual_required',
          reason: 'signal_official_unlink',
        })
      }
      return {
        pendingAutomatic: 0,
        manualRequired: mounts.length,
        unsupportedOnlineInstallations: 0,
      }
    }

    // 服务端 adapter 没有任何本地挂载时无需清理；一旦桌面端曾上报挂载，
    // 该事实表示它是补丁 webview，必须像 web_shell 一样清掉独立分区。
    if (mounts.length === 0) return emptyEnqueueResult()

    const unsupported = mounts.filter(mount => this.isUnsupportedOnline(mount))
    for (const mount of mounts) {
      const requiresManual = unsupported.some(item => item.installationId === mount.installationId)
        && options.allowManualCleanup === true
      await repo.ensurePendingTask({
        installationId: mount.installationId,
        accountId: change.accountId,
        mode: requiresManual ? 'manual_required' : 'automatic',
        reason: requiresManual ? 'unsupported_client_override' : 'ownership_changed',
      })
    }
    return {
      pendingAutomatic: mounts.length - (options.allowManualCleanup ? unsupported.length : 0),
      manualRequired: options.allowManualCleanup ? unsupported.length : 0,
      unsupportedOnlineInstallations: unsupported.length,
    }
  }

  private isUnsupportedOnline(mount: InstallationMount): boolean {
    return mount.installationRevokedAt === null
      && mount.installationLastSeenAt.getTime()
        >= this.now().getTime() - ONLINE_INSTALLATION_WINDOW_MS
      && !mount.capabilities.includes('partition_cleanup_v1')
  }
}

function credentialDigest(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest()
}

function assertCredential(storedHex: string, credential: string): void {
  const stored = Buffer.from(storedHex, 'hex')
  const candidate = credentialDigest(credential)
  if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
    throw new DeviceServiceError('DEVICE_CREDENTIAL_INVALID')
  }
}

function uniqueCapabilities(
  capabilities: DesktopInstallationCapability[],
): DesktopInstallationCapability[] {
  return [...new Set(capabilities)].sort()
}

function emptyEnqueueResult(): CleanupEnqueueResult {
  return {
    pendingAutomatic: 0,
    manualRequired: 0,
    unsupportedOnlineInstallations: 0,
  }
}
