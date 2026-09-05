import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type {
  Actor,
  AdminAccount,
  AdminAccountSearchRequest,
  AdminPage,
  AdminTeam,
  AdminTeamSearchRequest,
  AdminUser,
  AdminUserSearchRequest,
  Role,
} from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { assertOwner } from './admin-guard.js'

const CURSOR_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_HEX = /^[a-f0-9]{64}$/

interface UserCursor {
  v: typeof CURSOR_VERSION
  lastId: string
  fingerprint: string
}

interface TeamCursor extends UserCursor {
  resource: 'teams'
}

interface AccountCursor extends UserCursor {
  resource: 'accounts'
}

export class AdminCursorError extends Error {
  constructor() {
    super('invalid organization admin cursor')
    this.name = 'AdminCursorError'
  }
}

export class OrganizationReadRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async searchUsers(
    actor: Actor,
    request: AdminUserSearchRequest,
  ): Promise<AdminPage<AdminUser>> {
    assertOwner(actor)
    const limit = request.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AdminCursorError()
    }
    const normalized = normalizeUserFilter(actor.userId, request)
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const cursor = request.cursor ? decodeCursor(request.cursor, fingerprint) : null

    let query = this.db.selectFrom('users').select([
      'id', 'email', 'display_name', 'role', 'disabled_at', 'revision',
    ])
    if (normalized.q !== '') {
      const pattern = `%${escapeLike(normalized.q)}%`
      query = query.where(sql<boolean>`(
        users.email ilike ${pattern} escape '\'
        or users.display_name ilike ${pattern} escape '\'
      )`)
    }
    if (normalized.roles.length > 0) query = query.where('role', 'in', normalized.roles)
    if (normalized.status === 'enabled') query = query.where('disabled_at', 'is', null)
    if (normalized.status === 'disabled') query = query.where('disabled_at', 'is not', null)
    if (request.teamId === null) {
      query = query.where(sql<boolean>`not exists (
        select 1 from team_members member where member.user_id = users.id
      )`)
    } else if (request.teamId !== undefined) {
      query = query.where(sql<boolean>`exists (
        select 1 from team_members member
        where member.user_id = users.id and member.team_id = ${request.teamId}
      )`)
    }
    if (cursor) query = query.where('id', '>', cursor.lastId)

    const rows = await query.orderBy('id').limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = await this.enrichUsers(pageRows)
    const last = pageRows.at(-1)
    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor({ v: CURSOR_VERSION, lastId: last.id, fingerprint })
        : null,
    }
  }

  async getUser(userId: string): Promise<AdminUser | null> {
    const row = await this.db.selectFrom('users').select([
      'id', 'email', 'display_name', 'role', 'disabled_at', 'revision',
    ]).where('id', '=', userId).executeTakeFirst()
    if (!row) return null
    return (await this.enrichUsers([row]))[0] ?? null
  }

  async searchTeams(
    actor: Actor,
    request: AdminTeamSearchRequest,
  ): Promise<AdminPage<AdminTeam>> {
    assertOwner(actor)
    const limit = request.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AdminCursorError()
    const normalized = {
      ownerUserId: actor.userId,
      q: request.q?.trim().toLowerCase() ?? '',
      status: request.status ?? 'all',
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const cursor = request.cursor ? decodeTeamCursor(request.cursor, fingerprint) : null
    let query = this.db.selectFrom('teams').select([
      'id', 'name', 'disabled_at', 'revision',
    ])
    if (normalized.q !== '') {
      const pattern = `%${escapeLike(normalized.q)}%`
      query = query.where(sql<boolean>`teams.name ilike ${pattern} escape '\'`)
    }
    if (normalized.status === 'enabled') query = query.where('disabled_at', 'is', null)
    if (normalized.status === 'archived') query = query.where('disabled_at', 'is not', null)
    if (cursor) query = query.where('id', '>', cursor.lastId)
    const rows = await query.orderBy('id').limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = await this.enrichTeams(pageRows)
    const last = pageRows.at(-1)
    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor({
            v: CURSOR_VERSION,
            resource: 'teams',
            lastId: last.id,
            fingerprint,
          })
        : null,
    }
  }

  async getTeam(teamId: string): Promise<AdminTeam | null> {
    const row = await this.db.selectFrom('teams').select([
      'id', 'name', 'disabled_at', 'revision',
    ]).where('id', '=', teamId).executeTakeFirst()
    if (!row) return null
    return (await this.enrichTeams([row]))[0] ?? null
  }

  async searchAccounts(
    actor: Actor,
    request: AdminAccountSearchRequest,
  ): Promise<AdminPage<AdminAccount>> {
    assertOwner(actor)
    const limit = request.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AdminCursorError()
    const normalized = {
      ownerUserId: actor.userId,
      q: request.q?.trim().toLowerCase() ?? '',
      platform: request.platform ?? '__any__',
      accountOwnerUserId: request.ownerUserId ?? '__any__',
      teamId: request.teamId === undefined ? '__any__' : request.teamId,
      cleanupState: request.cleanupState ?? '__any__',
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const cursor = request.cursor ? decodeAccountCursor(request.cursor, fingerprint) : null
    let query = this.db.selectFrom('accounts').select([
      'id', 'platform', 'connection_mode', 'display_name', 'status',
      'owner_user_id', 'team_id', 'revision',
    ])
    if (normalized.q !== '') {
      const pattern = `%${escapeLike(normalized.q)}%`
      query = query.where(sql<boolean>`accounts.display_name ilike ${pattern} escape '\'`)
    }
    if (request.platform) query = query.where('platform', '=', request.platform)
    if (request.ownerUserId) query = query.where('owner_user_id', '=', request.ownerUserId)
    if (request.teamId === null) query = query.where('team_id', 'is', null)
    else if (request.teamId !== undefined) query = query.where('team_id', '=', request.teamId)
    if (request.cleanupState === 'not_required') {
      query = query.where(sql<boolean>`not exists (
        select 1 from desktop_cleanup_tasks task where task.account_id = accounts.id
      )`)
    } else if (request.cleanupState === 'manual_required') {
      query = query.where(sql<boolean>`exists (
        select 1 from desktop_cleanup_tasks task
        where task.account_id = accounts.id and task.state = 'pending'
          and task.mode = 'manual_required'
      )`)
    } else if (request.cleanupState === 'pending') {
      query = query.where(sql<boolean>`exists (
        select 1 from desktop_cleanup_tasks task
        where task.account_id = accounts.id and task.state = 'pending'
          and task.mode = 'automatic'
      ) and not exists (
        select 1 from desktop_cleanup_tasks task
        where task.account_id = accounts.id and task.state = 'pending'
          and task.mode = 'manual_required'
      )`)
    } else if (request.cleanupState === 'completed') {
      query = query.where(sql<boolean>`exists (
        select 1 from desktop_cleanup_tasks task where task.account_id = accounts.id
      ) and not exists (
        select 1 from desktop_cleanup_tasks task
        where task.account_id = accounts.id and task.state = 'pending'
      )`)
    }
    if (cursor) query = query.where('id', '>', cursor.lastId)
    const rows = await query.orderBy('id').limit(limit + 1).execute()
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = await this.enrichAccounts(pageRows)
    const last = pageRows.at(-1)
    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor({
            v: CURSOR_VERSION,
            resource: 'accounts',
            lastId: last.id,
            fingerprint,
          })
        : null,
    }
  }

  async getAccount(accountId: string): Promise<AdminAccount | null> {
    const row = await this.db.selectFrom('accounts').select([
      'id', 'platform', 'connection_mode', 'display_name', 'status',
      'owner_user_id', 'team_id', 'revision',
    ]).where('id', '=', accountId).executeTakeFirst()
    if (!row) return null
    return (await this.enrichAccounts([row]))[0] ?? null
  }

  private async enrichUsers(rows: Array<{
    id: string
    email: string
    display_name: string
    role: Role
    disabled_at: Date | null
    revision: number
  }>): Promise<AdminUser[]> {
    const ids = rows.map(row => row.id)
    if (ids.length === 0) return []
    const [memberships, accounts] = await Promise.all([
      this.db.selectFrom('team_members')
        .select(['user_id', 'team_id'])
        .where('user_id', 'in', ids)
        .orderBy('team_id')
        .execute(),
      this.db.selectFrom('accounts')
        .select('owner_user_id')
        .where('owner_user_id', 'in', ids)
        .execute(),
    ])
    const teamsByUser = new Map<string, string[]>()
    for (const membership of memberships) {
      const teamIds = teamsByUser.get(membership.user_id) ?? []
      teamIds.push(membership.team_id)
      teamsByUser.set(membership.user_id, teamIds)
    }
    const accountsByUser = new Map<string, number>()
    for (const account of accounts) {
      accountsByUser.set(account.owner_user_id, (accountsByUser.get(account.owner_user_id) ?? 0) + 1)
    }
    return rows.map(row => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      disabledAt: row.disabled_at?.toISOString() ?? null,
      teamIds: teamsByUser.get(row.id) ?? [],
      ownedAccountCount: accountsByUser.get(row.id) ?? 0,
      revision: row.revision,
    }))
  }

  private async enrichTeams(rows: Array<{
    id: string
    name: string
    disabled_at: Date | null
    revision: number
  }>): Promise<AdminTeam[]> {
    const ids = rows.map(row => row.id)
    if (ids.length === 0) return []
    const [memberships, accounts] = await Promise.all([
      this.db.selectFrom('team_members')
        .select(['team_id', 'user_id', 'is_lead'])
        .where('team_id', 'in', ids)
        .orderBy('user_id')
        .execute(),
      this.db.selectFrom('accounts').select('team_id')
        .where('team_id', 'in', ids).execute(),
    ])
    const managerByTeam = new Map<string, string>()
    const agentsByTeam = new Map<string, number>()
    for (const membership of memberships) {
      if (membership.is_lead) managerByTeam.set(membership.team_id, membership.user_id)
      else agentsByTeam.set(
        membership.team_id,
        (agentsByTeam.get(membership.team_id) ?? 0) + 1,
      )
    }
    const accountsByTeam = new Map<string, number>()
    for (const account of accounts) {
      if (account.team_id === null) continue
      accountsByTeam.set(account.team_id, (accountsByTeam.get(account.team_id) ?? 0) + 1)
    }
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      managerUserId: managerByTeam.get(row.id) ?? null,
      agentCount: agentsByTeam.get(row.id) ?? 0,
      accountCount: accountsByTeam.get(row.id) ?? 0,
      disabledAt: row.disabled_at?.toISOString() ?? null,
      revision: row.revision,
    }))
  }

  private async enrichAccounts(rows: Array<{
    id: string
    platform: AdminAccount['platform']
    connection_mode: AdminAccount['connectionMode']
    display_name: string
    status: AdminAccount['status']
    owner_user_id: string
    team_id: string | null
    revision: number
  }>): Promise<AdminAccount[]> {
    const ids = rows.map(row => row.id)
    if (ids.length === 0) return []
    const tasks = await this.db.selectFrom('desktop_cleanup_tasks')
      .select(['id', 'account_id', 'installation_id', 'mode', 'reason', 'state', 'created_at'])
      .where('account_id', 'in', ids)
      .execute()
    const byAccount = new Map<string, typeof tasks>()
    for (const task of tasks) {
      const accountTasks = byAccount.get(task.account_id) ?? []
      accountTasks.push(task)
      byAccount.set(task.account_id, accountTasks)
    }
    return rows.map(row => {
      const accountTasks = byAccount.get(row.id) ?? []
      const pending = accountTasks.filter(task => task.state === 'pending')
      const cleanupState = pending.some(task => task.mode === 'manual_required')
        ? 'manual_required' as const
        : pending.length > 0
          ? 'pending' as const
          : accountTasks.length > 0
            ? 'completed' as const
            : 'not_required' as const
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
        manualCleanupTasks: pending
          .filter(task => task.mode === 'manual_required')
          .sort((left, right) => left.created_at.getTime() - right.created_at.getTime()
            || left.id.localeCompare(right.id))
          .map(task => ({
            id: task.id,
            installationId: task.installation_id,
            reason: task.reason,
            createdAt: task.created_at.toISOString(),
          })),
        revision: row.revision,
      }
    })
  }
}

function normalizeUserFilter(ownerUserId: string, request: AdminUserSearchRequest) {
  return {
    ownerUserId,
    q: request.q?.trim().toLowerCase() ?? '',
    roles: [...new Set(request.roles ?? [])].sort(),
    status: request.status ?? 'all',
    teamId: request.teamId === undefined ? '__any__' : request.teamId,
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function encodeCursor(cursor: UserCursor | TeamCursor | AccountCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeTeamCursor(encoded: string, fingerprint: string): TeamCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new AdminCursorError()
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw new AdminCursorError()
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isTeamCursor(value) || value.fingerprint !== fingerprint) throw new AdminCursorError()
    return value
  } catch (error) {
    if (error instanceof AdminCursorError) throw error
    throw new AdminCursorError()
  }
}

function decodeAccountCursor(encoded: string, fingerprint: string): AccountCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new AdminCursorError()
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw new AdminCursorError()
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isAccountCursor(value) || value.fingerprint !== fingerprint) throw new AdminCursorError()
    return value
  } catch (error) {
    if (error instanceof AdminCursorError) throw error
    throw new AdminCursorError()
  }
}

function decodeCursor(encoded: string, fingerprint: string): UserCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new AdminCursorError()
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw new AdminCursorError()
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isCursor(value) || value.fingerprint !== fingerprint) throw new AdminCursorError()
    return value
  } catch (error) {
    if (error instanceof AdminCursorError) throw error
    throw new AdminCursorError()
  }
}

function isCursor(value: unknown): value is UserCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).sort().join(',') === 'fingerprint,lastId,v'
    && candidate.v === CURSOR_VERSION
    && typeof candidate.lastId === 'string'
    && UUID.test(candidate.lastId)
    && typeof candidate.fingerprint === 'string'
    && SHA256_HEX.test(candidate.fingerprint)
}


function isTeamCursor(value: unknown): value is TeamCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).sort().join(',') === 'fingerprint,lastId,resource,v'
    && candidate.v === CURSOR_VERSION
    && candidate.resource === 'teams'
    && typeof candidate.lastId === 'string'
    && UUID.test(candidate.lastId)
    && typeof candidate.fingerprint === 'string'
    && SHA256_HEX.test(candidate.fingerprint)
}

function isAccountCursor(value: unknown): value is AccountCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).sort().join(',') === 'fingerprint,lastId,resource,v'
    && candidate.v === CURSOR_VERSION
    && candidate.resource === 'accounts'
    && typeof candidate.lastId === 'string'
    && UUID.test(candidate.lastId)
    && typeof candidate.fingerprint === 'string'
    && SHA256_HEX.test(candidate.fingerprint)
}
