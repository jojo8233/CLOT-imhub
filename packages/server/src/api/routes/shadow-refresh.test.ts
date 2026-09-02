import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Role } from '@im-hub/shared'
import type { Database } from '../../db/types.js'
import { testDatabaseUrl } from '../../db/test-db.js'
import {
  TelegramShadowCoverageInputError,
  type TelegramShadowCoverageReport,
} from '../../shadow/coverage.js'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'shadow-refresh-route-test-secret-32chars'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: testDatabaseUrl() }) }),
})
const coverage = { scan: vi.fn() }
const refresher = { refreshTdlib: vi.fn() }

let buildServer: typeof import('../server.js').buildServer
let signSession: typeof import('../../auth/session.js').signSession
let app: FastifyInstance
let ownerId: string
let managerId: string
let auditorId: string
let accountId: string
let conversationId: string
let ownerToken: string
let managerToken: string
let auditorToken: string
let teamId: string

function emptyStatusCounts() {
  return {
    matched: 0,
    mismatched: 0,
    tdlibOnly: 0,
    telegramTtOnly: 0,
    missing: 0,
    preObservation: 0,
    coverageUnavailable: 0,
    sourceLocal: 0,
  }
}

function coverageReport(candidates: string[] = []): TelegramShadowCoverageReport {
  return {
    sentAfter: new Date('2026-08-29T00:00:00.000Z'),
    sentBefore: new Date('2026-08-29T01:00:00.000Z'),
    coverageStartedAt: new Date('2026-08-29T00:10:00.000Z'),
    progress: { processedMessages: 1, pageMessages: 1, hasMore: false, nextCursor: null },
    messages: { final: 1, sourceLocal: 0 },
    facts: {
      total: 1,
      comparable: 1,
      ...emptyStatusCounts(),
      telegramTtOnly: candidates.length > 0 ? 1 : 0,
      matched: candidates.length > 0 ? 0 : 1,
    },
    byEventType: {
      upsert: {
        ...emptyStatusCounts(),
        telegramTtOnly: candidates.length > 0 ? 1 : 0,
        matched: candidates.length > 0 ? 0 : 1,
      },
      delete: emptyStatusCounts(),
    },
    repairability: {
      none: candidates.length > 0 ? 0 : 1,
      currentSnapshotFetchable: candidates.length > 0 ? 1 : 0,
      historicalEventUnrecoverable: 0,
      manualInvestigation: 0,
      preObservation: 0,
      coverageUnavailable: 0,
      sourceLocal: 0,
    },
    actions: {
      tdlibRefreshCandidateCount: candidates.length,
      tdlibRefreshCandidates: candidates,
    },
    samples: {
      matched: [],
      mismatched: [],
      tdlib_only: [],
      telegram_tt_only: [],
      missing: [],
      pre_observation: [],
      coverage_unavailable: [],
      source_local: [],
    },
  }
}

function fakeActorRepo(): ActorRepo {
  const roles = new Map<string, Role>([
    [ownerId, 'agent'],
    [managerId, 'manager'],
    [auditorId, 'auditor'],
  ])
  return {
    findUser: async (userId) => {
      const role = roles.get(userId)
      return role ? { id: userId, role, disabled_at: null } : null
    },
    findMemberships: async (userId) => userId === managerId
      ? [{ team_id: teamId, is_lead: true }]
      : userId === ownerId
        ? [{ team_id: teamId, is_lead: false }]
        : [],
  }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'dry_run',
    sentAfter: '2026-08-29T00:00:00.000Z',
    sentBefore: '2026-08-29T01:00:00.000Z',
    limit: 10,
    ...overrides,
  }
}

beforeEach(async () => {
  coverage.scan.mockReset().mockResolvedValue(coverageReport())
  refresher.refreshTdlib.mockReset().mockResolvedValue({
    requested: 1,
    found: 1,
    recorded: 1,
    unavailable: 0,
    unsupported: 0,
    failed: 0,
  })

  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('users').execute()
  await db.deleteFrom('teams').execute()

  teamId = (await db.insertInto('teams').values({ name: 'shadow team' })
    .returning('id').executeTakeFirstOrThrow()).id
  const createUser = async (email: string, role: Role): Promise<string> => (
    await db.insertInto('users').values({
      email,
      display_name: email,
      role,
      password_hash: 'x',
    }).returning('id').executeTakeFirstOrThrow()
  ).id
  ownerId = await createUser('shadow-owner@example.com', 'agent')
  managerId = await createUser('shadow-manager@example.com', 'manager')
  auditorId = await createUser('shadow-auditor@example.com', 'auditor')
  await db.insertInto('team_members').values([
    { team_id: teamId, user_id: ownerId, is_lead: false },
    { team_id: teamId, user_id: managerId, is_lead: true },
  ]).execute()
  accountId = (await db.insertInto('accounts').values({
    platform: 'telegram',
    owner_user_id: ownerId,
    team_id: teamId,
    display_name: 'Telegram',
    status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()).id
  conversationId = (await db.insertInto('conversations').values({
    account_id: accountId,
    platform_conversation_id: '6639331234',
    contact_external_id: 'contact',
  }).returning('id').executeTakeFirstOrThrow()).id

  ;({ buildServer } = await import('../server.js'))
  ;({ signSession } = await import('../../auth/session.js'))
  app = await buildServer({
    adapters: {} as never,
    gateway: {} as never,
    telegramShadowRefresh: { coverage, refresher },
  }, new (await import('../ws.js')).WsHub(), { actorRepo: fakeActorRepo() })
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('test JWT secret missing')
  ownerToken = await signSession({ userId: ownerId }, secret)
  managerToken = await signSession({ userId: managerId }, secret)
  auditorToken = await signSession({ userId: auditorId }, secret)
})

afterAll(async () => {
  await app?.close()
  await db.destroy()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

describe('POST /api/accounts/:id/telegram-shadow-refresh', () => {
  it('owner can run bounded dry-run without platform access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({ conversationId }),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mode).toBe('dry_run')
    expect(coverage.scan).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      conversationId,
      limit: 10,
    }))
    expect(refresher.refreshTdlib).not.toHaveBeenCalled()
  })

  it('visibility does not let manager or auditor operate an account they do not own', async () => {
    for (const token of [managerToken, auditorToken]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
        headers: auth(token),
        payload: payload(),
      })
      expect(response.statusCode).toBe(404)
    }
    expect(coverage.scan).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation and a connected account for active TDLib refresh', async () => {
    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({ mode: 'refresh_tdlib' }),
    })
    expect(unconfirmed.statusCode).toBe(400)
    expect(refresher.refreshTdlib).not.toHaveBeenCalled()

    await db.updateTable('accounts').set({ status: 'reconnecting' })
      .where('id', '=', accountId).execute()
    const offline = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({ mode: 'refresh_tdlib', confirm: 'REFRESH_TDLIB_SHADOW' }),
    })
    expect(offline.statusCode).toBe(409)
    expect(refresher.refreshTdlib).not.toHaveBeenCalled()
  })

  it('refreshes only dry-run candidates and returns post-refresh coverage', async () => {
    const before = coverageReport(['6639331234:3502'])
    const after = coverageReport()
    coverage.scan.mockReset()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after)

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({ mode: 'refresh_tdlib', confirm: 'REFRESH_TDLIB_SHADOW' }),
    })

    expect(response.statusCode).toBe(200)
    expect(refresher.refreshTdlib).toHaveBeenCalledWith(accountId, ['6639331234:3502'])
    expect(response.json()).toMatchObject({
      mode: 'refresh_tdlib',
      refresh: { requested: 1, found: 1, recorded: 1, failed: 0 },
      before: { actions: { tdlibRefreshCandidateCount: 1 } },
      after: { actions: { tdlibRefreshCandidateCount: 0 } },
    })
  })

  it('rolls back central ingest only for explicitly confirmed canonical ids', async () => {
    coverage.scan.mockReset()
      .mockResolvedValueOnce(coverageReport())
      .mockResolvedValueOnce(coverageReport())

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({
        mode: 'rollback_tdlib',
        confirm: 'ROLLBACK_TDLIB_INGEST',
        platformMessageIds: ['6639331234:3601'],
      }),
    })

    expect(response.statusCode).toBe(200)
    expect(refresher.refreshTdlib).toHaveBeenCalledWith(accountId, ['6639331234:3601'])
    expect(response.json()).toMatchObject({
      mode: 'rollback_tdlib',
      refresh: { requested: 1, found: 1, recorded: 1, failed: 0 },
    })
  })

  it('rejects ambiguous or non-canonical rollback targets before platform access', async () => {
    for (const overrides of [
      { mode: 'rollback_tdlib', platformMessageIds: ['6639331234:3601'] },
      {
        mode: 'rollback_tdlib',
        confirm: 'ROLLBACK_TDLIB_INGEST',
        platformMessageIds: ['6639331234:temp:telegram-tt:1'],
      },
      {
        mode: 'dry_run',
        platformMessageIds: ['6639331234:3601'],
      },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
        headers: auth(ownerToken),
        payload: payload(overrides),
      })
      expect(response.statusCode).toBe(400)
    }
    expect(refresher.refreshTdlib).not.toHaveBeenCalled()
  })

  it('rejects a conversation outside the account before scanning', async () => {
    const otherAccountId = (await db.insertInto('accounts').values({
      platform: 'telegram',
      owner_user_id: ownerId,
      display_name: 'Other',
      status: 'connected',
    }).returning('id').executeTakeFirstOrThrow()).id
    const otherConversationId = (await db.insertInto('conversations').values({
      account_id: otherAccountId,
      platform_conversation_id: '777000',
      contact_external_id: 'other',
    }).returning('id').executeTakeFirstOrThrow()).id

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload({ conversationId: otherConversationId }),
    })
    expect(response.statusCode).toBe(404)
    expect(coverage.scan).not.toHaveBeenCalled()
  })

  it('returns 400 only for scan input errors and preserves database failures as 500', async () => {
    coverage.scan.mockRejectedValueOnce(new TelegramShadowCoverageInputError('bad cursor'))
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload(),
    })
    expect(invalid.statusCode).toBe(400)

    coverage.scan.mockRejectedValueOnce(new Error('database unavailable'))
    const failed = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/telegram-shadow-refresh`,
      headers: auth(ownerToken),
      payload: payload(),
    })
    expect(failed.statusCode).toBe(500)
  })
})
