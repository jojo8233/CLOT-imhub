import type {
  AdminMutationPreview,
  AdminPage,
  AdminUser,
  AdminUserCreate,
  AdminUserSearchRequest,
} from '@im-hub/shared'
import {
  api,
  HttpError,
  NetworkError,
  type AdminCredentialResult,
  type AdminDisablePreviewInput,
} from '../api/client.js'
import { RequestController, type RequestSnapshot } from './request-controller.js'

export interface EmployeeControllerDependencies {
  search(filters: AdminUserSearchRequest, signal: AbortSignal): Promise<AdminPage<AdminUser>>
  previewDisable(
    userId: string,
    baseRevision: number,
    input: AdminDisablePreviewInput,
  ): Promise<AdminMutationPreview>
  executeDisable(userId: string, operationToken: string): Promise<AdminUser>
  create(input: AdminUserCreate): Promise<AdminCredentialResult>
}

export type MutationOutcome = 'idle' | 'previewing' | 'ready' | 'executing' | 'unknown' | 'conflict'

export interface EmployeeControllerSnapshot extends RequestSnapshot<AdminUser, AdminUserSearchRequest> {
  preview: AdminMutationPreview | null
  draft: AdminDisablePreviewInput | null
  outcome: MutationOutcome
}

const defaultDependencies: EmployeeControllerDependencies = {
  search: (filters, signal) => api.searchAdminUsers(filters, signal),
  previewDisable: async (userId, baseRevision, input) =>
    (await api.previewDisableAdminUser(userId, baseRevision, input)).preview,
  executeDisable: async (userId, operationToken) =>
    (await api.disableAdminUser(userId, operationToken)).user,
  create: input => api.createAdminUser(input),
}

export class EmployeeController {
  private readonly requests: RequestController<AdminUser, AdminUserSearchRequest>
  private previewValue: AdminMutationPreview | null = null
  private draftValue: AdminDisablePreviewInput | null = null
  private target: { id: string; revision: number } | null = null
  private previewGeneration = 0
  private outcomeValue: MutationOutcome = 'idle'
  private activeExecution: Promise<AdminUser | null> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    ownerIdentity: string,
    private readonly dependencies: EmployeeControllerDependencies = defaultDependencies,
  ) {
    this.requests = new RequestController(ownerIdentity, dependencies.search)
  }

  snapshot(): EmployeeControllerSnapshot {
    return {
      ...this.requests.snapshot(),
      preview: this.previewValue,
      draft: this.draftValue,
      outcome: this.outcomeValue,
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setOwnerIdentity(ownerIdentity: string): void {
    this.previewGeneration += 1
    this.previewValue = null
    this.draftValue = null
    this.target = null
    this.outcomeValue = 'idle'
    this.requests.setOwnerIdentity(ownerIdentity)
  }

  load(filters: AdminUserSearchRequest): Promise<void> {
    this.previewGeneration += 1
    this.previewValue = null
    if (this.outcomeValue !== 'unknown') this.outcomeValue = 'idle'
    return this.requests.load(filters)
  }

  loadMore(): Promise<void> {
    return this.requests.loadMore()
  }

  cancel(): void {
    this.previewGeneration += 1
    this.requests.cancel()
    this.previewValue = null
    this.draftValue = null
    this.target = null
    this.outcomeValue = 'idle'
  }

  async previewDisable(user: AdminUser, draft: AdminDisablePreviewInput): Promise<void> {
    const generation = ++this.previewGeneration
    this.draftValue = structuredClone(draft)
    this.target = { id: user.id, revision: user.revision }
    this.previewValue = null
    this.outcomeValue = 'previewing'
    try {
      const preview = await this.dependencies.previewDisable(user.id, user.revision, draft)
      const current = this.requests.snapshot().items.find(item => item.id === user.id)
      if (generation !== this.previewGeneration || current?.revision !== user.revision) {
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

  preview(user: AdminUser, draft: AdminDisablePreviewInput): Promise<void> {
    return this.previewDisable(user, draft)
  }

  executeDisable(): Promise<AdminUser | null> {
    if (this.activeExecution) return this.activeExecution
    const preview = this.previewValue
    const userId = this.target?.id ?? null
    if (!preview || !userId || this.outcomeValue !== 'ready') {
      return Promise.reject(new Error('停用预览不可用'))
    }
    this.outcomeValue = 'executing'
    this.notify()
    const operation = this.executeDisableOnce(
      userId,
      preview.operationToken,
      this.requests.snapshot().ownerIdentity,
    )
      .finally(() => { this.activeExecution = null })
    this.activeExecution = operation
    return operation
  }

  execute(): Promise<AdminUser | null> {
    return this.executeDisable()
  }

  async create(input: AdminUserCreate): Promise<AdminCredentialResult> {
    // 凭证只经返回值交给调用方弹窗；控制器不保留它。
    const ownerIdentity = this.requests.snapshot().ownerIdentity
    const result = await this.dependencies.create(input)
    if (ownerIdentity !== this.requests.snapshot().ownerIdentity) {
      throw new Error('组织管理会话已变化')
    }
    return result
  }

  private async executeDisableOnce(
    userId: string,
    operationToken: string,
    ownerIdentity: string,
  ): Promise<AdminUser | null> {
    try {
      const user = await this.dependencies.executeDisable(userId, operationToken)
      if (ownerIdentity !== this.requests.snapshot().ownerIdentity) return null
      this.requests.replace(user)
      this.previewValue = null
      this.draftValue = null
      this.target = null
      this.outcomeValue = 'idle'
      this.notify()
      return user
    } catch (error) {
      if (ownerIdentity !== this.requests.snapshot().ownerIdentity) return null
      if (error instanceof NetworkError) {
        this.previewValue = null
        this.outcomeValue = 'unknown'
        this.notify()
        try {
          await this.requests.reload()
          this.draftValue = null
          this.target = null
          this.outcomeValue = 'idle'
          this.notify()
          return null
        } catch {
          // 刷新也失败时保持 unknown，禁止用户重复发出结果未知的命令。
          throw error
        }
      }
      if (error instanceof HttpError && error.code === 'REVISION_CONFLICT') {
        const current = currentAdminUserSnapshot(error)
        if (current) this.requests.replace(current)
        this.previewValue = null
        this.outcomeValue = 'conflict'
      } else {
        this.outcomeValue = 'idle'
      }
      this.notify()
      throw error
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export function currentSnapshotRecord(error: HttpError): Record<string, unknown> | null {
  if (!record(error.details) || !record(error.details.current)) return null
  return error.details.current
}

function currentAdminUserSnapshot(error: HttpError): AdminUser | null {
  const value = currentSnapshotRecord(error)
  if (!value
    || typeof value.id !== 'string'
    || typeof value.email !== 'string'
    || typeof value.displayName !== 'string'
    || !isAdminUserRole(value.role)
    || (typeof value.disabledAt !== 'string' && value.disabledAt !== null)
    || !Array.isArray(value.teamIds)
    || !value.teamIds.every(teamId => typeof teamId === 'string')
    || typeof value.ownedAccountCount !== 'number'
    || typeof value.revision !== 'number') return null
  return {
    id: value.id,
    email: value.email,
    displayName: value.displayName,
    role: value.role,
    disabledAt: value.disabledAt,
    teamIds: value.teamIds,
    ownedAccountCount: value.ownedAccountCount,
    revision: value.revision,
  }
}

function isAdminUserRole(value: unknown): value is AdminUser['role'] {
  return value === 'owner' || value === 'auditor' || value === 'manager' || value === 'agent'
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
