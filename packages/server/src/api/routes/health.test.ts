import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MessageRouteDeps } from './messages.js'

process.env.APP_ENV = 'test'
process.env.DATABASE_URL ??= 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'health-route-test-secret-with-more-than-32-characters'

let buildServer: typeof import('../server.js').buildServer
let WsHub: typeof import('../ws.js').WsHub
let dbModule: typeof import('../../db/client.js')

const healthState: {
  initialized: boolean
  databaseHangs?: boolean
  databaseError?: Error
  redisError?: Error
} = { initialized: true }

const healthChecks = {
  timeoutMs: 20,
  database: async (): Promise<void> => {
    if (healthState.databaseHangs) await new Promise<void>(() => undefined)
    if (healthState.databaseError) throw healthState.databaseError
  },
  redis: async (): Promise<void> => {
    if (healthState.redisError) throw healthState.redisError
  },
  initialized: (): boolean => healthState.initialized,
}

describe('health routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    ;({ buildServer } = await import('../server.js'))
    ;({ WsHub } = await import('../ws.js'))
    dbModule = await import('../../db/client.js')

    app = await buildServer(
      {} as MessageRouteDeps,
      new WsHub(),
      {
        actorRepo: {
          findUser: async () => null,
          findMemberships: async () => [],
        },
        healthChecks,
      },
    )
  })

  beforeEach(() => {
    healthState.initialized = true
    delete healthState.databaseHangs
    delete healthState.databaseError
    delete healthState.redisError
  })

  afterAll(async () => {
    await app.close()
    await dbModule.db.destroy()
  })

  it('returns only a minimal ready status without authorization', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ready' })
  })

  it('returns a redacted 503 when a dependency fails', async () => {
    healthState.databaseError = new Error('sensitive database connection detail')

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready' })
    expect(response.body).not.toContain('sensitive')
    expect(response.body).not.toContain('database')
  })

  it('在依赖永不返回时仍于 deadline 后响应 503', async () => {
    healthState.databaseHangs = true
    const startedAt = Date.now()

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready' })
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('stays not ready until application initialization completes', async () => {
    healthState.initialized = false

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready' })
  })

  it('keeps liveness healthy when readiness dependencies fail', async () => {
    healthState.databaseError = new Error('database unavailable')
    healthState.redisError = new Error('redis unavailable')
    healthState.initialized = false

    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'live' })
  })

  it('does not make unrelated business routes public', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/accounts' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized' })
  })
})
