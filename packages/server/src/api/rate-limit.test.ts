import type { FastifyInstance } from 'fastify'
import type Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MessageRouteDeps } from './routes/messages.js'

process.env.APP_ENV = 'test'
process.env.DATABASE_URL ??= 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'rate-limit-test-secret-with-more-than-32-characters'

let buildServer: typeof import('./server.js').buildServer
let WsHub: typeof import('./ws.js').WsHub
let dbModule: typeof import('../db/client.js')
let loginAccountKey: typeof import('./rate-limit.js').loginAccountKey
let loginIpKey: typeof import('./rate-limit.js').loginIpKey

const actorRepo = {
  findUser: async () => null,
  findMemberships: async () => [],
}

function createFailingRedis(): Redis {
  const commands: Record<string, unknown> = {}
  commands.defineCommand = (name: string): void => {
    commands[name] = (...args: unknown[]): void => {
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        const reportFailure = callback as (error: Error) => void
        reportFailure(new Error('synthetic redis connection detail'))
      }
    }
  }
  return commands as unknown as Redis
}

beforeAll(async () => {
  ;({ buildServer } = await import('./server.js'))
  ;({ WsHub } = await import('./ws.js'))
  ;({ loginAccountKey, loginIpKey } = await import('./rate-limit.js'))
  dbModule = await import('../db/client.js')
})

afterAll(async () => {
  await dbModule?.db.destroy()
})

describe('authentication rate-limit keys', () => {
  it('normalizes email and hashes it before composing a login bucket', () => {
    expect(loginAccountKey('2001:db8::1', ' User@Example.COM ')).toBe(
      'login-account:2001:db8:::b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514',
    )
  })

  it('maps IPv4-mapped IPv6 addresses to one IPv4 bucket', () => {
    expect(loginIpKey('::ffff:192.0.2.1')).toBe('login-ip:192.0.2.1')
  })

  it('groups rotating IPv6 addresses by their /64 allocation', () => {
    expect(loginIpKey('2001:db8:abcd:12::1')).toBe(loginIpKey('2001:db8:abcd:12::ffff'))
    expect(loginIpKey('2001:db8:abcd:12::1')).toBe('login-ip:2001:db8:abcd:12::')
  })
})

describe('trusted proxy boundary', () => {
  async function buildIpProbe(trustProxyHops: 0 | 1): Promise<FastifyInstance> {
    const app = await buildServer(
      {} as MessageRouteDeps,
      new WsHub(),
      {
        actorRepo,
        trustedProxyCidrs: trustProxyHops === 1 ? ['127.0.0.1'] : [],
      },
    )
    app.get('/api/auth/ip-probe', async request => ({ ip: request.ip }))
    return app
  }

  it('ignores an injected forwarding chain when proxy trust is disabled', async () => {
    const app = await buildIpProbe(0)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/ip-probe',
        headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
      })

      expect(response.json()).toEqual({ ip: '127.0.0.1' })
    } finally {
      await app.close()
    }
  })

  it('uses only the right-most forwarded address from the sole trusted proxy', async () => {
    const app = await buildIpProbe(1)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/ip-probe',
        headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
      })

      expect(response.json()).toEqual({ ip: '203.0.113.9' })
    } finally {
      await app.close()
    }
  })
})

describe('rate-limit dependency failure', () => {
  it('fails closed without exposing the Redis error', async () => {
    const app = await buildServer(
      {} as MessageRouteDeps,
      new WsHub(),
      {
        actorRepo,
        rateLimitRedis: createFailingRedis(),
      },
    )
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'rate-limit-failure@example.test',
          password: 'synthetic-password',
        },
      })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: 'authentication temporarily unavailable' })
      expect(response.body).not.toContain('redis')
      expect(response.body).not.toContain('synthetic')
    } finally {
      await app.close()
    }
  })
})
