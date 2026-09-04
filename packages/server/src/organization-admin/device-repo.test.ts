import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { DeviceRepo } from './device-repo.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})

const repo = new DeviceRepo(db)

beforeEach(async () => {
  await db.deleteFrom('desktop_cleanup_tasks').execute()
  await db.deleteFrom('account_device_mounts').execute()
  await db.deleteFrom('desktop_installations').execute()
})

afterAll(async () => db.destroy())

describe('DeviceRepo', () => {
  it('保存设备登记事实并按 id 读回', async () => {
    const installationId = randomUUID()
    const now = new Date('2026-09-05T00:00:00.000Z')

    await repo.createInstallation({
      id: installationId,
      credentialSha256: 'a'.repeat(64),
      clientVersion: '0.0.0-test',
      capabilities: ['partition_cleanup_v1'],
      now,
    })

    expect(await repo.findInstallation(installationId)).toEqual({
      id: installationId,
      credentialSha256: 'a'.repeat(64),
      clientVersion: '0.0.0-test',
      capabilities: ['partition_cleanup_v1'],
      lastSeenAt: now,
      revokedAt: null,
    })
  })

  it('仓储事务失败时不留下部分设备记录', async () => {
    const installationId = randomUUID()
    await expect(repo.transaction(async transactionRepo => {
      await transactionRepo.createInstallation({
        id: installationId,
        credentialSha256: 'b'.repeat(64),
        clientVersion: '0.0.0-test',
        capabilities: [],
        now: new Date('2026-09-05T00:00:00.000Z'),
      })
      throw new Error('synthetic rollback')
    })).rejects.toThrow('synthetic rollback')

    expect(await repo.findInstallation(installationId)).toBeNull()
  })
})
