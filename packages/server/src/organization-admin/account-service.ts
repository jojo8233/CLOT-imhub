import type { Kysely, Transaction } from 'kysely'
import type {
  Actor,
  AdminAccount,
  AdminAccountAssignmentPreviewRequest,
  AdminMutationPreview,
} from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { assertOwner } from './admin-guard.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import {
  AdminOperationTokenService,
  type AdminRevisionSnapshot,
} from './operation-token.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

export interface OrganizationPostCommitEffects {
  organizationChangedUserIds: string[]
  cleanupRequestedUserIds: string[]
  revokedUserIds: string[]
}

export type AccountAssignmentBlockerCode =
  | 'TARGET_USER_INVALID'
  | 'TARGET_TEAM_INVALID'
  | 'ASSIGNMENT_UNCHANGED'
  | 'CLIENT_UPDATE_REQUIRED'

export interface AccountAssignmentBlocker {
  code: AccountAssignmentBlockerCode
  count: number
}

export type AccountAssignmentResult =
  | { kind: 'preview'; preview: AdminMutationPreview }
  | { kind: 'assigned'; account: AdminAccount; effects: OrganizationPostCommitEffects }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminAccount }
  | { kind: 'blocked'; blockers: AccountAssignmentBlocker[] }

export class AccountAdminServiceError extends Error {
  constructor(readonly code: 'OPERATION_PREVIEW_EXPIRED' | 'CLIENT_UPDATE_REQUIRED') {
    super(code)
    this.name = 'AccountAdminServiceError'
  }
}

interface NormalizedAssignment {
  accountId: string
  ownerUserId: string
  teamId: string | null
  allowManualCleanup: boolean
}

export class AccountAdminService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly devices: DeviceService,
    private readonly operationTokens: AdminOperationTokenService,
  ) {}

  async previewAssignment(
    actor: Actor,
    input: AdminAccountAssignmentPreviewRequest & { accountId: string },
  ): Promise<AccountAssignmentResult> {
    assertOwner(actor)
    const account = await loadAdminAccount(this.db, input.accountId)
    if (!account) return { kind: 'not_found' }
    if (account.revision !== input.baseRevision) return { kind: 'conflict', current: account }

    const normalized = await normalizeAssignment(
      this.db,
      input.accountId,
      input.ownerUserId,
      input.teamId,
      input.allowManualCleanup,
    )
    if (normalized.kind === 'blocked') return normalized
    if (account.ownerUserId === normalized.input.ownerUserId
      && account.teamId === normalized.input.teamId) {
      return { kind: 'blocked', blockers: [{ code: 'ASSIGNMENT_UNCHANGED', count: 1 }] }
    }

    const cleanup = account.ownerUserId === normalized.input.ownerUserId
      ? emptyCleanupPreview()
      : await this.devices.previewOwnershipChange({
          accountId: account.id,
          previousOwnerUserId: account.ownerUserId,
          connectionMode: account.connectionMode,
        }, { allowManualCleanup: normalized.input.allowManualCleanup })
    if (cleanup.unsupportedOnlineInstallations > 0 && !normalized.input.allowManualCleanup) {
      return {
        kind: 'blocked',
        blockers: [{
          code: 'CLIENT_UPDATE_REQUIRED',
          count: cleanup.unsupportedOnlineInstallations,
        }],
      }
    }

    const revisions = await assignmentRevisions(this.db, account, normalized.input)
    const issued = await this.operationTokens.issue<NormalizedAssignment>({
      kind: 'assign_account',
      ownerUserId: actor.userId,
      input: normalized.input,
      revisions,
    })
    return {
      kind: 'preview',
      preview: {
        ...issued,
        summary: {
          accountsChanged: 1,
          automaticCleanupTasks: cleanup.pendingAutomatic,
          manualCleanupTasks: cleanup.manualRequired,
        },
      },
    }
  }

  async assign(
    actor: Actor,
    input: { accountId: string; operationToken: string },
  ): Promise<AccountAssignmentResult> {
    assertOwner(actor)
    const verified = await this.verifyToken(input.operationToken, actor.userId)
    if (verified.input.accountId !== input.accountId) {
      throw new AccountAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }

    return this.db.transaction().execute(async transaction => {
      const discovered = await transaction.selectFrom('accounts')
        .select(['id', 'owner_user_id'])
        .where('id', '=', input.accountId)
        .executeTakeFirst()
      if (!discovered) return { kind: 'not_found' }

      const userIds = uniqueSorted([discovered.owner_user_id, verified.input.ownerUserId])
      const users = await transaction.selectFrom('users')
        .select(['id', 'role', 'disabled_at', 'revision'])
        .where('id', 'in', userIds)
        .orderBy('id')
        .forUpdate()
        .execute()
      const team = verified.input.teamId === null
        ? null
        : await transaction.selectFrom('teams')
          .select(['id', 'disabled_at', 'revision'])
          .where('id', '=', verified.input.teamId)
          .forUpdate()
          .executeTakeFirst() ?? null
      const accountRow = await transaction.selectFrom('accounts')
        .select([
          'id', 'owner_user_id', 'team_id', 'platform', 'connection_mode',
          'display_name', 'status', 'revision',
        ])
        .where('id', '=', input.accountId)
        .forUpdate()
        .executeTakeFirst()
      if (!accountRow) return { kind: 'not_found' }
      const account = await loadAdminAccount(transaction, input.accountId)
      if (!account) return { kind: 'not_found' }
      const currentRevisions = revisionsFromLockedRows(users, team, accountRow)
      if (!revisionsMatch(verified.revisions, currentRevisions)) {
        throw new AccountAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      }

      const normalized = await normalizeAssignment(
        transaction,
        input.accountId,
        verified.input.ownerUserId,
        verified.input.teamId,
        verified.input.allowManualCleanup,
      )
      if (normalized.kind === 'blocked') return normalized
      if (normalized.input.teamId !== verified.input.teamId) {
        throw new AccountAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      }

      const ownershipChanged = accountRow.owner_user_id !== verified.input.ownerUserId
      const cleanup = ownershipChanged
        ? await this.devices.enqueueOwnershipChange({
            accountId: accountRow.id,
            previousOwnerUserId: accountRow.owner_user_id,
            connectionMode: accountRow.connection_mode,
          }, { allowManualCleanup: verified.input.allowManualCleanup }, new DeviceRepo(transaction))
        : emptyCleanupPreview()
      if (cleanup.unsupportedOnlineInstallations > 0 && !verified.input.allowManualCleanup) {
        throw new AccountAdminServiceError('CLIENT_UPDATE_REQUIRED')
      }

      await transaction.updateTable('accounts').set(expression => ({
        owner_user_id: verified.input.ownerUserId,
        team_id: verified.input.teamId,
        revision: expression('revision', '+', 1),
        native_control_version: expression('native_control_version', '+', 1),
      })).where('id', '=', accountRow.id).where('revision', '=', accountRow.revision).executeTakeFirstOrThrow()
      const changed = await loadAdminAccount(transaction, accountRow.id)
      if (!changed) throw new Error('assigned account disappeared')
      const cleanupRequired = cleanup.pendingAutomatic + cleanup.manualRequired > 0
      return {
        kind: 'assigned',
        account: changed,
        effects: {
          organizationChangedUserIds: uniqueSorted([
            accountRow.owner_user_id,
            verified.input.ownerUserId,
          ]),
          cleanupRequestedUserIds: cleanupRequired ? [accountRow.owner_user_id] : [],
          revokedUserIds: [],
        },
      }
    })
  }

  private async verifyToken(token: string, ownerUserId: string) {
    try {
      return await this.operationTokens.verify<NormalizedAssignment>(token, {
        kind: 'assign_account', ownerUserId,
      })
    } catch {
      throw new AccountAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }
  }
}

type NormalizationResult =
  | { kind: 'normalized'; input: NormalizedAssignment }
  | { kind: 'blocked'; blockers: AccountAssignmentBlocker[] }

async function normalizeAssignment(
  db: DatabaseExecutor,
  accountId: string,
  ownerUserId: string,
  requestedTeamId: string | null,
  allowManualCleanup: boolean,
): Promise<NormalizationResult> {
  const user = await db.selectFrom('users')
    .select(['id', 'role', 'disabled_at'])
    .where('id', '=', ownerUserId)
    .executeTakeFirst()
  if (!user || user.disabled_at || user.role === 'auditor') {
    return { kind: 'blocked', blockers: [{ code: 'TARGET_USER_INVALID', count: 1 }] }
  }

  let teamId = requestedTeamId
  if (user.role === 'agent') {
    const teams = await db.selectFrom('team_members as member')
      .innerJoin('teams as team', 'team.id', 'member.team_id')
      .select('team.id')
      .where('member.user_id', '=', user.id)
      .where('member.is_lead', '=', false)
      .where('team.disabled_at', 'is', null)
      .orderBy('team.id')
      .execute()
    if (teams.length > 1) {
      return { kind: 'blocked', blockers: [{ code: 'TARGET_TEAM_INVALID', count: teams.length }] }
    }
    teamId = teams[0]?.id ?? null
  } else if (user.role === 'manager') {
    if (teamId === null) {
      return { kind: 'blocked', blockers: [{ code: 'TARGET_TEAM_INVALID', count: 1 }] }
    }
    const ledTeam = await db.selectFrom('team_members as member')
      .innerJoin('teams as team', 'team.id', 'member.team_id')
      .select('team.id')
      .where('member.user_id', '=', user.id)
      .where('member.team_id', '=', teamId)
      .where('member.is_lead', '=', true)
      .where('team.disabled_at', 'is', null)
      .executeTakeFirst()
    if (!ledTeam) {
      return { kind: 'blocked', blockers: [{ code: 'TARGET_TEAM_INVALID', count: 1 }] }
    }
  } else if (teamId !== null) {
    const team = await db.selectFrom('teams').select('id')
      .where('id', '=', teamId)
      .where('disabled_at', 'is', null)
      .executeTakeFirst()
    if (!team) {
      return { kind: 'blocked', blockers: [{ code: 'TARGET_TEAM_INVALID', count: 1 }] }
    }
  }

  return {
    kind: 'normalized',
    input: { accountId, ownerUserId, teamId, allowManualCleanup },
  }
}

async function assignmentRevisions(
  db: DatabaseExecutor,
  account: AdminAccount,
  input: NormalizedAssignment,
): Promise<AdminRevisionSnapshot> {
  const userIds = uniqueSorted([account.ownerUserId, input.ownerUserId])
  const users = await db.selectFrom('users').select(['id', 'revision'])
    .where('id', 'in', userIds).orderBy('id').execute()
  const team = input.teamId === null
    ? null
    : await db.selectFrom('teams').select(['id', 'revision'])
      .where('id', '=', input.teamId).executeTakeFirst() ?? null
  return {
    users: Object.fromEntries(users.map(user => [user.id, user.revision])),
    teams: team ? { [team.id]: team.revision } : {},
    accounts: { [account.id]: account.revision },
  }
}

function revisionsFromLockedRows(
  users: Array<{ id: string; revision: number }>,
  team: { id: string; revision: number } | null,
  account: { id: string; revision: number },
): AdminRevisionSnapshot {
  return {
    users: Object.fromEntries(users.map(user => [user.id, user.revision])),
    teams: team ? { [team.id]: team.revision } : {},
    accounts: { [account.id]: account.revision },
  }
}

function revisionsMatch(expected: AdminRevisionSnapshot, current: AdminRevisionSnapshot): boolean {
  return JSON.stringify(expected) === JSON.stringify(current)
}

export async function loadAdminAccount(
  db: DatabaseExecutor,
  accountId: string,
): Promise<AdminAccount | null> {
  const row = await db.selectFrom('accounts').select([
    'id', 'platform', 'connection_mode', 'display_name', 'status',
    'owner_user_id', 'team_id', 'revision',
  ]).where('id', '=', accountId).executeTakeFirst()
  if (!row) return null
  const tasks = await db.selectFrom('desktop_cleanup_tasks')
    .select(['mode', 'state'])
    .where('account_id', '=', accountId)
    .execute()
  const pending = tasks.filter(task => task.state === 'pending')
  const cleanupState = pending.some(task => task.mode === 'manual_required')
    ? 'manual_required'
    : pending.length > 0
      ? 'pending'
      : tasks.length > 0
        ? 'completed'
        : 'not_required'
  return {
    id: row.id,
    platform: row.platform,
    connectionMode: row.connection_mode,
    displayName: row.display_name,
    status: row.status,
    ownerUserId: row.owner_user_id,
    teamId: row.team_id,
    cleanupState,
    pendingCleanupCount: pending.length,
    revision: row.revision,
  }
}

function emptyCleanupPreview() {
  return { pendingAutomatic: 0, manualRequired: 0, unsupportedOnlineInstallations: 0 }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
