import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Insertable } from 'kysely'
import type { Role } from '@im-hub/shared'
import { NATIVE_CONTROL_AUTH_SCHEME } from '@im-hub/shared'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import type { AccountsTable } from '../../db/types.js'
import { signSession } from '../../auth/session.js'
import { signNativeControlGrant } from '../../auth/native-control-grant.js'
import { buildServer } from '../server.js'
import { WsHub } from '../ws.js'

const URL = '/api/accounts/signal-native/resolve-existing'
const ACI = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_ACI = '11111111-2222-4333-8444-555555555555'
let app: FastifyInstance
let teamId: string
let users: Record<Role | 'other', string>
let tokens: Record<Role | 'other', string>
let logs = ''

beforeAll(async () => {
  if (!new globalThis.URL(config.DATABASE_URL).pathname.endsWith('_test')) {
    throw new Error('Signal owner integration requires an isolated test database')
  }
  // Other route suites leave fixtures behind. File-level execution is serial,
  // and the single enabled owner constraint requires the same clean baseline.
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('message_reactions').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()
  app = await buildServer({
    get adapters(): never { throw new Error('Read-only resolver must not use adapters') },
    get gateway(): never { throw new Error('Read-only resolver must not use translation') },
  }, new WsHub(), { loggerStream: { write(message) { logs += message } } })
})

beforeEach(async () => {
  logs = ''
  const team = await db.insertInto('teams').values({ name: 'signal resolver synthetic team' })
    .returning('id').executeTakeFirstOrThrow()
  teamId = team.id
  const createUser = async (name: string, role: Role): Promise<string> => {
    const user = await db.insertInto('users').values({
      email: `${name}-${teamId}@example.invalid`, display_name: name, role, password_hash: 'synthetic-unused',
    }).returning('id').executeTakeFirstOrThrow()
    return user.id
  }
  users = {
    agent: await createUser('agent', 'agent'), other: await createUser('other', 'agent'),
    manager: await createUser('manager', 'manager'), owner: await createUser('owner', 'owner'),
    auditor: await createUser('auditor', 'auditor'),
  }
  await db.insertInto('team_members').values([
    { user_id: users.agent, team_id: teamId, is_lead: false },
    { user_id: users.manager, team_id: teamId, is_lead: true },
  ]).execute()
  const token = (role: Role | 'other') => signSession({ userId: users[role], sessionVersion: 1 }, config.JWT_SECRET)
  tokens = {
    agent: await token('agent'), other: await token('other'), manager: await token('manager'),
    owner: await token('owner'), auditor: await token('auditor'),
  }
})

afterEach(async () => {
  expect(logs).not.toContain(ACI)
  await db.deleteFrom('accounts').where('owner_user_id', 'in', Object.values(users)).execute()
  await db.deleteFrom('team_members').where('team_id', '=', teamId).execute()
  await db.deleteFrom('users').where('id', 'in', Object.values(users)).execute()
  await db.deleteFrom('teams').where('id', '=', teamId).execute()
})

afterAll(async () => {
  await app?.close()
  await db.destroy()
})

async function account(overrides: Partial<Insertable<AccountsTable>> = {}): Promise<string> {
  const row = await db.insertInto('accounts').values({
    owner_user_id: users.agent, team_id: teamId, platform: 'signal', connection_mode: 'native_desktop',
    display_name: 'synthetic Signal', status: 'connected', platform_account_external_id: ACI,
    native_control_version: 7, ...overrides,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

async function resolve(
  role: Role | 'other' = 'agent',
  payload: object = { platformAccountExternalId: ACI },
  authorization = `Bearer ${tokens[role]}`,
) {
  const before = await db.selectFrom('accounts').selectAll()
    .where('owner_user_id', 'in', Object.values(users)).orderBy('id').execute()
  const response = await app.inject({ method: 'POST', url: URL, headers: { authorization }, payload })
  const after = await db.selectFrom('accounts').selectAll()
    .where('owner_user_id', 'in', Object.values(users)).orderBy('id').execute()
  expect(after).toEqual(before)
  expect(response.body.toLowerCase()).not.toContain(ACI)
  return response
}

describe('Signal native existing identity resolution', () => {
  it('resolves the unique existing owned identity with normalization and no writes', async () => {
    const id = await account()
    await account({ platform_account_external_id: null, status: 'pending_auth', native_control_version: 0 })
    const response = await resolve('agent', { platformAccountExternalId: ` ${ACI.toUpperCase()} ` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ accountId: id })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('does not claim an empty identity for the presented ACI', async () => {
    await account({ platform_account_external_id: null, status: 'pending_auth', native_control_version: 0 })
    expect((await resolve()).statusCode).toBe(404)
  })

  it('rejects ambiguous existing accounts instead of choosing the first', async () => {
    await account()
    await account()
    expect((await resolve()).statusCode).toBe(409)
  })

  it.each(['other', 'owner', 'manager'] as const)('does not let %s resolve another user’s account', async role => {
    await account()
    if (role !== 'other') {
      const visible = await app.inject({ method: 'GET', url: '/api/accounts',
        headers: { authorization: `Bearer ${tokens[role]}` } })
      expect(visible.json().accounts).toHaveLength(1)
    }
    expect((await resolve(role)).statusCode).toBe(404)
  })

  it.each(['owner', 'manager'] as const)('allows %s to resolve their own account', async role => {
    const id = await account({ owner_user_id: users[role] })
    expect((await resolve(role)).json()).toEqual({ accountId: id })
  })

  it('ignores matching accounts owned by others when the caller has one unique match', async () => {
    const id = await account()
    await account({ owner_user_id: users.other })
    expect((await resolve()).json()).toEqual({ accountId: id })
  })

  it.each([
    { connection_mode: 'adapter' as const },
    { platform: 'telegram' as const, connection_mode: 'adapter' as const },
    { platform_account_external_id: OTHER_ACI },
  ])('does not match an ineligible platform, mode or identity: %j', async overrides => {
    await account(overrides)
    expect((await resolve()).statusCode).toBe(404)
  })

  it.each([
    {}, { platformAccountExternalId: '' }, { platformAccountExternalId: 'not-an-aci' },
    { platformAccountExternalId: 42 }, { platformAccountExternalId: ACI, accountId: 'caller-choice' },
    { platformAccountExternalId: ACI, ownerUserId: 'caller-choice' },
    { platformAccountExternalId: ACI, candidates: [] }, [],
  ])('rejects malformed or extra body fields: %j', async payload => {
    await account()
    expect((await resolve('agent', payload)).statusCode).toBe(400)
  })

  it.each(['', 'Bearer invalid', `${NATIVE_CONTROL_AUTH_SCHEME} synthetic-invalid`])(
    'requires a normal valid Bearer session (credential case %#)', async authorization => {
      await account()
      const response = await resolve('agent', undefined, authorization)
      expect(response.statusCode).toBe(401)
      expect(response.headers['cache-control']).toBe('no-store')
    },
  )

  it('rejects auditors even when the identity is owned by the auditor', async () => {
    await account({ owner_user_id: users.auditor })
    expect((await resolve('auditor')).statusCode).toBe(403)
  })

  it('rejects even a valid NativeGrant instead of bypassing normal actor authentication', async () => {
    const id = await account()
    const { grant } = await signNativeControlGrant({
      userId: users.agent, accountId: id, platform: 'signal',
      expectedPlatformAccountExternalId: ACI, controlVersion: 7,
    }, config.JWT_SECRET)
    const response = await resolve('agent', undefined, `${NATIVE_CONTROL_AUTH_SCHEME} ${grant}`)
    expect(response.statusCode).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(logs).not.toContain(grant)
  })
})
