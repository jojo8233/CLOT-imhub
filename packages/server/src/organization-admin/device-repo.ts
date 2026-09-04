import type { Transaction } from 'kysely'
import type { Kysely } from 'kysely'
import type {
  DesktopCleanupReason,
  DesktopCleanupTask,
  DesktopInstallationCapability,
} from '@im-hub/shared'
import type { Database } from '../db/types.js'

type DatabaseExecutor = Kysely<Database> | Transaction<Database>

export interface StoredInstallation {
  id: string
  credentialSha256: string
  clientVersion: string
  capabilities: DesktopInstallationCapability[]
  lastSeenAt: Date
  revokedAt: Date | null
}

export interface InstallationMount {
  installationId: string
  accountId: string
  ownerUserId: string
  lastSeenAt: Date
  installationLastSeenAt: Date
  installationRevokedAt: Date | null
  capabilities: DesktopInstallationCapability[]
}

export interface NewInstallation {
  id: string
  credentialSha256: string
  clientVersion: string
  capabilities: DesktopInstallationCapability[]
  now: Date
}

export interface NewCleanupTask {
  installationId: string | null
  accountId: string
  mode: 'automatic' | 'manual_required'
  reason: DesktopCleanupReason
}

export class DeviceRepo {
  constructor(private readonly db: DatabaseExecutor) {}

  async transaction<T>(work: (repo: DeviceRepo) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(transaction => work(new DeviceRepo(transaction)))
  }

  async createInstallation(input: NewInstallation): Promise<void> {
    await this.db.insertInto('desktop_installations').values({
      id: input.id,
      credential_sha256: input.credentialSha256,
      client_version: input.clientVersion,
      capabilities: JSON.stringify(input.capabilities),
      last_seen_at: input.now,
    }).execute()
  }

  async findInstallation(id: string, forUpdate = false): Promise<StoredInstallation | null> {
    let query = this.db.selectFrom('desktop_installations')
      .select([
        'id',
        'credential_sha256',
        'client_version',
        'capabilities',
        'last_seen_at',
        'revoked_at',
      ])
      .where('id', '=', id)
    if (forUpdate) query = query.forUpdate()
    const row = await query.executeTakeFirst()
    if (!row) return null
    return {
      id: row.id,
      credentialSha256: row.credential_sha256,
      clientVersion: row.client_version,
      capabilities: row.capabilities as DesktopInstallationCapability[],
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    }
  }

  async touchInstallation(
    id: string,
    input: {
      clientVersion: string
      capabilities: DesktopInstallationCapability[]
      now: Date
    },
  ): Promise<void> {
    await this.db.updateTable('desktop_installations').set({
      client_version: input.clientVersion,
      capabilities: JSON.stringify(input.capabilities),
      last_seen_at: input.now,
    }).where('id', '=', id).execute()
  }

  findAccounts(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([])
    return this.db.selectFrom('accounts')
      .select(['id', 'owner_user_id', 'platform', 'connection_mode'])
      .where('id', 'in', ids)
      .execute()
  }

  async pendingTaskAccountIds(installationId: string, accountIds: string[]): Promise<string[]> {
    if (accountIds.length === 0) return []
    const rows = await this.db.selectFrom('desktop_cleanup_tasks')
      .select('account_id')
      .where('installation_id', '=', installationId)
      .where('account_id', 'in', accountIds)
      .where('state', '=', 'pending')
      .execute()
    return rows.map(row => row.account_id)
  }

  async upsertMounts(
    installationId: string,
    ownerUserId: string,
    accountIds: string[],
    now: Date,
  ): Promise<void> {
    if (accountIds.length === 0) return
    await this.db.insertInto('account_device_mounts').values(accountIds.map(accountId => ({
      installation_id: installationId,
      account_id: accountId,
      owner_user_id: ownerUserId,
      last_seen_at: now,
    }))).onConflict(conflict => conflict
      .columns(['installation_id', 'account_id'])
      .doUpdateSet({ owner_user_id: ownerUserId, last_seen_at: now }))
      .execute()
  }

  async listMounts(accountId: string, ownerUserId: string): Promise<InstallationMount[]> {
    const rows = await this.db.selectFrom('account_device_mounts as mount')
      .innerJoin('desktop_installations as installation', 'installation.id', 'mount.installation_id')
      .select([
        'mount.installation_id',
        'mount.account_id',
        'mount.owner_user_id',
        'mount.last_seen_at',
        'installation.last_seen_at as installation_last_seen_at',
        'installation.revoked_at as installation_revoked_at',
        'installation.capabilities',
      ])
      .where('mount.account_id', '=', accountId)
      .where('mount.owner_user_id', '=', ownerUserId)
      .orderBy('mount.installation_id')
      .execute()
    return rows.map(row => ({
      installationId: row.installation_id,
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      lastSeenAt: row.last_seen_at,
      installationLastSeenAt: row.installation_last_seen_at,
      installationRevokedAt: row.installation_revoked_at,
      capabilities: row.capabilities as DesktopInstallationCapability[],
    }))
  }

  async ensurePendingTask(input: NewCleanupTask): Promise<void> {
    let query = this.db.selectFrom('desktop_cleanup_tasks')
      .select('id')
      .where('account_id', '=', input.accountId)
      .where('state', '=', 'pending')
    query = input.installationId === null
      ? query.where('installation_id', 'is', null)
      : query.where('installation_id', '=', input.installationId)
    if (await query.executeTakeFirst()) return

    await this.db.insertInto('desktop_cleanup_tasks').values({
      installation_id: input.installationId,
      account_id: input.accountId,
      mode: input.mode,
      reason: input.reason,
      state: 'pending',
    }).execute()
  }

  async listAutomaticTasks(installationId: string): Promise<DesktopCleanupTask[]> {
    const rows = await this.db.selectFrom('desktop_cleanup_tasks')
      .selectAll()
      .where('installation_id', '=', installationId)
      .where('mode', '=', 'automatic')
      .where('state', '=', 'pending')
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    return rows.map(toCleanupTask)
  }

  async findCleanupTask(id: string, forUpdate = false): Promise<DesktopCleanupTask | null> {
    let query = this.db.selectFrom('desktop_cleanup_tasks').selectAll().where('id', '=', id)
    if (forUpdate) query = query.forUpdate()
    const row = await query.executeTakeFirst()
    return row ? toCleanupTask(row) : null
  }

  async completeTask(id: string, now: Date): Promise<void> {
    await this.db.updateTable('desktop_cleanup_tasks').set({
      state: 'completed',
      completed_at: now,
    }).where('id', '=', id).where('state', '=', 'pending').execute()
  }

  async deleteMount(installationId: string, accountId: string): Promise<void> {
    await this.db.deleteFrom('account_device_mounts')
      .where('installation_id', '=', installationId)
      .where('account_id', '=', accountId)
      .execute()
  }

  async deleteCompletedBefore(cutoff: Date): Promise<void> {
    await this.db.deleteFrom('desktop_cleanup_tasks')
      .where('state', '=', 'completed')
      .where('completed_at', '<', cutoff)
      .execute()
  }
}

function toCleanupTask(row: {
  id: string
  installation_id: string | null
  account_id: string
  mode: 'automatic' | 'manual_required'
  reason: DesktopCleanupReason
  state: 'pending' | 'completed'
  created_at: Date
  completed_at: Date | null
}): DesktopCleanupTask {
  return {
    id: row.id,
    installationId: row.installation_id,
    accountId: row.account_id,
    mode: row.mode,
    reason: row.reason,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  }
}
