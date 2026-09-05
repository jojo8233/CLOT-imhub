import { sql, type Kysely, type Transaction } from 'kysely'
import type {
  Actor,
  AdminEditableRole,
  AdminMutationPreview,
  AdminOwnerTransferPreviewRequest,
  AdminTeamResolution,
  AdminUser,
  Platform,
  Role,
} from '@im-hub/shared'
import { verifyPassword } from '../auth/password.js'
import type { Database } from '../db/types.js'
import { assertOwner } from './admin-guard.js'
import type { OrganizationPostCommitEffects } from './account-service.js'
import { DeviceRepo } from './device-repo.js'
import { DeviceService } from './device-service.js'
import {
  AdminOperationTokenService,
  type AdminRevisionSnapshot,
} from './operation-token.js'
import { OrganizationReadRepo } from './read-repo.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

export type OwnerTransferBlockerCode =
  | 'TARGET_USER_INVALID'
  | 'CURRENT_OWNER_ROLE_INVALID'
  | 'TEAM_RESOLUTION_INVALID'
  | 'ACCOUNT_RESOLUTION_INVALID'
  | 'CLIENT_UPDATE_REQUIRED'

export interface OwnerTransferBlocker {
  code: OwnerTransferBlockerCode
  count: number
}

export type OwnerTransferResult =
  | { kind: 'preview'; preview: AdminMutationPreview }
  | {
      kind: 'transferred'
      currentOwner: AdminUser
      newOwner: AdminUser
      effects: OrganizationPostCommitEffects
    }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentOwner: AdminUser; targetUser: AdminUser }
  | { kind: 'blocked'; blockers: OwnerTransferBlocker[] }

export class OwnerTransferServiceError extends Error {
  constructor(readonly code: 'OPERATION_PREVIEW_EXPIRED' | 'CLIENT_UPDATE_REQUIRED') {
    super(code)
    this.name = 'OwnerTransferServiceError'
  }
}

type NormalizedTeamResolution =
  | {
      teamId: string
      action: 'replace_manager'
      replacementManagerUserId: string
      baseRevision: number
    }
  | { teamId: string; action: 'archive'; baseRevision: number }

interface NormalizedAccountResolution {
  accountId: string
  ownerUserId: string
  teamId: string | null
  baseRevision: number
}

interface NormalizedTransferInput {
  targetUserId: string
  currentOwnerNextRole: AdminEditableRole
  currentOwnerTeamIds: string[]
  teamResolutions: NormalizedTeamResolution[]
  accountResolutions: NormalizedAccountResolution[]
  allowManualCleanup: boolean
}

type TransferPlan =
  | { kind: 'blocked'; blockers: OwnerTransferBlocker[] }
  | {
      kind: 'plan'
      users: Array<{
        id: string
        role: Role
        disabled_at: Date | null
        revision: number
        password_hash: string
      }>
      teams: Array<{ id: string; revision: number; disabled_at: Date | null }>
      accounts: Array<{
        id: string
        owner_user_id: string
        team_id: string | null
        platform: Platform
        connection_mode: 'adapter' | 'native_desktop' | 'web_shell' | 'cloud_api'
        revision: number
      }>
      memberships: Array<{ team_id: string; user_id: string; is_lead: boolean }>
      revisions: AdminRevisionSnapshot
    }

export class OwnerTransferService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly devices: DeviceService,
    private readonly operationTokens: AdminOperationTokenService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(
    actor: Actor,
    input: AdminOwnerTransferPreviewRequest,
  ): Promise<OwnerTransferResult> {
    assertOwner(actor)
    const readRepo = new OrganizationReadRepo(this.db)
    const [currentOwner, targetUser] = await Promise.all([
      readRepo.getUser(actor.userId),
      readRepo.getUser(input.targetUserId),
    ])
    if (!currentOwner || !targetUser) return { kind: 'not_found' }
    if (currentOwner.revision !== input.currentOwnerBaseRevision
      || targetUser.revision !== input.targetUserBaseRevision) {
      return { kind: 'conflict', currentOwner, targetUser }
    }
    const normalized = normalizeTransferInput(input)
    const plan = await buildTransferPlan(this.db, actor.userId, normalized, false)
    if (plan.kind === 'blocked') return plan

    const cleanup = { automatic: 0, manual: 0, unsupported: 0 }
    for (const resolution of normalized.accountResolutions) {
      const account = plan.accounts.find(row => row.id === resolution.accountId)
      if (!account || account.owner_user_id === resolution.ownerUserId) continue
      const preview = await this.devices.previewOwnershipChange({
        accountId: account.id,
        previousOwnerUserId: account.owner_user_id,
        platform: account.platform,
        connectionMode: account.connection_mode,
      }, { allowManualCleanup: normalized.allowManualCleanup })
      cleanup.automatic += preview.pendingAutomatic
      cleanup.manual += preview.manualRequired
      cleanup.unsupported += preview.unsupportedOnlineInstallations
    }
    if (cleanup.unsupported > 0 && !normalized.allowManualCleanup) {
      return {
        kind: 'blocked',
        blockers: [{ code: 'CLIENT_UPDATE_REQUIRED', count: cleanup.unsupported }],
      }
    }

    const issued = await this.operationTokens.issue<NormalizedTransferInput>({
      kind: 'transfer_owner',
      ownerUserId: actor.userId,
      input: normalized,
      revisions: plan.revisions,
    })
    return {
      kind: 'preview',
      preview: {
        ...issued,
        summary: {
          usersChanged: 2,
          teamsChanged: normalized.teamResolutions.length,
          accountsChanged: normalized.accountResolutions.length,
          automaticCleanupTasks: cleanup.automatic,
          manualCleanupTasks: cleanup.manual,
        },
      },
    }
  }

  async execute(
    actor: Actor,
    input: { operationToken: string; currentPassword: string },
  ): Promise<OwnerTransferResult> {
    assertOwner(actor)
    let verified: { input: NormalizedTransferInput; revisions: AdminRevisionSnapshot }
    try {
      verified = await this.operationTokens.verify<NormalizedTransferInput>(input.operationToken, {
        kind: 'transfer_owner', ownerUserId: actor.userId,
      })
    } catch {
      throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
    }

    return this.db.transaction().execute(async transaction => {
      const plan = await buildTransferPlan(transaction, actor.userId, verified.input, true)
      if (plan.kind === 'blocked') return plan
      if (!revisionsMatch(verified.revisions, plan.revisions)) {
        throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
      }
      const currentOwnerRow = plan.users.find(user => user.id === actor.userId)
      const targetRow = plan.users.find(user => user.id === verified.input.targetUserId)
      if (!currentOwnerRow || !targetRow) return { kind: 'not_found' }
      if (currentOwnerRow.role !== 'owner' || currentOwnerRow.disabled_at
        || targetRow.role === 'owner' || targetRow.disabled_at) {
        throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
      }
      if (!await verifyPassword(currentOwnerRow.password_hash, input.currentPassword)) {
        return { kind: 'forbidden' }
      }

      const cleanupUsers: string[] = []
      for (const resolution of verified.input.accountResolutions) {
        const account = plan.accounts.find(row => row.id === resolution.accountId)
        if (!account) throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
        const ownershipChanged = account.owner_user_id !== resolution.ownerUserId
        const teamChanged = account.team_id !== resolution.teamId
        if (!ownershipChanged && !teamChanged) continue
        if (ownershipChanged) {
          const cleanup = await this.devices.enqueueOwnershipChange({
            accountId: account.id,
            previousOwnerUserId: account.owner_user_id,
            platform: account.platform,
            connectionMode: account.connection_mode,
          }, { allowManualCleanup: verified.input.allowManualCleanup }, new DeviceRepo(transaction))
          if (cleanup.unsupportedOnlineInstallations > 0
            && !verified.input.allowManualCleanup) {
            throw new OwnerTransferServiceError('CLIENT_UPDATE_REQUIRED')
          }
          if (cleanup.pendingAutomatic + cleanup.manualRequired > 0) {
            cleanupUsers.push(account.owner_user_id)
          }
        }
        await transaction.updateTable('accounts').set(expression => ({
          owner_user_id: resolution.ownerUserId,
          team_id: resolution.teamId,
          revision: expression('revision', '+', 1),
          ...(ownershipChanged
            ? { native_control_version: expression('native_control_version', '+', 1) }
            : {}),
        })).where('id', '=', account.id).where('revision', '=', account.revision)
          .executeTakeFirstOrThrow()
      }

      await transaction.deleteFrom('team_members')
        .where('user_id', 'in', [actor.userId, verified.input.targetUserId])
        .execute()
      for (const resolution of verified.input.teamResolutions) {
        if (resolution.action === 'archive') {
          await transaction.deleteFrom('team_members')
            .where('team_id', '=', resolution.teamId).execute()
          await transaction.updateTable('teams').set(expression => ({
            disabled_at: this.now(),
            revision: expression('revision', '+', 1),
            updated_at: this.now(),
          })).where('id', '=', resolution.teamId).execute()
        } else {
          await transaction.deleteFrom('team_members')
            .where('team_id', '=', resolution.teamId)
            .where('is_lead', '=', true)
            .execute()
          await transaction.insertInto('team_members').values({
            team_id: resolution.teamId,
            user_id: resolution.replacementManagerUserId,
            is_lead: true,
          }).onConflict(conflict => conflict.columns(['team_id', 'user_id']).doUpdateSet({
            is_lead: true,
          })).execute()
          await transaction.updateTable('teams').set(expression => ({
            revision: expression('revision', '+', 1),
            updated_at: this.now(),
          })).where('id', '=', resolution.teamId).execute()
        }
      }
      const currentOwnerAgentTeamId = verified.input.currentOwnerTeamIds[0]
      if (verified.input.currentOwnerNextRole === 'agent'
        && currentOwnerAgentTeamId !== undefined) {
        await transaction.insertInto('team_members').values({
          team_id: currentOwnerAgentTeamId,
          user_id: actor.userId,
          is_lead: false,
        }).onConflict(conflict => conflict.columns(['team_id', 'user_id']).doUpdateSet({
          is_lead: false,
        })).execute()
      }

      await transaction.updateTable('users').set(expression => ({
        role: sql<Role>`case
          when id = ${actor.userId} then ${verified.input.currentOwnerNextRole}
          else 'owner'
        end`,
        session_version: expression('session_version', '+', 1),
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', 'in', [actor.userId, verified.input.targetUserId]).execute()
      const enabledOwners = await transaction.selectFrom('users').select('id')
        .where('role', '=', 'owner').where('disabled_at', 'is', null).execute()
      if (enabledOwners.length !== 1 || enabledOwners[0]?.id !== verified.input.targetUserId) {
        throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
      }

      const readRepo = new OrganizationReadRepo(transaction)
      const [currentOwner, newOwner] = await Promise.all([
        readRepo.getUser(actor.userId),
        readRepo.getUser(verified.input.targetUserId),
      ])
      if (!currentOwner || !newOwner) throw new Error('owner transfer users disappeared')
      return {
        kind: 'transferred',
        currentOwner,
        newOwner,
        effects: {
          organizationChangedUserIds: uniqueSorted(plan.users.map(user => user.id)),
          cleanupRequestedUserIds: uniqueSorted(cleanupUsers),
          revokedUserIds: uniqueSorted([actor.userId, verified.input.targetUserId]),
        },
      }
    })
  }
}

function normalizeTransferInput(input: AdminOwnerTransferPreviewRequest): NormalizedTransferInput {
  const teamResolutions = input.teamResolutions.map(normalizeTeamResolution)
    .sort((left, right) => left.teamId.localeCompare(right.teamId))
  const accountResolutions = input.accountResolutions.map(resolution => ({
    accountId: resolution.accountId,
    ownerUserId: resolution.ownerUserId,
    teamId: resolution.teamId,
    baseRevision: resolution.baseRevision,
  })).sort((left, right) => left.accountId.localeCompare(right.accountId))
  return {
    targetUserId: input.targetUserId,
    currentOwnerNextRole: input.currentOwnerNextRole,
    currentOwnerTeamIds: uniqueSorted(input.currentOwnerTeamIds),
    teamResolutions,
    accountResolutions,
    allowManualCleanup: input.allowManualCleanup,
  }
}

function normalizeTeamResolution(resolution: AdminTeamResolution): NormalizedTeamResolution {
  return resolution.action === 'replace_manager'
    ? {
        teamId: resolution.teamId,
        action: 'replace_manager',
        replacementManagerUserId: resolution.replacementManagerUserId ?? '',
        baseRevision: resolution.baseRevision,
      }
    : { teamId: resolution.teamId, action: 'archive', baseRevision: resolution.baseRevision }
}

async function buildTransferPlan(
  db: DatabaseExecutor,
  currentOwnerId: string,
  input: NormalizedTransferInput,
  lock: boolean,
): Promise<TransferPlan> {
  if (input.targetUserId === currentOwnerId) return invalidPlan(lock, 'TARGET_USER_INVALID', 1)
  if (input.currentOwnerNextRole === 'auditor' && input.currentOwnerTeamIds.length > 0) {
    return invalidPlan(lock, 'CURRENT_OWNER_ROLE_INVALID', 1)
  }
  if (input.currentOwnerNextRole === 'agent' && input.currentOwnerTeamIds.length > 1) {
    return invalidPlan(lock, 'CURRENT_OWNER_ROLE_INVALID', input.currentOwnerTeamIds.length)
  }
  if (input.currentOwnerNextRole === 'manager' && input.currentOwnerTeamIds.length === 0) {
    return invalidPlan(lock, 'CURRENT_OWNER_ROLE_INVALID', 1)
  }

  const targetLed = await db.selectFrom('team_members as membership')
    .innerJoin('teams as team', 'team.id', 'membership.team_id')
    .select('team.id')
    .where('membership.user_id', '=', input.targetUserId)
    .where('membership.is_lead', '=', true)
    .where('team.disabled_at', 'is', null)
    .orderBy('team.id').execute()
  const managedTeamIds = uniqueSorted([
    ...targetLed.map(team => team.id),
    ...(input.currentOwnerNextRole === 'manager'
      ? input.currentOwnerTeamIds
      : []),
  ])
  const resolutionIds = input.teamResolutions.map(resolution => resolution.teamId)
  if (new Set(resolutionIds).size !== resolutionIds.length
    || JSON.stringify(resolutionIds) !== JSON.stringify(managedTeamIds)) {
    return invalidPlan(lock, 'TEAM_RESOLUTION_INVALID', managedTeamIds.length)
  }

  const referencedTeamIds = uniqueSorted([
    ...managedTeamIds,
    ...input.currentOwnerTeamIds,
    ...input.accountResolutions.flatMap(resolution => (
      resolution.teamId === null ? [] : [resolution.teamId]
    )),
  ])
  const teamRows = referencedTeamIds.length === 0
    ? []
    : await db.selectFrom('teams').select(['id', 'revision', 'disabled_at'])
      .where('id', 'in', referencedTeamIds).orderBy('id').execute()
  const memberships = managedTeamIds.length === 0
    ? []
    : await db.selectFrom('team_members').select(['team_id', 'user_id', 'is_lead'])
      .where('team_id', 'in', managedTeamIds).orderBy('team_id').orderBy('user_id').execute()
  const leadByTeam = new Map(memberships.filter(row => row.is_lead)
    .map(row => [row.team_id, row.user_id]))
  for (const resolution of input.teamResolutions) {
    const team = teamRows.find(row => row.id === resolution.teamId)
    if (!team || team.disabled_at || team.revision !== resolution.baseRevision) {
      return invalidPlan(lock, 'TEAM_RESOLUTION_INVALID', 1)
    }
    if (input.currentOwnerNextRole === 'manager'
      && input.currentOwnerTeamIds.includes(resolution.teamId)
      && (resolution.action !== 'replace_manager'
        || resolution.replacementManagerUserId !== currentOwnerId)) {
      return invalidPlan(lock, 'TEAM_RESOLUTION_INVALID', 1)
    }
  }

  const displacedPairs = input.teamResolutions.flatMap(resolution => {
    if (resolution.action !== 'replace_manager') return []
    const previousLead = leadByTeam.get(resolution.teamId)
    return previousLead && previousLead !== input.targetUserId
      ? [{ teamId: resolution.teamId, userId: previousLead }]
      : []
  })
  const archivedTeamIds = input.teamResolutions
    .filter(resolution => resolution.action === 'archive')
    .map(resolution => resolution.teamId)
  for (const currentOwnerTeamId of input.currentOwnerTeamIds) {
    const currentOwnerTeam = teamRows.find(team => team.id === currentOwnerTeamId)
    const resolution = input.teamResolutions.find(item => item.teamId === currentOwnerTeamId)
    if (!currentOwnerTeam || currentOwnerTeam.disabled_at
      || (input.currentOwnerNextRole === 'manager' && resolution?.action === 'archive')) {
      return invalidPlan(lock, 'CURRENT_OWNER_ROLE_INVALID', 1)
    }
  }
  const allAccounts = await db.selectFrom('accounts').select([
    'id', 'owner_user_id', 'team_id', 'platform', 'connection_mode', 'revision',
  ]).orderBy('id').execute()
  const affectedAccounts = filterAffectedAccounts(
    allAccounts,
    currentOwnerId,
    archivedTeamIds,
    displacedPairs,
  )
  const affectedIds = affectedAccounts.map(account => account.id)
  const resolutionAccountIds = input.accountResolutions.map(resolution => resolution.accountId)
  if (new Set(resolutionAccountIds).size !== resolutionAccountIds.length
    || JSON.stringify(resolutionAccountIds) !== JSON.stringify(affectedIds)) {
    return invalidPlan(lock, 'ACCOUNT_RESOLUTION_INVALID', affectedIds.length)
  }
  for (const resolution of input.accountResolutions) {
    const account = affectedAccounts.find(row => row.id === resolution.accountId)
    if (!account || account.revision !== resolution.baseRevision
      || !validAccountResolution(
        account,
        resolution,
        currentOwnerId,
        input,
        archivedTeamIds,
        displacedPairs,
      )) {
      return invalidPlan(lock, 'ACCOUNT_RESOLUTION_INVALID', 1)
    }
    if (resolution.teamId !== null) {
      const selectedTeam = teamRows.find(team => team.id === resolution.teamId)
      if (!selectedTeam || selectedTeam.disabled_at || archivedTeamIds.includes(resolution.teamId)) {
        return invalidPlan(lock, 'ACCOUNT_RESOLUTION_INVALID', 1)
      }
    }
  }

  const replacementIds = input.teamResolutions.flatMap(resolution => (
    resolution.action === 'replace_manager' ? [resolution.replacementManagerUserId] : []
  ))
  const userIds = uniqueSorted([
    currentOwnerId,
    input.targetUserId,
    ...replacementIds,
    ...memberships.map(row => row.user_id),
    ...affectedAccounts.map(row => row.owner_user_id),
  ])
  let userQuery = db.selectFrom('users').select([
    'id', 'role', 'disabled_at', 'revision', 'password_hash',
  ]).where('id', 'in', userIds).orderBy('id')
  if (lock) userQuery = userQuery.forUpdate()
  const users = await userQuery.execute()
  const currentOwner = users.find(user => user.id === currentOwnerId)
  const target = users.find(user => user.id === input.targetUserId)
  if (!currentOwner || currentOwner.role !== 'owner' || currentOwner.disabled_at
    || !target || target.role === 'owner' || target.disabled_at) {
    return invalidPlan(lock, 'TARGET_USER_INVALID', 1)
  }
  for (const resolution of input.teamResolutions) {
    if (resolution.action !== 'replace_manager') continue
    const replacement = users.find(user => user.id === resolution.replacementManagerUserId)
    if (!replacement || replacement.disabled_at
      || (replacement.id === currentOwnerId
        ? input.currentOwnerNextRole !== 'manager'
        : replacement.role !== 'manager')
      || replacement.id === input.targetUserId) {
      return invalidPlan(lock, 'TEAM_RESOLUTION_INVALID', 1)
    }
  }

  let lockedTeams = teamRows
  if (lock && referencedTeamIds.length > 0) {
    lockedTeams = await db.selectFrom('teams').select(['id', 'revision', 'disabled_at'])
      .where('id', 'in', referencedTeamIds).orderBy('id').forUpdate().execute()
  }
  if (lock && managedTeamIds.length > 0) {
    const currentMemberships = await db.selectFrom('team_members')
      .select(['team_id', 'user_id', 'is_lead'])
      .where('team_id', 'in', managedTeamIds).orderBy('team_id').orderBy('user_id').execute()
    if (JSON.stringify(currentMemberships) !== JSON.stringify(memberships)) {
      throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
    }
  }
  let lockedAccounts = affectedAccounts
  if (lock) {
    const currentAccounts = await db.selectFrom('accounts').select([
      'id', 'owner_user_id', 'team_id', 'platform', 'connection_mode', 'revision',
    ]).orderBy('id').execute()
    const currentAffected = filterAffectedAccounts(
      currentAccounts,
      currentOwnerId,
      archivedTeamIds,
      displacedPairs,
    )
    if (JSON.stringify(currentAffected.map(account => account.id)) !== JSON.stringify(affectedIds)) {
      throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
    }
    lockedAccounts = affectedIds.length === 0
      ? []
      : await db.selectFrom('accounts').select([
        'id', 'owner_user_id', 'team_id', 'platform', 'connection_mode', 'revision',
      ]).where('id', 'in', affectedIds).orderBy('id').forUpdate().execute()
  }
  const revisions: AdminRevisionSnapshot = {
    users: Object.fromEntries(users.map(user => [user.id, user.revision])),
    teams: Object.fromEntries(lockedTeams.map(team => [team.id, team.revision])),
    accounts: Object.fromEntries(lockedAccounts.map(account => [account.id, account.revision])),
  }
  return {
    kind: 'plan', users, teams: lockedTeams, accounts: lockedAccounts,
    memberships, revisions,
  }
}

function filterAffectedAccounts<T extends {
  owner_user_id: string
  team_id: string | null
}>(
  accounts: T[],
  currentOwnerId: string,
  archivedTeamIds: string[],
  displacedPairs: Array<{ teamId: string; userId: string }>,
): T[] {
  return accounts.filter(account => (
    account.owner_user_id === currentOwnerId
    || (account.team_id !== null && archivedTeamIds.includes(account.team_id))
    || displacedPairs.some(pair => (
      account.team_id === pair.teamId && account.owner_user_id === pair.userId
    ))
  ))
}

function validAccountResolution(
  account: { id: string; owner_user_id: string; team_id: string | null },
  resolution: NormalizedAccountResolution,
  currentOwnerId: string,
  input: NormalizedTransferInput,
  archivedTeamIds: string[],
  displacedPairs: Array<{ teamId: string; userId: string }>,
): boolean {
  const archived = account.team_id !== null && archivedTeamIds.includes(account.team_id)
  if (archived && resolution.teamId !== null) return false
  const displaced = displacedPairs.some(pair => (
    account.team_id === pair.teamId && account.owner_user_id === pair.userId
  ))
  if (account.owner_user_id === currentOwnerId) {
    if (resolution.ownerUserId === input.targetUserId) return true
    if (resolution.ownerUserId !== currentOwnerId) return false
    if (input.currentOwnerNextRole === 'auditor') return false
    if (input.currentOwnerNextRole === 'agent') {
      return resolution.teamId === (input.currentOwnerTeamIds[0] ?? null)
    }
    return resolution.teamId !== null && input.currentOwnerTeamIds.includes(resolution.teamId)
  }
  if (displaced) return resolution.ownerUserId === input.targetUserId
  return resolution.ownerUserId === account.owner_user_id
}

function invalidPlan(
  lock: boolean,
  code: OwnerTransferBlockerCode,
  count: number,
): TransferPlan {
  if (lock) throw new OwnerTransferServiceError('OPERATION_PREVIEW_EXPIRED')
  return { kind: 'blocked', blockers: [{ code, count }] }
}

function revisionsMatch(expected: AdminRevisionSnapshot, current: AdminRevisionSnapshot): boolean {
  return JSON.stringify(expected) === JSON.stringify(current)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
