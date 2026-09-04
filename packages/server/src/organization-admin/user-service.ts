import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import {
  ADMIN_EDITABLE_ROLES,
  type Actor,
  type AdminUser,
  type AdminUserCreate,
  type AdminUserUpdate,
} from '@im-hub/shared'
import { hashPassword } from '../auth/password.js'
import type { Database } from '../db/types.js'
import { assertOwner } from './admin-guard.js'
import { OrganizationReadRepo } from './read-repo.js'

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1_000

export type OrganizationBlockerCode =
  | 'OWNER_IMMUTABLE'
  | 'TEAM_MEMBERSHIPS_EXIST'
  | 'OWNED_ACCOUNTS_EXIST'
  | 'TEAM_INVALID'
  | 'TEAM_ASSIGNMENT_INVALID'
  | 'USER_ALREADY_ENABLED'

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

export class UserAdminServiceError extends Error {
  constructor(readonly code: UserAdminServiceErrorCode) {
    super(code)
    this.name = 'UserAdminServiceError'
  }
}

export interface UserAdminServiceOptions {
  now?: () => Date
  generateTemporaryPassword?: () => string
}

export class UserAdminService {
  private readonly now: () => Date
  private readonly generateTemporaryPassword: () => string

  constructor(
    private readonly db: Kysely<Database>,
    options: UserAdminServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.generateTemporaryPassword = options.generateTemporaryPassword
      ?? (() => randomBytes(24).toString('base64url'))
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

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === '23505'
}
