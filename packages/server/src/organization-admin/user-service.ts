import { randomBytes } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import {
  ADMIN_EDITABLE_ROLES,
  type Actor,
  type AdminMutationPreview,
  type AdminTeamResolution,
  type AdminUser,
  type AdminUserCreate,
  type AdminUserUpdate,
  type Platform,
} from '@im-hub/shared'
import { hashPassword } from '../auth/password.js'
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

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1_000

export type OrganizationBlockerCode =
  | 'OWNER_IMMUTABLE'
  | 'TEAM_MEMBERSHIPS_EXIST'
  | 'OWNED_ACCOUNTS_EXIST'
  | 'TEAM_INVALID'
  | 'TEAM_ASSIGNMENT_INVALID'
  | 'USER_ALREADY_ENABLED'
  | 'USER_ALREADY_DISABLED'
  | 'TEAM_RESOLUTION_INVALID'
  | 'CLIENT_UPDATE_REQUIRED'

export interface OrganizationBlocker {
  code: OrganizationBlockerCode
  count: number
}

export type UserMutationResult =
  | { kind: 'updated'; user: AdminUser; revokeSession: boolean }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminUser }
  | { kind: 'blocked'; blockers: OrganizationBlocker[] }

export type UserCredentialMutationResult =
  | {
      kind: 'updated'
      user: AdminUser
      revokeSession: true
      temporaryPassword: string
      temporaryPasswordExpiresAt: string
    }
  | Exclude<UserMutationResult, { kind: 'updated' }>

export interface UserCreationResult {
  user: AdminUser
  temporaryPassword: string
  temporaryPasswordExpiresAt: string
}

export type UserAdminServiceErrorCode =
  | 'DUPLICATE_EMAIL'
  | 'OWNER_IMMUTABLE'
  | 'TEAM_INVALID'
  | 'TEAM_ASSIGNMENT_INVALID'
  | 'OPERATION_PREVIEW_EXPIRED'
  | 'CLIENT_UPDATE_REQUIRED'

export class UserAdminServiceError extends Error {
  constructor(readonly code: UserAdminServiceErrorCode) {
    super(code)
    this.name = 'UserAdminServiceError'
  }
}

export interface UserAdminServiceOptions {
  now?: () => Date
  generateTemporaryPassword?: () => string
  deviceService?: DeviceService
  operationTokens?: AdminOperationTokenService
}

export interface UserDisablePreviewInput {
  baseRevision: number
  teamResolutions: AdminTeamResolution[]
  allowManualCleanup: boolean
}

export type UserDisableResult =
  | { kind: 'preview'; preview: AdminMutationPreview }
  | { kind: 'disabled'; user: AdminUser; effects: OrganizationPostCommitEffects }
  | { kind: 'not_found' }
  | { kind: 'conflict'; current: AdminUser }
  | { kind: 'blocked'; blockers: OrganizationBlocker[] }

export class UserAdminService {
  private readonly now: () => Date
  private readonly generateTemporaryPassword: () => string
  private readonly devices: DeviceService | undefined
  private readonly operationTokens: AdminOperationTokenService | undefined

  constructor(
    private readonly db: Kysely<Database>,
    options: UserAdminServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.generateTemporaryPassword = options.generateTemporaryPassword
      ?? (() => randomBytes(24).toString('base64url'))
    this.devices = options.deviceService
    this.operationTokens = options.operationTokens
  }

  async create(actor: Actor, input: AdminUserCreate): Promise<UserCreationResult> {
    assertOwner(actor)
    if (!ADMIN_EDITABLE_ROLES.some(role => role === input.role)) {
      throw new UserAdminServiceError('OWNER_IMMUTABLE')
    }
    if (input.role !== 'agent' && input.teamId !== null) {
      throw new UserAdminServiceError('TEAM_ASSIGNMENT_INVALID')
    }

    const email = input.email.trim().toLowerCase()
    const displayName = input.displayName.trim()
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + TEMPORARY_PASSWORD_LIFETIME_MS)
    const temporaryPassword = this.generateTemporaryPassword()
    const passwordHash = await hashPassword(temporaryPassword)

    try {
      return await this.db.transaction().execute(async transaction => {
        const duplicate = await transaction.selectFrom('users').select('id')
          .where(sql<boolean>`lower(email) = ${email}`)
          .executeTakeFirst()
        if (duplicate) throw new UserAdminServiceError('DUPLICATE_EMAIL')
        if (input.teamId !== null) {
          const team = await transaction.selectFrom('teams').select('id')
            .where('id', '=', input.teamId)
            .where('disabled_at', 'is', null)
            .executeTakeFirst()
          if (!team) throw new UserAdminServiceError('TEAM_INVALID')
        }

        const row = await transaction.insertInto('users').values({
          email,
          display_name: displayName,
          role: input.role,
          password_hash: passwordHash,
          must_change_password: true,
          temporary_password_expires_at: expiresAt,
        }).returning('id').executeTakeFirstOrThrow()
        if (input.teamId !== null) {
          await transaction.insertInto('team_members').values({
            team_id: input.teamId,
            user_id: row.id,
            is_lead: false,
          }).execute()
        }
        const user = await new OrganizationReadRepo(transaction).getUser(row.id)
        if (!user) throw new Error('created user disappeared')
        return {
          user,
          temporaryPassword,
          temporaryPasswordExpiresAt: expiresAt.toISOString(),
        }
      })
    } catch (error) {
      if (error instanceof UserAdminServiceError || !isUniqueViolation(error)) throw error
      throw new UserAdminServiceError('DUPLICATE_EMAIL')
    }
  }

  async update(
    actor: Actor,
    userId: string,
    input: AdminUserUpdate,
  ): Promise<UserMutationResult> {
    assertOwner(actor)
    return this.db.transaction().execute(async transaction => {
      const current = await transaction.selectFrom('users')
        .select(['id', 'role', 'revision'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst()
      if (!current) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const currentUser = await readRepo.getUser(userId)
      if (!currentUser) return { kind: 'not_found' }
      if (current.role === 'owner') {
        return { kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }] }
      }
      if (current.revision !== input.baseRevision) {
        return { kind: 'conflict', current: currentUser }
      }
      if (input.role !== undefined
        && !ADMIN_EDITABLE_ROLES.some(role => role === input.role)) {
        return { kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }] }
      }
      if (input.teamId !== undefined) {
        return { kind: 'blocked', blockers: [{ code: 'TEAM_ASSIGNMENT_INVALID', count: 1 }] }
      }

      const roleChanged = input.role !== undefined && input.role !== current.role
      if (roleChanged) {
        const [memberships, accounts] = await Promise.all([
          transaction.selectFrom('team_members').select('team_id')
            .where('user_id', '=', userId).execute(),
          transaction.selectFrom('accounts').select('id')
            .where('owner_user_id', '=', userId).execute(),
        ])
        const blockers: OrganizationBlocker[] = []
        if (memberships.length > 0) {
          blockers.push({ code: 'TEAM_MEMBERSHIPS_EXIST', count: memberships.length })
        }
        if (accounts.length > 0) {
          blockers.push({ code: 'OWNED_ACCOUNTS_EXIST', count: accounts.length })
        }
        if (blockers.length > 0) return { kind: 'blocked', blockers }
      }

      await transaction.updateTable('users').set(expression => ({
        ...(input.displayName === undefined ? {} : { display_name: input.displayName.trim() }),
        ...(input.role === undefined ? {} : { role: input.role }),
        revision: expression('revision', '+', 1),
        ...(roleChanged
          ? { session_version: expression('session_version', '+', 1) }
          : {}),
        updated_at: this.now(),
      })).where('id', '=', userId).where('revision', '=', input.baseRevision).executeTakeFirstOrThrow()
      const user = await readRepo.getUser(userId)
      if (!user) throw new Error('updated user disappeared')
      return { kind: 'updated', user, revokeSession: roleChanged }
    })
  }

  async resetPassword(
    actor: Actor,
    userId: string,
    input: { baseRevision: number },
  ): Promise<UserCredentialMutationResult> {
    assertOwner(actor)
    return this.replaceWithTemporaryPassword(userId, input, false)
  }

  async enable(
    actor: Actor,
    userId: string,
    input: { baseRevision: number },
  ): Promise<UserCredentialMutationResult> {
    assertOwner(actor)
    return this.replaceWithTemporaryPassword(userId, input, true)
  }

  async previewDisable(
    actor: Actor,
    userId: string,
    input: UserDisablePreviewInput,
  ): Promise<UserDisableResult> {
    assertOwner(actor)
    const dependencies = this.disableDependencies()
    const current = await new OrganizationReadRepo(this.db).getUser(userId)
    if (!current) return { kind: 'not_found' }
    if (current.role === 'owner') {
      return { kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }] }
    }
    if (current.disabledAt) {
      return { kind: 'blocked', blockers: [{ code: 'USER_ALREADY_DISABLED', count: 1 }] }
    }
    if (current.revision !== input.baseRevision) return { kind: 'conflict', current }

    const normalized = normalizeDisableInput(userId, input)
    const snapshot = await snapshotDisable(
      this.db,
      actor.userId,
      normalized,
      false,
    )
    if (snapshot.kind === 'blocked') return snapshot
    const cleanup = { automatic: 0, manual: 0, unsupported: 0 }
    for (const account of snapshot.accounts.filter(row => row.owner_user_id === userId)) {
      const preview = await dependencies.devices.previewOwnershipChange({
        accountId: account.id,
        previousOwnerUserId: userId,
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

    const issued = await dependencies.operationTokens.issue<NormalizedDisableInput>({
      kind: 'disable_user',
      ownerUserId: actor.userId,
      input: normalized,
      revisions: snapshot.revisions,
    })
    return {
      kind: 'preview',
      preview: {
        ...issued,
        summary: {
          usersDisabled: 1,
          accountsTransferred: snapshot.accounts
            .filter(account => account.owner_user_id === userId).length,
          teamsReassigned: normalized.teamResolutions
            .filter(resolution => resolution.action === 'replace_manager').length,
          teamsArchived: normalized.teamResolutions
            .filter(resolution => resolution.action === 'archive').length,
          automaticCleanupTasks: cleanup.automatic,
          manualCleanupTasks: cleanup.manual,
        },
      },
    }
  }

  async disable(
    actor: Actor,
    userId: string,
    input: { operationToken: string },
  ): Promise<UserDisableResult> {
    assertOwner(actor)
    const dependencies = this.disableDependencies()
    let verified: { input: NormalizedDisableInput; revisions: AdminRevisionSnapshot }
    try {
      verified = await dependencies.operationTokens.verify<NormalizedDisableInput>(
        input.operationToken,
        { kind: 'disable_user', ownerUserId: actor.userId },
      )
    } catch {
      throw new UserAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }
    if (verified.input.userId !== userId) {
      throw new UserAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }

    return this.db.transaction().execute(async transaction => {
      const snapshot = await snapshotDisable(
        transaction,
        actor.userId,
        verified.input,
        true,
      )
      if (snapshot.kind === 'blocked') return snapshot
      if (!revisionsMatch(verified.revisions, snapshot.revisions)) {
        throw new UserAdminServiceError('OPERATION_PREVIEW_EXPIRED')
      }
      const target = snapshot.users.find(user => user.id === userId)
      const activeOwner = snapshot.users.find(user => (
        user.id === actor.userId && user.role === 'owner' && user.disabled_at === null
      ))
      if (!target) return { kind: 'not_found' }
      if (!activeOwner || target.role === 'owner') {
        return { kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }] }
      }
      if (target.disabled_at) {
        return { kind: 'blocked', blockers: [{ code: 'USER_ALREADY_DISABLED', count: 1 }] }
      }

      let cleanupTasks = 0
      const archivedTeamIds = new Set(verified.input.teamResolutions
        .filter(resolution => resolution.action === 'archive')
        .map(resolution => resolution.teamId))
      for (const account of snapshot.accounts.filter(row => row.owner_user_id === userId)) {
        const cleanup = await dependencies.devices.enqueueOwnershipChange({
          accountId: account.id,
          previousOwnerUserId: userId,
          platform: account.platform,
          connectionMode: account.connection_mode,
        }, { allowManualCleanup: verified.input.allowManualCleanup }, new DeviceRepo(transaction))
        if (cleanup.unsupportedOnlineInstallations > 0 && !verified.input.allowManualCleanup) {
          throw new UserAdminServiceError('CLIENT_UPDATE_REQUIRED')
        }
        cleanupTasks += cleanup.pendingAutomatic + cleanup.manualRequired
      }

      for (const account of snapshot.accounts) {
        const ownershipChanged = account.owner_user_id === userId
        const teamArchived = account.team_id !== null && archivedTeamIds.has(account.team_id)
        if (!ownershipChanged && !teamArchived) continue
        await transaction.updateTable('accounts').set(expression => ({
          ...(ownershipChanged ? { owner_user_id: actor.userId } : {}),
          ...(teamArchived ? { team_id: null } : {}),
          revision: expression('revision', '+', 1),
          ...(ownershipChanged
            ? { native_control_version: expression('native_control_version', '+', 1) }
            : {}),
        })).where('id', '=', account.id).execute()
      }

      for (const resolution of verified.input.teamResolutions) {
        if (resolution.action === 'replace_manager') {
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
        } else {
          await transaction.deleteFrom('team_members')
            .where('team_id', '=', resolution.teamId)
            .execute()
          await transaction.updateTable('teams').set(expression => ({
            disabled_at: this.now(),
            revision: expression('revision', '+', 1),
            updated_at: this.now(),
          })).where('id', '=', resolution.teamId).execute()
        }
      }
      await transaction.deleteFrom('team_members').where('user_id', '=', userId).execute()
      await transaction.updateTable('users').set(expression => ({
        disabled_at: this.now(),
        session_version: expression('session_version', '+', 1),
        revision: expression('revision', '+', 1),
        updated_at: this.now(),
      })).where('id', '=', userId).where('revision', '=', target.revision).executeTakeFirstOrThrow()

      const user = await new OrganizationReadRepo(transaction).getUser(userId)
      if (!user) throw new Error('disabled user disappeared')
      return {
        kind: 'disabled',
        user,
        effects: {
          organizationChangedUserIds: uniqueSorted(snapshot.users.map(row => row.id)),
          cleanupRequestedUserIds: cleanupTasks > 0 ? [userId] : [],
          revokedUserIds: [userId],
        },
      }
    })
  }

  private disableDependencies(): {
    devices: DeviceService
    operationTokens: AdminOperationTokenService
  } {
    if (!this.devices || !this.operationTokens) {
      throw new Error('user disable dependencies are not configured')
    }
    return { devices: this.devices, operationTokens: this.operationTokens }
  }

  private async replaceWithTemporaryPassword(
    userId: string,
    input: { baseRevision: number },
    enable: boolean,
  ): Promise<UserCredentialMutationResult> {
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + TEMPORARY_PASSWORD_LIFETIME_MS)
    const temporaryPassword = this.generateTemporaryPassword()
    const passwordHash = await hashPassword(temporaryPassword)
    return this.db.transaction().execute(async transaction => {
      const current = await transaction.selectFrom('users')
        .select(['id', 'role', 'disabled_at', 'revision'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst()
      if (!current) return { kind: 'not_found' }
      const readRepo = new OrganizationReadRepo(transaction)
      const currentUser = await readRepo.getUser(userId)
      if (!currentUser) return { kind: 'not_found' }
      if (current.role === 'owner') {
        return { kind: 'blocked', blockers: [{ code: 'OWNER_IMMUTABLE', count: 1 }] }
      }
      if (current.revision !== input.baseRevision) {
        return { kind: 'conflict', current: currentUser }
      }
      if (enable && current.disabled_at === null) {
        return { kind: 'blocked', blockers: [{ code: 'USER_ALREADY_ENABLED', count: 1 }] }
      }

      await transaction.updateTable('users').set(expression => ({
        password_hash: passwordHash,
        must_change_password: true,
        temporary_password_expires_at: expiresAt,
        ...(enable ? { disabled_at: null } : {}),
        session_version: expression('session_version', '+', 1),
        revision: expression('revision', '+', 1),
        updated_at: issuedAt,
      })).where('id', '=', userId).where('revision', '=', input.baseRevision).executeTakeFirstOrThrow()
      const user = await readRepo.getUser(userId)
      if (!user) throw new Error('credential-updated user disappeared')
      return {
        kind: 'updated',
        user,
        revokeSession: true,
        temporaryPassword,
        temporaryPasswordExpiresAt: expiresAt.toISOString(),
      }
    })
  }
}

type NormalizedTeamResolution =
  | {
      teamId: string
      action: 'replace_manager'
      replacementManagerUserId: string
      baseRevision: number
    }
  | {
      teamId: string
      action: 'archive'
      baseRevision: number
    }

interface NormalizedDisableInput {
  userId: string
  teamResolutions: NormalizedTeamResolution[]
  allowManualCleanup: boolean
}

type DisableSnapshot =
  | { kind: 'blocked'; blockers: OrganizationBlocker[] }
  | {
      kind: 'snapshot'
      users: Array<{
        id: string
        role: 'owner' | 'auditor' | 'manager' | 'agent'
        disabled_at: Date | null
        revision: number
      }>
      teams: Array<{ id: string; revision: number }>
      accounts: Array<{
        id: string
        owner_user_id: string
        team_id: string | null
        platform: Platform
        connection_mode: 'adapter' | 'native_desktop' | 'web_shell' | 'cloud_api'
        revision: number
      }>
      revisions: AdminRevisionSnapshot
    }

function normalizeDisableInput(
  userId: string,
  input: UserDisablePreviewInput,
): NormalizedDisableInput {
  const teamResolutions = input.teamResolutions.map((resolution): NormalizedTeamResolution => (
    resolution.action === 'replace_manager'
      ? {
          teamId: resolution.teamId,
          action: 'replace_manager',
          replacementManagerUserId: resolution.replacementManagerUserId ?? '',
          baseRevision: resolution.baseRevision,
        }
      : {
          teamId: resolution.teamId,
          action: 'archive',
          baseRevision: resolution.baseRevision,
        }
  )).sort((left, right) => left.teamId.localeCompare(right.teamId))
  return { userId, teamResolutions, allowManualCleanup: input.allowManualCleanup }
}

async function snapshotDisable(
  db: Kysely<Database> | Transaction<Database>,
  ownerUserId: string,
  input: NormalizedDisableInput,
  lock: boolean,
): Promise<DisableSnapshot> {
  const ledTeams = await db.selectFrom('team_members as membership')
    .innerJoin('teams as team', 'team.id', 'membership.team_id')
    .select(['team.id', 'team.revision'])
    .where('membership.user_id', '=', input.userId)
    .where('membership.is_lead', '=', true)
    .where('team.disabled_at', 'is', null)
    .orderBy('team.id')
    .execute()
  const resolutionTeamIds = input.teamResolutions.map(resolution => resolution.teamId)
  if (new Set(resolutionTeamIds).size !== resolutionTeamIds.length
    || JSON.stringify(resolutionTeamIds) !== JSON.stringify(ledTeams.map(team => team.id))) {
    return invalidDisableResolution(lock, ledTeams.length)
  }
  for (const resolution of input.teamResolutions) {
    const team = ledTeams.find(row => row.id === resolution.teamId)
    if (!team || team.revision !== resolution.baseRevision) {
      return invalidDisableResolution(lock, 1)
    }
    if (resolution.action === 'replace_manager') {
      const replacement = await db.selectFrom('users')
        .select(['id', 'role', 'disabled_at'])
        .where('id', '=', resolution.replacementManagerUserId)
        .executeTakeFirst()
      if (!replacement
        || replacement.id === input.userId
        || replacement.role !== 'manager'
        || replacement.disabled_at) {
        return invalidDisableResolution(lock, 1)
      }
    }
  }

  const ledTeamIds = ledTeams.map(team => team.id)
  const memberships = ledTeamIds.length === 0
    ? []
    : await db.selectFrom('team_members').select(['team_id', 'user_id', 'is_lead'])
      .where('team_id', 'in', ledTeamIds)
      .orderBy('team_id').orderBy('user_id').execute()
  const replacementIds = input.teamResolutions.flatMap(resolution => (
    resolution.action === 'replace_manager' ? [resolution.replacementManagerUserId] : []
  ))
  const userIds = uniqueSorted([
    ownerUserId,
    input.userId,
    ...replacementIds,
    ...memberships.map(membership => membership.user_id),
  ])
  let userQuery = db.selectFrom('users')
    .select(['id', 'role', 'disabled_at', 'revision'])
    .where('id', 'in', userIds)
    .orderBy('id')
  if (lock) userQuery = userQuery.forUpdate()
  const users = await userQuery.execute()

  let teamQuery = db.selectFrom('teams').select(['id', 'revision'])
  if (ledTeamIds.length > 0) teamQuery = teamQuery.where('id', 'in', ledTeamIds)
  else teamQuery = teamQuery.where('id', 'is', null)
  teamQuery = teamQuery.orderBy('id')
  if (lock) teamQuery = teamQuery.forUpdate()
  const teams = await teamQuery.execute()
  if (lock && ledTeamIds.length > 0) {
    const currentMemberships = await db.selectFrom('team_members')
      .select(['team_id', 'user_id', 'is_lead'])
      .where('team_id', 'in', ledTeamIds)
      .orderBy('team_id').orderBy('user_id').execute()
    if (JSON.stringify(currentMemberships) !== JSON.stringify(memberships)) {
      throw new UserAdminServiceError('OPERATION_PREVIEW_EXPIRED')
    }
  }

  const archivedTeamIds = input.teamResolutions
    .filter(resolution => resolution.action === 'archive')
    .map(resolution => resolution.teamId)
  let accountQuery = db.selectFrom('accounts').select([
    'id', 'owner_user_id', 'team_id', 'platform', 'connection_mode', 'revision',
  ])
  accountQuery = archivedTeamIds.length === 0
    ? accountQuery.where('owner_user_id', '=', input.userId)
    : accountQuery.where(expression => expression.or([
        expression('owner_user_id', '=', input.userId),
        expression('team_id', 'in', archivedTeamIds),
      ]))
  accountQuery = accountQuery.orderBy('id')
  if (lock) accountQuery = accountQuery.forUpdate()
  const accounts = await accountQuery.execute()
  const revisions: AdminRevisionSnapshot = {
    users: Object.fromEntries(users.map(user => [user.id, user.revision])),
    teams: Object.fromEntries(teams.map(team => [team.id, team.revision])),
    accounts: Object.fromEntries(accounts.map(account => [account.id, account.revision])),
  }
  return { kind: 'snapshot', users, teams, accounts, revisions }
}

function revisionsMatch(expected: AdminRevisionSnapshot, current: AdminRevisionSnapshot): boolean {
  return JSON.stringify(expected) === JSON.stringify(current)
}

function invalidDisableResolution(lock: boolean, count: number): DisableSnapshot {
  if (lock) throw new UserAdminServiceError('OPERATION_PREVIEW_EXPIRED')
  return {
    kind: 'blocked',
    blockers: [{ code: 'TEAM_RESOLUTION_INVALID', count }],
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === '23505'
}
