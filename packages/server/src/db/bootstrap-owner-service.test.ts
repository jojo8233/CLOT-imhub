import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { verifyPassword } from '../auth/password.js'
import { testDatabaseUrl } from './test-db.js'
import type { Database } from './types.js'
import { bootstrapOwner } from './bootstrap-owner-service.js'

process.env.DATABASE_URL ??= 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const NOW = new Date('2026-09-07T00:00:00.000Z')
const validInput = {
  email: ' Owner@Example.Test ',
  displayName: ' 管理员 ',
  password: 'synthetic-temporary-password',
  now: NOW,
}

beforeEach(async () => {
  await db.deleteFrom('users').execute()
})

afterAll(async () => db.destroy())

describe('bootstrapOwner', () => {
  it('在空库创建唯一、强制改密且 24 小时到期的 owner', async () => {
    const result = await bootstrapOwner(db, validInput)

    const owner = await db.selectFrom('users').selectAll().executeTakeFirstOrThrow()
    expect(result).toEqual({ id: owner.id })
    expect(owner).toMatchObject({
      email: 'owner@example.test',
      display_name: '管理员',
      role: 'owner',
      must_change_password: true,
      disabled_at: null,
    })
    expect(owner.temporary_password_expires_at?.toISOString())
      .toBe('2026-09-08T00:00:00.000Z')
    expect(owner.password_hash).not.toContain(validInput.password)
    expect(await verifyPassword(owner.password_hash, validInput.password)).toBe(true)
  })

  it('已有任意用户时拒绝且不修改现有行', async () => {
    const existing = await db.insertInto('users').values({
      email: 'existing@example.test',
      display_name: 'Existing',
      role: 'agent',
      password_hash: 'unchanged-hash',
    }).returningAll().executeTakeFirstOrThrow()

    await expect(bootstrapOwner(db, validInput)).rejects.toThrow('database is not empty')

    expect(await db.selectFrom('users').selectAll().execute()).toEqual([existing])
  })

  it('并发执行时仅一个成功并只留下一个 owner', async () => {
    const results = await Promise.allSettled([
      bootstrapOwner(db, validInput),
      bootstrapOwner(db, {
        ...validInput,
        email: 'second-owner@example.test',
      }),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'database is not empty' }),
    })
    expect(await db.selectFrom('users').select(['id', 'role']).execute())
      .toEqual([expect.objectContaining({ role: 'owner' })])
  })

  it.each([
    [{ ...validInput, email: 'not-an-email' }, 'email'],
    [{ ...validInput, displayName: ' ' }, 'display name'],
    [{ ...validInput, displayName: '👤'.repeat(101) }, 'display name'],
    [{ ...validInput, password: '🔐'.repeat(11) }, 'password'],
    [{ ...validInput, password: '🔐'.repeat(129) }, 'password'],
  ])('在散列和写库前拒绝非法输入 %#', async (input, expectedMessage) => {
    await expect(bootstrapOwner(db, input)).rejects.toThrow(expectedMessage)
    expect(await db.selectFrom('users').select('id').execute()).toEqual([])
  })
})
