import type {
  AdminMutationPreview,
  AdminPage,
  AdminTeam,
  AdminTeamSearchRequest,
} from '@im-hub/shared'
import { api, HttpError, NetworkError } from '../api/client.js'
import { currentSnapshotRecord, type MutationOutcome } from './employee-controller.js'
import { RequestController, type RequestSnapshot } from './request-controller.js'

export interface TeamManagerDraft { managerUserId: string }

export interface TeamControllerDependencies {
  search(filters: AdminTeamSearchRequest, signal: AbortSignal): Promise<AdminPage<AdminTeam>>
  previewChange(teamId: string, draft: TeamManagerDraft & { baseRevision: number }): Promise<AdminMutationPreview>
  executeChange(teamId: string, operationToken: string): Promise<AdminTeam>
}

export interface TeamControllerSnapshot extends RequestSnapshot<AdminTeam, AdminTeamSearchRequest> {
  preview: AdminMutationPreview | null
  draft: TeamManagerDraft | null
  outcome: MutationOutcome
}

const defaultDependencies: TeamControllerDependencies = {
  search: (filters, signal) => api.searchAdminTeams(filters, signal),
  previewChange: async (teamId, input) =>
    (await api.previewAdminTeamManagerChange(teamId, input)).preview,
  executeChange: async (teamId, token) => (await api.changeAdminTeamManager(teamId, token)).team,
}

export class TeamController {
  private readonly requests: RequestController<AdminTeam, AdminTeamSearchRequest>
  private previewValue: AdminMutationPreview | null = null
  private draftValue: TeamManagerDraft | null = null
  private target: { id: string; revision: number } | null = null
  private outcomeValue: MutationOutcome = 'idle'
  private previewGeneration = 0
  private activeExecution: Promise<AdminTeam | null> | null = null

  constructor(
    ownerIdentity: string,
    private readonly dependencies: TeamControllerDependencies = defaultDependencies,
  ) {
    this.requests = new RequestController(ownerIdentity, dependencies.search)
  }

  snapshot(): TeamControllerSnapshot {
    return {
      ...this.requests.snapshot(), preview: this.previewValue,
      draft: this.draftValue, outcome: this.outcomeValue,
    }
  }

  setOwnerIdentity(value: string): void {
    this.cancel()
    this.requests.setOwnerIdentity(value)
  }

  load(filters: AdminTeamSearchRequest): Promise<void> {
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

  async previewChange(team: AdminTeam, draft: TeamManagerDraft): Promise<void> {
    const generation = ++this.previewGeneration
    this.target = { id: team.id, revision: team.revision }
    this.draftValue = { ...draft }
    this.previewValue = null
    this.outcomeValue = 'previewing'
    try {
      const preview = await this.dependencies.previewChange(team.id, {
        ...draft, baseRevision: team.revision,
      })
      const current = this.requests.snapshot().items.find(item => item.id === team.id)
      if (generation !== this.previewGeneration || current?.revision !== team.revision) {
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

  preview(team: AdminTeam, draft: TeamManagerDraft): Promise<void> {
    return this.previewChange(team, draft)
  }

  executeChange(): Promise<AdminTeam | null> {
    if (this.activeExecution) return this.activeExecution
    if (!this.target || !this.previewValue || this.outcomeValue !== 'ready') {
      return Promise.reject(new Error('团队变更预览不可用'))
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

  execute(): Promise<AdminTeam | null> {
    return this.executeChange()
  }

  private async executeOnce(
    teamId: string,
    operationToken: string,
    ownerIdentity: string,
  ): Promise<AdminTeam | null> {
    try {
      const team = await this.dependencies.executeChange(teamId, operationToken)
      if (ownerIdentity !== this.requests.snapshot().ownerIdentity) return null
      this.requests.replace(team)
      this.previewValue = null
      this.draftValue = null
      this.target = null
      this.outcomeValue = 'idle'
      return team
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
        const current = currentAdminTeamSnapshot(error)
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

function currentAdminTeamSnapshot(error: HttpError): AdminTeam | null {
  const value = currentSnapshotRecord(error)
  if (!value
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || (typeof value.managerUserId !== 'string' && value.managerUserId !== null)
    || typeof value.agentCount !== 'number'
    || typeof value.accountCount !== 'number'
    || (typeof value.disabledAt !== 'string' && value.disabledAt !== null)
    || typeof value.revision !== 'number') return null
  return {
    id: value.id,
    name: value.name,
    managerUserId: value.managerUserId,
    agentCount: value.agentCount,
    accountCount: value.accountCount,
    disabledAt: value.disabledAt,
    revision: value.revision,
  }
}
