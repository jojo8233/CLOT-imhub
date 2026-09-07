import Redis from 'ioredis'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MessageRouteDeps } from './routes/messages.js'

process.env.APP_ENV = 'test'
process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'redis-rate-limit-test-secret-with-more-than-32-characters'

let buildServer: typeof import('./server.js').buildServer
let WsHub: typeof import('./ws.js').WsHub
let loginAccountKey: typeof import('./rate-limit.js').loginAccountKey
let loginIpKey: typeof import('./rate-limit.js').loginIpKey
let dbModule: typeof import('../db/client.js')

const actorRepo = {
  findUser: async () => null,
  findMemberships: async () => [],
}

beforeAll(async () => {
  ;({ buildServer } = await import('./server.js'))
  ;({ WsHub } = await import('./ws.js'))
  ;({ loginAccountKey, loginIpKey } = await import('./rate-limit.js'))
  dbModule = await import('../db/client.js')
})

afterAll(async () => {
  await dbModule.db.destroy()
})

describe('Redis-backed authentication rate limits', () => {
  it('shares the login account bucket and TTL across two server instances', async () => {
    const redisA = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 })
    const redisB = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 })
    const appA = await buildServer(
      {} as MessageRouteDeps,
      new WsHub(),
      { actorRepo, rateLimitRedis: redisA },
    )
    const appB = await buildServer(
      {} as MessageRouteDeps,
      new WsHub(),
      { actorRepo, rateLimitRedis: redisB },
    )
    const ip = `198.18.${Math.floor(process.pid / 256) % 256}.${(process.pid % 254) + 1}`
    const email = `redis-shared-${process.pid}@example.test`
    const prefix = 'im-hub-auth-rate-limit-undefinedundefined-'
    const keys = [
      `${prefix}${loginIpKey(ip)}`,
      `${prefix}${loginAccountKey(ip, email)}`,
    ]
    const login = (app: FastifyInstance) => app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'synthetic-password' },
    })

    try {
      await redisA.del(...keys)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(appA)).statusCode).toBe(401)
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await login(appB)).statusCode).toBe(401)
      }

      const blocked = await login(appB)
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers['retry-after']).toBeDefined()
      const ttl = await redisB.pttl(keys[1]!)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000)
    } finally {
      await redisA.del(...keys)
      await Promise.all([appA.close(), appB.close()])
      redisA.disconnect()
      redisB.disconnect()
    }
  })
})
