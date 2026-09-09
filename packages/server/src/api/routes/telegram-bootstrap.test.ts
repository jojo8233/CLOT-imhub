import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import type { MessageRouteDeps } from './messages.js'

const DATABASE_URL = testDatabaseUrl()
const JWT_SECRET = process.env.JWT_SECRET ?? 'synthetic-bootstrap-test-only-00000000'
const API_HASH_SENTINEL = 'aBcDeF0123456789aBcDeF0123456789'
const API_ID = 123456

process.env.APP_ENV ??= 'test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= JWT_SECRET

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession
let signNativeControlGrant: typeof import('../../auth/native-control-grant.js').signNativeControlGrant
let WsHub: typeof import('../ws.js').WsHub

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: DATABASE_URL }) }),
})
const deps = { adapters: {}, gateway: {} } as MessageRouteDeps
const capturedLogs: string[] = []
const loggerStream = {
  write(message: string): void {
    capturedLogs.push(message)
  },
}

let app: FastifyInstance
let teamId: string
let agentId: string
let managerId: string
let ownerId: string
let auditorId: string
let agentAccountId: string
let agentToken: string
let managerToken: string
let ownerToken: string
let auditorToken: string

function authorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

function expectNoStore(response: LightMyRequestResponse): void {
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers.pragma).toBe('no-cache')
  expect(response.headers['x-content-type-options']).toBe('nosniff')
}

function expectSecretAbsent(response: LightMyRequestResponse, secret = API_HASH_SENTINEL): void {
  expect(response.body).not.toContain(secret)
  expect(capturedLogs.join('')).not.toContain(secret)
}

async function createUser(email: string, role: Role): Promise<string> {
  const row = await db.insertInto('users')
    .values({ email, display_name: email, role, password_hash: 'synthetic' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function createAccount(input: {
  ownerUserId: string
  platform?: 'telegram' | 'signal'
  connectionMode?: 'adapter' | 'native_desktop'
  teamId?: string | null
  displayName?: string
}): Promise<string> {
  const row = await db.insertInto('accounts').values({
    owner_user_id: input.ownerUserId,
    team_id: input.teamId === undefined ? teamId : input.teamId,
    platform: input.platform ?? 'telegram',
    connection_mode: input.connectionMode ?? 'adapter',
    display_name: input.displayName ?? 'Synthetic account',
    status: 'pending_auth',
    credentials_ref: null,
    platform_account_external_id: null,
    linked_at: null,
  }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

async function createApp(telegramBootstrap: {
  readonly apiId: number
  readonly apiHash: string
}): Promise<FastifyInstance> {
  return buildServer(deps, new WsHub(), { telegramBootstrap, loggerStream })
}

async function cleanDatabase(): Promise<void> {
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()
}

beforeAll(async () => {
  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  ;({ signNativeControlGrant } = await import('../../auth/native-control-grant.js'))
  ;({ WsHub } = await import('../ws.js'))
  app = await createApp({ apiId: API_ID, apiHash: API_HASH_SENTINEL })
})

beforeEach(async () => {
  capturedLogs.length = 0
  await cleanDatabase()

  teamId = (await db.insertInto('teams').values({ name: 'Synthetic bootstrap team' })
    .returning('id').executeTakeFirstOrThrow()).id
  agentId = await createUser('bootstrap-agent@example.test', 'agent')
  managerId = await createUser('bootstrap-manager@example.test', 'manager')
  ownerId = await createUser('bootstrap-owner@example.test', 'owner')
  auditorId = await createUser('bootstrap-auditor@example.test', 'auditor')
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: agentId, is_lead: false },
    { team_id: teamId, user_id: managerId, is_lead: true },
  ]).execute()
  agentAccountId = await createAccount({ ownerUserId: agentId })

  agentToken = await signSession({ userId: agentId, sessionVersion: 1 }, JWT_SECRET)
  managerToken = await signSession({ userId: managerId, sessionVersion: 1 }, JWT_SECRET)
  ownerToken = await signSession({ userId: ownerId, sessionVersion: 1 }, JWT_SECRET)
  auditorToken = await signSession({ userId: auditorId, sessionVersion: 1 }, JWT_SECRET)
})

afterAll(async () => {
  await app?.close()
  await cleanDatabase()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe.sequential('POST /api/accounts/:id/telegram-bootstrap', () => {
  it('returns only the configured values for an owned pending-auth adapter account without mutating it', async () => {
    const before = await db.selectFrom('accounts').selectAll()
      .where('id', '=', agentAccountId).executeTakeFirstOrThrow()

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: authorization(agentToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ apiId: API_ID, apiHash: API_HASH_SENTINEL })
    expect(Object.keys(response.json())).toEqual(['apiId', 'apiHash'])
    expectNoStore(response)
    expect(response.headers.etag).toBeUndefined()
    const after = await db.selectFrom('accounts').selectAll()
      .where('id', '=', agentAccountId).executeTakeFirstOrThrow()
    expect(after).toEqual(before)
  })

  it('preserves the exact mixed-case hash and accepts the maximum Telegram api id', async () => {
    const boundaryApp = await createApp({ apiId: 2_147_483_647, apiHash: API_HASH_SENTINEL })
    try {
      const response = await boundaryApp.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        headers: authorization(agentToken),
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ apiId: 2_147_483_647, apiHash: API_HASH_SENTINEL })
      expectNoStore(response)
    } finally {
      await boundaryApp.close()
    }
  })

  it('allows manager and organization owner to bootstrap only accounts they personally own', async () => {
    const managerAccountId = await createAccount({ ownerUserId: managerId })
    const ownerAccountId = await createAccount({ ownerUserId: ownerId, teamId: null })

    for (const { accountId, token } of [
      { accountId: managerAccountId, token: managerToken },
      { accountId: ownerAccountId, token: ownerToken },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${accountId}/telegram-bootstrap`,
        headers: authorization(token),
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ apiId: API_ID, apiHash: API_HASH_SENTINEL })
      expectNoStore(response)
    }
  })

  it('returns 404 when manager or organization owner can see but does not own the account', async () => {
    for (const token of [managerToken, ownerToken]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        headers: authorization(token),
      })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({ error: 'telegram account unavailable' })
      expectNoStore(response)
      expectSecretAbsent(response)
    }
  })

  it('uses the live database role and rejects auditors', async () => {
    const ownedAuditorAccountId = await createAccount({ ownerUserId: auditorId, teamId: null })
    const directAuditor = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ownedAuditorAccountId}/telegram-bootstrap`,
      headers: authorization(auditorToken),
    })
    expect(directAuditor.statusCode).toBe(403)
    expect(directAuditor.json()).toEqual({ error: 'telegram bootstrap forbidden' })
    expectNoStore(directAuditor)
    expectSecretAbsent(directAuditor)

    await db.updateTable('users').set({ role: 'auditor' }).where('id', '=', agentId).execute()
    const changedAfterLogin = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: authorization(agentToken),
    })
    expect(changedAfterLogin.statusCode).toBe(403)
    expect(changedAfterLogin.json()).toEqual({ error: 'telegram bootstrap forbidden' })
    expectNoStore(changedAfterLogin)
    expectSecretAbsent(changedAfterLogin)
  })

  it('rejects missing, malformed, and NativeGrant authorization as user sessions', async () => {
    const { grant } = await signNativeControlGrant({
      userId: agentId,
      accountId: agentAccountId,
      platform: 'telegram',
      expectedPlatformAccountExternalId: 'synthetic-platform-identity',
      controlVersion: 0,
    }, JWT_SECRET)
    const headers = [undefined, { authorization: 'Bearer malformed' }, { authorization: `NativeGrant ${grant}` }]

    for (const requestHeaders of headers) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        ...(requestHeaders ? { headers: requestHeaders } : {}),
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'unauthorized' })
      expectNoStore(response)
      expectSecretAbsent(response)
    }

    const unauthorizedQuerySentinel = 'unauthorized-query-sentinel-must-not-reach-logs'
    const unauthorizedQuery = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap?apiHash=${unauthorizedQuerySentinel}`,
    })
    expect(unauthorizedQuery.statusCode).toBe(401)
    expect(unauthorizedQuery.json()).toEqual({ error: 'unauthorized' })
    expectNoStore(unauthorizedQuery)
    expect(unauthorizedQuery.body).not.toContain(unauthorizedQuerySentinel)
    expect(capturedLogs.join('')).not.toContain(unauthorizedQuerySentinel)
  })

  it('invalidates existing sessions immediately when the user is disabled or session version changes', async () => {
    await db.updateTable('users').set({ disabled_at: new Date() }).where('id', '=', agentId).execute()
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: authorization(agentToken),
    })
    expect(disabled.statusCode).toBe(401)
    expectNoStore(disabled)
    expectSecretAbsent(disabled)

    await db.updateTable('users').set({ disabled_at: null, session_version: 2 })
      .where('id', '=', agentId).execute()
    const staleVersion = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: authorization(agentToken),
    })
    expect(staleVersion.statusCode).toBe(401)
    expectNoStore(staleVersion)
    expectSecretAbsent(staleVersion)
  })

  it('returns fixed 400 for malformed UUID and for non-empty body or query', async () => {
    const malformedId = await app.inject({
      method: 'POST',
      url: '/api/accounts/not-a-uuid/telegram-bootstrap',
      headers: authorization(agentToken),
    })
    expect(malformedId.statusCode).toBe(400)
    expect(malformedId.json()).toEqual({ error: 'invalid telegram bootstrap request' })
    expectNoStore(malformedId)
    expectSecretAbsent(malformedId)

    const bodySentinel = 'body-sentinel-must-not-reach-logs'
    const body = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: authorization(agentToken),
      payload: { apiHash: bodySentinel },
    })
    expect(body.statusCode).toBe(400)
    expect(body.json()).toEqual({ error: 'invalid telegram bootstrap request' })
    expectNoStore(body)
    expectSecretAbsent(body)
    expect(body.body).not.toContain(bodySentinel)
    expect(capturedLogs.join('')).not.toContain(bodySentinel)

    const querySentinel = 'query-sentinel-must-not-reach-logs'
    const query = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap?apiHash=${querySentinel}`,
      headers: authorization(agentToken),
    })
    expect(query.statusCode).toBe(400)
    expect(query.json()).toEqual({ error: 'invalid telegram bootstrap request' })
    expectNoStore(query)
    expectSecretAbsent(query)
    expect(query.body).not.toContain(querySentinel)
    expect(capturedLogs.join('')).not.toContain(querySentinel)
  })

  it('returns fixed sanitized 400 for a non-empty body with an unsupported content type', async () => {
    const rawBodySentinel = 'unsupported-content-type-sentinel-must-not-be-reflected'
    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: {
        ...authorization(agentToken),
        'content-type': 'application/x-im-hub-unsupported',
      },
      payload: rawBodySentinel,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid telegram bootstrap request' })
    expectNoStore(response)
    expectSecretAbsent(response)
    expect(response.body).not.toContain(rawBodySentinel)
    expect(capturedLogs.join('')).not.toContain(rawBodySentinel)
  })

  it('returns fixed sanitized 400 for malformed JSON without reflecting parser details', async () => {
    const malformedJsonSentinel = 'malformed-json-sentinel-must-not-be-reflected'
    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
      headers: { ...authorization(agentToken), 'content-type': 'application/json' },
      payload: `{"apiHash":"${malformedJsonSentinel}"`,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'invalid telegram bootstrap request' })
    expectNoStore(response)
    expectSecretAbsent(response)
    expect(response.body).not.toContain(malformedJsonSentinel)
    expect(response.body).not.toContain('Unexpected')
    expect(capturedLogs.join('')).not.toContain(malformedJsonSentinel)
    expect(capturedLogs.join('')).not.toContain('Unexpected')
  })

  it('keeps request logging enabled for unrelated authenticated routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session/me',
      headers: authorization(agentToken),
    })
    expect(response.statusCode).toBe(200)
    expect(capturedLogs.join('')).toContain('/api/session/me')
    expect(capturedLogs.join('')).not.toContain(agentToken)
  })

  it('returns 404 for an absent account without exposing the configured hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/00000000-0000-4000-8000-000000000001/telegram-bootstrap',
      headers: authorization(agentToken),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'telegram account unavailable' })
    expectNoStore(response)
    expectSecretAbsent(response)
  })

  it('returns fixed 409 for owned non-Telegram or non-adapter accounts', async () => {
    const signalAccountId = await createAccount({ ownerUserId: agentId, platform: 'signal' })
    const nativeTelegramId = await createAccount({
      ownerUserId: agentId,
      platform: 'telegram',
      connectionMode: 'native_desktop',
    })
    for (const accountId of [signalAccountId, nativeTelegramId]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${accountId}/telegram-bootstrap`,
        headers: authorization(agentToken),
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toEqual({ error: 'telegram bootstrap unsupported' })
      expectNoStore(response)
      expectSecretAbsent(response)
    }
  })

  it.each([
    { apiId: 0, apiHash: API_HASH_SENTINEL },
    { apiId: -1, apiHash: API_HASH_SENTINEL },
    { apiId: 1.5, apiHash: API_HASH_SENTINEL },
    { apiId: 2_147_483_648, apiHash: API_HASH_SENTINEL },
    { apiId: Number.MAX_SAFE_INTEGER + 1, apiHash: API_HASH_SENTINEL },
    { apiId: API_ID, apiHash: '' },
    { apiId: API_ID, apiHash: '0123456789abcdef0123456789abcde' },
    { apiId: API_ID, apiHash: '0123456789abcdef0123456789abcdef0' },
    { apiId: API_ID, apiHash: 'g123456789abcdef0123456789abcdef' },
    { apiId: API_ID, apiHash: ` ${API_HASH_SENTINEL}` },
  ])('returns sanitized 503 for invalid server configuration %#', async invalidConfig => {
    const invalidApp = await createApp(invalidConfig)
    try {
      const response = await invalidApp.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        headers: authorization(agentToken),
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'telegram bootstrap unavailable' })
      expectNoStore(response)
      expectSecretAbsent(response)
      if (invalidConfig.apiHash !== '') {
        expect(response.body).not.toContain(invalidConfig.apiHash)
        expect(capturedLogs.join('')).not.toContain(invalidConfig.apiHash)
      }
    } finally {
      await invalidApp.close()
    }
  })

  it('registers the route unconditionally and returns 503 when default config is missing', async () => {
    const defaultConfigApp = await buildServer(deps, new WsHub(), { loggerStream })
    try {
      const response = await defaultConfigApp.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        headers: authorization(agentToken),
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'telegram bootstrap unavailable' })
      expectNoStore(response)
      expectSecretAbsent(response)
    } finally {
      await defaultConfigApp.close()
    }
  })

  it('sanitizes an unexpected SQL failure without logging the exception or configured hash', async () => {
    const hiddenTableName = 'accounts_unavailable_for_bootstrap_test'
    await sql.raw(`alter table accounts rename to ${hiddenTableName}`).execute(db)
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${agentAccountId}/telegram-bootstrap`,
        headers: authorization(agentToken),
      })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'telegram bootstrap unavailable' })
      expectNoStore(response)
      expectSecretAbsent(response)
      expect(capturedLogs.join('')).not.toContain('does not exist')
      expect(capturedLogs.join('')).not.toContain(hiddenTableName)
    } finally {
      await sql.raw(`alter table ${hiddenTableName} rename to accounts`).execute(db)
    }
  })
})
