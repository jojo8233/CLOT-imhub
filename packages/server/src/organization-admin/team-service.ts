import type { Kysely, Transaction } from 'kysely'
import type {
  Actor,
  AdminMutationPreview,
  AdminTeam,
  AdminTeamCreate,
  AdminUser,
} from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { assertOwner } from './admin-guard.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import {
  AdminOperationTokenService,
  type AdminRevisionSnapshot,
} from './operation-token.js'
import { OrganizationReadRepo } from './read-repo.js'

export type TeamBlockerCode =
  | 'MANAGER_INVALID'
  | 'AGENT_INVALID'
  | 'TEAM_ARCHIVED'
  | 'TEAM_NOT_ARCHIVED'
  | 'MANAGER_UNCHANGED'
  | 'CLIENT_UPDATE_REQUIRED'

export interface TeamBlocker {
  code: TeamBlockerCode
  count: number
}

export type TeamMutationResult =
  | { kind: 'changed'; team: AdminTeam; affectedUserIds: string[] }
  | { kind: 'preview'; preview: AdminMutationPreview }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminTeam }
  | { kind: 'blocked'; blockers: TeamBlocker[] }

export type AgentTeamMutationResult =
  | { kind: 'changed'; user: AdminUser; affectedAccountIds: string[] }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminUser }
  | { kind: 'blocked'; blockers: TeamBlocker[] }

export class TeamAdminServiceError extends Error {
  constructor(readonly code: 'OPERATION_PREVIEW_EXPIRED' | 'CLIENT_UPDATE_REQUIRED') {
    super(code)
    this.name = 'TeamAdminServiceError'
  }
}

interface ManagerChangeTokenInput {
  teamId: string
  managerUserId: string
}

interface ArchiveTokenInput {
  teamId: string
}

export class TeamAdminService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly devices: DeviceService,
    private readonly operationTokens: AdminOperationTokenService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(actor: Actor, input: AdminTeamCreate): Promise<TeamMutationResult> {
    assertOwner(actor)
    return this.db.transaction().execute(async transaction => {
      const manager = await transaction.selectFrom('users')
        .select(['id', 'role', 'disabled_at'])
        .where('id', '=', input.managerUserId)
        .forUpdate()
        .executeTakeFirst()
      if (!manager || manager.role !== 'manager' || manager.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'MANAGER_INVALID', count: 1 }] }
      }
      const row = await transaction.insertInto('teams').values({
        name: input.name.trim(),
      }).returning('id').executeTakeFirstOrThrow()
      await transaction.insertInto('team_members').values({
        team_id: row.id,
        user_id: manager.id,
        is_lead: true,
      }).execute()
      const team = await new OrganizationReadRepo(transaction).getTeam(row.id)
      if (!team) throw new Error('created team disappeared')
      return { kind: 'changed', team, affectedUserIds: [manager.id] }
    })
  }

  async update(
    actor: Actor,
    teamId: string,
    input: { name: string; baseRevision: number },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    return this.db.transaction().execute(async transaction => {
      const current = await transaction.selectFrom('teams').select(['id', 'revision'])
        .where('id', '=', teamId).forUpdate().executeTakeFirst()
      if (!current) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const currentTeam = await readRepo.getTeam(teamId)
      if (!currentTeam) return { kind: 'not_found' }
      if (current.revision !== input.baseRevision) return { kind: 'conflict', current: currentTeam }
      await transaction.updateTable('teams').set(expression => ({
        name: input.name.trim(),
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', '=', teamId).where('revision', '=', input.baseRevision).execute()
      const team = await readRepo.getTeam(teamId)
      if (!team) throw new Error('updated team disappeared')
      return { kind: 'changed', team, affectedUserIds: [] }
    })
  }

  async changeAgentTeam(
    actor: Actor,
    agentUserId: string,
    input: { teamId: string | null; baseRevision: number },
  ): Promise<AgentTeamMutationResult> {
    assertOwner(actor)
    return this.db.transaction().execute(async transaction => {
      const user = await transaction.selectFrom('users')
        .select(['id', 'role', 'disabled_at', 'revision'])
        .where('id', '=', agentUserId)
        .forUpdate()
        .executeTakeFirst()
      if (!user) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const currentUser = await readRepo.getUser(agentUserId)
      if (!currentUser) return { kind: 'not_found' }
      if (user.revision !== input.baseRevision) return { kind: 'conflict', current: currentUser }
      if (user.role !== 'agent' || user.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'AGENT_INVALID', count: 1 }] }
      }
      if (input.teamId !== null) {
        const team = await transaction.selectFrom('teams').select('id')
          .where('id', '=', input.teamId)
          .where('disabled_at', 'is', null)
          .forUpdate()
          .executeTakeFirst()
        if (!team) return { kind: 'blocked', blockers: [{ code: 'TEAM_ARCHIVED', count: 1 }] }
      }

      const accounts = await transaction.selectFrom('accounts').select('id')
        .where('owner_user_id', '=', agentUserId).orderBy('id').forUpdate().execute()
      await transaction.deleteFrom('team_members').where('user_id', '=', agentUserId).execute()
      if (input.teamId !== null) {
        await transaction.insertInto('team_members').values({
          team_id: input.teamId,
          user_id: agentUserId,
          is_lead: false,
        }).execute()
      }
      if (accounts.length > 0) {
        await transaction.updateTable('accounts').set(expression => ({
          team_id: input.teamId,
          revision: expression('revision', '+', 1),
        })).where('id', 'in', accounts.map(account => account.id)).execute()
      }
      await transaction.updateTable('users').set(expression => ({
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', '=', agentUserId).where('revision', '=', input.baseRevision).execute()
      const changed = await readRepo.getUser(agentUserId)
      if (!changed) throw new Error('moved agent disappeared')
      return {
        kind: 'changed',
        user: changed,
        affectedAccountIds: accounts.map(account => account.id),
      }
    })
  }

  async previewManagerChange(
    actor: Actor,
    teamId: string,
    input: { managerUserId: string; baseRevision: number },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    const readRepo = new OrganizationReadRepo(this.db)
    const team = await readRepo.getTeam(teamId)
    if (!team) return { kind: 'not_found' }
    if (team.revision !== input.baseRevision) return { kind: 'conflict', current: team }
    if (team.disabledAt) return { kind: 'blocked', blockers: [{ code: 'TEAM_ARCHIVED', count: 1 }] }
    if (team.managerUserId === input.managerUserId) {
      return { kind: 'blocked', blockers: [{ code: 'MANAGER_UNCHANGED', count: 1 }] }
    }
    const candidate = await this.db.selectFrom('users')
      .select(['id', 'role', 'disabled_at', 'revision'])
      .where('id', '=', input.managerUserId).executeTakeFirst()
    if (!candidate || candidate.role !== 'manager' || candidate.disabled_at) {
      return { kind: 'blocked', blockers: [{ code: 'MANAGER_INVALID', count: 1 }] }
    }
    const snapshot = await snapshotTeamRows(
      this.db,
      actor.userId,
      teamId,
      [candidate.id],
    )
    const revisions = snapshotRevisions(snapshot)
    const issued = await this.operationTokens.issue<ManagerChangeTokenInput>({
      kind: 'change_team_manager',
      ownerUserId: actor.userId,
      input: { teamId, managerUserId: input.managerUserId },
      revisions,
    })
    return {
      kind: 'preview',
      preview: {
        ...issued,
        summary: {
          accountsTransferred: snapshot.accounts
            .filter(account => account.owner_user_id === team.managerUserId).length,
          membershipsChanged: 2,
        },
      },
    }
  }

  async executeManagerChange(
    actor: Actor,
    teamId: string,
    input: { operationToken: string },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    const verified = await this.verifyToken<ManagerChangeTokenInput>(
      input.operationToken,
      'change_team_manager',
      actor.userId,
    )
    if (verified.input.teamId !== teamId) throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    return this.db.transaction().execute(async transaction => {
      const snapshot = await this.lockTeamOperationRows(
        transaction,
        actor.userId,
        teamId,
        [verified.input.managerUserId],
      )
      if (!snapshot.team) return { kind: 'not_found' }
      const current = await new OrganizationReadRepo(transaction).getTeam(teamId)
      if (!current) return { kind: 'not_found' }
      if (!revisionsMatch(verified.revisions, snapshot)) {
        throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      }
      if (snapshot.team.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'TEAM_ARCHIVED', count: 1 }] }
      }
      const candidate = snapshot.users.find(user => user.id === verified.input.managerUserId)
      if (!candidate || candidate.role !== 'manager' || candidate.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'MANAGER_INVALID', count: 1 }] }
      }
      const owner = snapshot.users.find(user => user.role === 'owner' && !user.disabled_at)
      if (!owner) throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      const oldManagerId = current.managerUserId
      for (const account of snapshot.accounts.filter(row => row.owner_user_id === oldManagerId)) {
        const cleanup = await this.devices.enqueueOwnershipChange({
          accountId: account.id,
          previousOwnerUserId: account.owner_user_id,
          connectionMode: account.connection_mode,
        }, {}, new DeviceRepo(transaction))
        if (cleanup.unsupportedOnlineInstallations > 0) {
          throw new TeamAdminServiceError('CLIENT_UPDATE_REQUIRED')
        }
        await transaction.updateTable('accounts').set(expression => ({
          owner_user_id: owner.id,
          revision: expression('revision', '+', 1),
          native_control_version: expression('native_control_version', '+', 1),
        })).where('id', '=', account.id).execute()
      }
      await transaction.deleteFrom('team_members')
        .where('team_id', '=', teamId).where('is_lead', '=', true).execute()
      await transaction.insertInto('team_members').values({
        team_id: teamId,
        user_id: candidate.id,
        is_lead: true,
      }).execute()
      await transaction.updateTable('teams').set(expression => ({
        revision: expression('revision', '+', 1), updated_at: this.now(),
      })).where('id', '=', teamId).execute()
      const team = await new OrganizationReadRepo(transaction).getTeam(teamId)
      if (!team) throw new Error('manager-changed team disappeared')
      return {
        kind: 'changed',
        team,
        affectedUserIds: uniqueSorted([oldManagerId, candidate.id, owner.id]),
      }
    })
  }

  async previewArchive(
    actor: Actor,
    teamId: string,
    input: { baseRevision: number },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    const team = await new OrganizationReadRepo(this.db).getTeam(teamId)
    if (!team) return { kind: 'not_found' }
    if (team.revision !== input.baseRevision) return { kind: 'conflict', current: team }
    if (team.disabledAt) return { kind: 'blocked', blockers: [{ code: 'TEAM_ARCHIVED', count: 1 }] }
    const snapshot = await this.snapshotTeamOperation(actor.userId, teamId)
    const revisions = snapshotRevisions(snapshot)
    const issued = await this.operationTokens.issue<ArchiveTokenInput>({
      kind: 'archive_team',
      ownerUserId: actor.userId,
      input: { teamId },
      revisions,
    })
    return {
      kind: 'preview',
      preview: {
        ...issued,
        summary: {
          accountsChanged: snapshot.accounts.length,
          accountsTransferred: snapshot.accounts
            .filter(account => account.owner_user_id === team.managerUserId).length,
          membershipsRemoved: snapshot.memberships.length,
        },
      },
    }
  }

  async executeArchive(
    actor: Actor,
    teamId: string,
    input: { operationToken: string },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    const verified = await this.verifyToken<ArchiveTokenInput>(
      input.operationToken,
      'archive_team',
      actor.userId,
    )
    if (verified.input.teamId !== teamId) throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    return this.db.transaction().execute(async transaction => {
      const snapshot = await this.lockTeamOperationRows(transaction, actor.userId, teamId, [])
      if (!snapshot.team) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const current = await readRepo.getTeam(teamId)
      if (!current) return { kind: 'not_found' }
      if (!revisionsMatch(verified.revisions, snapshot)) {
        throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      }
      if (snapshot.team.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'TEAM_ARCHIVED', count: 1 }] }
      }
      const owner = snapshot.users.find(user => user.role === 'owner' && !user.disabled_at)
      if (!owner) throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      for (const account of snapshot.accounts) {
        const ownershipChanged = account.owner_user_id === current.managerUserId
        if (ownershipChanged) {
          const cleanup = await this.devices.enqueueOwnershipChange({
            accountId: account.id,
            previousOwnerUserId: account.owner_user_id,
            connectionMode: account.connection_mode,
          }, {}, new DeviceRepo(transaction))
          if (cleanup.unsupportedOnlineInstallations > 0) {
            throw new TeamAdminServiceError('CLIENT_UPDATE_REQUIRED')
          }
        }
        await transaction.updateTable('accounts').set(expression => ({
          team_id: null,
          ...(ownershipChanged ? { owner_user_id: owner.id } : {}),
          revision: expression('revision', '+', 1),
          ...(ownershipChanged
            ? { native_control_version: expression('native_control_version', '+', 1) }
            : {}),
        })).where('id', '=', account.id).execute()
      }
      await transaction.deleteFrom('team_members').where('team_id', '=', teamId).execute()
      await transaction.updateTable('teams').set(expression => ({
        disabled_at: this.now(),
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', '=', teamId).execute()
      const team = await readRepo.getTeam(teamId)
      if (!team) throw new Error('archived team disappeared')
      return {
        kind: 'changed',
        team,
        affectedUserIds: uniqueSorted([...snapshot.memberships.map(row => row.user_id), owner.id]),
      }
    })
  }

  async restore(
    actor: Actor,
    teamId: string,
    input: { managerUserId: string; baseRevision: number },
  ): Promise<TeamMutationResult> {
    assertOwner(actor)
    return this.db.transaction().execute(async transaction => {
      const users = await transaction.selectFrom('users')
        .select(['id', 'role', 'disabled_at'])
        .where('id', '=', input.managerUserId).forUpdate().execute()
      const teamRow = await transaction.selectFrom('teams').select(['id', 'disabled_at', 'revision'])
        .where('id', '=', teamId).forUpdate().executeTakeFirst()
      if (!teamRow) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const current = await readRepo.getTeam(teamId)
      if (!current) return { kind: 'not_found' }
      if (teamRow.revision !== input.baseRevision) return { kind: 'conflict', current }
      if (!teamRow.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'TEAM_NOT_ARCHIVED', count: 1 }] }
      }
      const manager = users[0]
      if (!manager || manager.role !== 'manager' || manager.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'MANAGER_INVALID', count: 1 }] }
      }
      await transaction.insertInto('team_members').values({
        team_id: teamId, user_id: manager.id, is_lead: true,
      }).execute()
      await transaction.updateTable('teams').set(expression => ({
        disabled_at: null,
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', '=', teamId).execute()
      const team = await readRepo.getTeam(teamId)
      if (!team) throw new Error('restored team disappeared')
      return { kind: 'changed', team, affectedUserIds: [manager.id] }
    })
  }

  private snapshotTeamOperation(ownerUserId: string, teamId: string) {
    return snapshotTeamRows(this.db, ownerUserId, teamId, [])
  }

  private lockTeamOperationRows(
    transaction: Transaction<Database>,
    ownerUserId: string,
    teamId: string,
    extraUserIds: string[],
  ) {
    return snapshotTeamRows(transaction, ownerUserId, teamId, extraUserIds, true)
  }

  private async verifyToken<T>(token: string, kind: string, ownerUserId: string) {
    try {
      return await this.operationTokens.verify<T>(token, { kind, ownerUserId })
    } catch {
      throw new TeamAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }
  }
}

async function snapshotTeamRows(
  db: Kysely<Database> | Transaction<Database>,
  ownerUserId: string,
  teamId: string,
  extraUserIds: string[],
  lock = false,
) {
  const memberships = await db.selectFrom('team_members').select(['user_id', 'is_lead'])
    .where('team_id', '=', teamId).orderBy('user_id').execute()
  const userIds = uniqueSorted([ownerUserId, ...memberships.map(row => row.user_id), ...extraUserIds])
  let userQuery = db.selectFrom('users').select(['id', 'role', 'disabled_at', 'revision'])
    .where('id', 'in', userIds).orderBy('id')
  if (lock) userQuery = userQuery.forUpdate()
  const users = await userQuery.execute()
  let teamQuery = db.selectFrom('teams').select(['id', 'disabled_at', 'revision'])
    .where('id', '=', teamId)
  if (lock) teamQuery = teamQuery.forUpdate()
  const team = await teamQuery.executeTakeFirst()
  let accountQuery = db.selectFrom('accounts')
    .select(['id', 'owner_user_id', 'connection_mode', 'revision'])
    .where('team_id', '=', teamId).orderBy('id')
  if (lock) accountQuery = accountQuery.forUpdate()
  const accounts = await accountQuery.execute()
  return { users, team, accounts, memberships }
}

function snapshotRevisions(snapshot: Awaited<ReturnType<typeof snapshotTeamRows>>): AdminRevisionSnapshot {
  return {
    users: Object.fromEntries(snapshot.users.map(user => [user.id, user.revision])),
    teams: snapshot.team ? { [snapshot.team.id]: snapshot.team.revision } : {},
    accounts: Object.fromEntries(snapshot.accounts.map(account => [account.id, account.revision])),
  }
}

function revisionsMatch(
  expected: AdminRevisionSnapshot,
  snapshot: Awaited<ReturnType<typeof snapshotTeamRows>>,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(snapshotRevisions(snapshot))
}

function uniqueSorted(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort()
}
