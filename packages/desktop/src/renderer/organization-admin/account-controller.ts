import type {
  AdminAccount,
  AdminAccountAssignmentPreviewRequest,
  AdminAccountSearchRequest,
  AdminMutationPreview,
  AdminPage,
} from '@im-hub/shared'
import { api, HttpError, NetworkError } from '../api/client.js'
import { currentSnapshotRecord, type MutationOutcome } from './employee-controller.js'
import { RequestController, type RequestSnapshot } from './request-controller.js'

export type AccountAssignmentDraft = Omit<AdminAccountAssignmentPreviewRequest, 'baseRevision'>

export interface AccountControllerDependencies {
  search(filters: AdminAccountSearchRequest, signal: AbortSignal): Promise<AdminPage<AdminAccount>>
  previewAssignment(
    accountId: string,
    input: AdminAccountAssignmentPreviewRequest,
  ): Promise<AdminMutationPreview>
  executeAssignment(accountId: string, operationToken: string): Promise<AdminAccount>
}

export interface AccountControllerSnapshot extends RequestSnapshot<AdminAccount, AdminAccountSearchRequest> {
  preview: AdminMutationPreview | null
  draft: AccountAssignmentDraft | null
  outcome: MutationOutcome
}

const defaultDependencies: AccountControllerDependencies = {
  search: (filters, signal) => api.searchAdminAccounts(filters, signal),
  previewAssignment: async (accountId, input) =>
    (await api.previewAdminAccountAssignment(accountId, input)).preview,
  executeAssignment: async (accountId, token) =>
    (await api.assignAdminAccount(accountId, { operationToken: token })).account,
}

export class AccountController {
  private readonly requests: RequestController<AdminAccount, AdminAccountSearchRequest>
  private previewValue: AdminMutationPreview | null = null
  private draftValue: AccountAssignmentDraft | null = null
  private target: { id: string; revision: number } | null = null
  private outcomeValue: MutationOutcome = 'idle'
  private previewGeneration = 0
  private activeExecution: Promise<AdminAccount | null> | null = null

  constructor(
    ownerIdentity: string,
    private readonly dependencies: AccountControllerDependencies = defaultDependencies,
  ) {
    this.requests = new RequestController(ownerIdentity, dependencies.search)
  }

  snapshot(): AccountControllerSnapshot {
    return {
      ...this.requests.snapshot(), preview: this.previewValue,
      draft: this.draftValue, outcome: this.outcomeValue,
    }
  }

  setOwnerIdentity(value: string): void {
    this.cancel()
    this.requests.setOwnerIdentity(value)
  }

  load(filters: AdminAccountSearchRequest): Promise<void> {
    this.previewGeneration += 1
    this.previewValue = null
    if (this.outcomeValue !== 'unknown') this.outcomeValue = 'idle'
    return this.requests.load(filters)
  }
  loadMore(): Promise<void> { return this.requests.loadMore() }
  cancel(): void {
    this.previewGeneration += 1
    this.requests.cancel()
    this.previewValue = null
    this.draftValue = null
    this.target = null
    this.outcomeValue = 'idle'
  }

  async previewAssignment(account: AdminAccount, draft: AccountAssignmentDraft): Promise<void> {
    const generation = ++this.previewGeneration
    this.target = { id: account.id, revision: account.revision }
    this.draftValue = { ...draft }
    this.previewValue = null
    this.outcomeValue = 'previewing'
    try {
      const preview = await this.dependencies.previewAssignment(account.id, {
        ...draft, baseRevision: account.revision,
      })
      const current = this.requests.snapshot().items.find(item => item.id === account.id)
      if (generation !== this.previewGeneration || current?.revision !== account.revision) {
        if (generation === this.previewGeneration) this.outcomeValue = 'idle'
        return
      }
      this.previewValue = preview
      this.outcomeValue = 'ready'
    } catch (error) {
      if (generation === this.previewGeneration) this.outcomeValue = 'idle'
      throw error
    }
  }

  preview(account: AdminAccount, draft: AccountAssignmentDraft): Promise<void> {
    return this.previewAssignment(account, draft)
  }

  executeAssignment(): Promise<AdminAccount | null> {
    if (this.activeExecution) return this.activeExecution
    if (!this.target || !this.previewValue || this.outcomeValue !== 'ready') {
      return Promise.reject(new Error('账号转移预览不可用'))
    }
    this.outcomeValue = 'executing'
    const operation = this.executeOnce(
      this.target.id,
      this.previewValue.operationToken,
      this.requests.snapshot().ownerIdentity,
    )
      .finally(() => { this.activeExecution = null })
    this.activeExecution = operation
    return operation
  }

  execute(): Promise<AdminAccount | null> {
    return this.executeAssignment()
  }

  private async executeOnce(
    accountId: string,
    operationToken: string,
    ownerIdentity: string,
  ): Promise<AdminAccount | null> {
    try {
      const account = await this.dependencies.executeAssignment(accountId, operationToken)
      if (ownerIdentity !== this.requests.snapshot().ownerIdentity) return null
      this.requests.replace(account)
      this.previewValue = null
      this.draftValue = null
      this.target = null
      this.outcomeValue = 'idle'
      return account
    } catch (error) {
      if (ownerIdentity !== this.requests.snapshot().ownerIdentity) return null
      if (error instanceof NetworkError) {
        this.previewValue = null
        this.outcomeValue = 'unknown'
        await this.requests.reload()
        this.draftValue = null
        this.target = null
        this.outcomeValue = 'idle'
        return null
      }
      if (error instanceof HttpError && error.code === 'REVISION_CONFLICT') {
        const current = currentAdminAccountSnapshot(error)
        if (current) this.requests.replace(current)
        this.previewValue = null
        this.outcomeValue = 'conflict'
      } else {
        this.outcomeValue = 'idle'
      }
      throw error
    }
  }
}

function currentAdminAccountSnapshot(error: HttpError): AdminAccount | null {
  const value = currentSnapshotRecord(error)
  if (!value
    || typeof value.id !== 'string'
    || !isAdminPlatform(value.platform)
    || !isConnectionMode(value.connectionMode)
    || typeof value.displayName !== 'string'
    || !isAccountStatus(value.status)
    || typeof value.ownerUserId !== 'string'
    || (typeof value.teamId !== 'string' && value.teamId !== null)
    || !isCleanupState(value.cleanupState)
    || typeof value.pendingCleanupCount !== 'number'
    || typeof value.revision !== 'number') return null
  return {
    id: value.id,
    platform: value.platform,
    connectionMode: value.connectionMode,
    displayName: value.displayName,
    status: value.status,
    ownerUserId: value.ownerUserId,
    teamId: value.teamId,
    cleanupState: value.cleanupState,
    pendingCleanupCount: value.pendingCleanupCount,
    revision: value.revision,
  }
}

function isAdminPlatform(value: unknown): value is AdminAccount['platform'] {
  return value === 'telegram' || value === 'signal' || value === 'zoom' || value === 'whatsapp'
}

function isConnectionMode(value: unknown): value is AdminAccount['connectionMode'] {
  return value === 'adapter' || value === 'native_desktop'
    || value === 'web_shell' || value === 'cloud_api'
}

function isAccountStatus(value: unknown): value is AdminAccount['status'] {
  return value === 'pending_auth' || value === 'connected' || value === 'reconnecting'
    || value === 'disconnected' || value === 'degraded'
}

function isCleanupState(value: unknown): value is AdminAccount['cleanupState'] {
  return value === 'not_required' || value === 'pending'
    || value === 'completed' || value === 'manual_required'
}
