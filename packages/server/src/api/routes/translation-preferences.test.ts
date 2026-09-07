import type { FastifyInstance } from 'fastify'
import type {
  Role,
  TranslationPreference,
  TranslationProviderName,
} from '@im-hub/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'translation-preferences-route-test-secret'

const AGENT_ID = '10000000-0000-4000-8000-000000000001'

class MemoryPreferenceService {
  readonly setCalls: Array<{ userId: string; provider: TranslationProviderName }> = []
  private userDefault: TranslationProviderName = 'claude'

  reset(): void {
    this.setCalls.length = 0
    this.userDefault = 'claude'
  }

  async get(): Promise<TranslationPreference> {
    return {
      companyDefault: 'deepl',
      userDefault: this.userDefault,
      providers: [
        { provider: 'deepl', available: true },
        { provider: 'claude', available: true },
        { provider: 'openai', available: false },
      ],
    }
  }

  async set(userId: string, provider: TranslationProviderName): Promise<TranslationPreference> {
    this.setCalls.push({ userId, provider })
    this.userDefault = provider
    return this.get()
  }
}

const actorRepo: ActorRepo = {
  findUser: async userId => userId === AGENT_ID
    ? { id: AGENT_ID, role: 'agent' as Role, disabled_at: null, session_version: 1 }
    : null,
  findMemberships: async () => [],
}

const service = new MemoryPreferenceService()
let app: FastifyInstance
let token: string

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { signSession } = await import('../../auth/session.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer({
    adapters: {} as never,
    gateway: {} as never,
    translationPreferences: service,
  }, new WsHub(), { actorRepo })
  token = await signSession(
    { userId: AGENT_ID, sessionVersion: 1 },
    process.env.JWT_SECRET ?? '',
  )
})

beforeEach(() => service.reset())

afterAll(async () => {
  await app.close()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

function auth() {
  return { authorization: `Bearer ${token}` }
}

describe('translation preference routes', () => {
  it('returns availability without secrets and updates only the caller', async () => {
    const get = await app.inject({
      method: 'GET', url: '/api/translation/providers', headers: auth(),
    })
    expect(get.statusCode).toBe(200)
    expect(get.json()).toEqual({
      companyDefault: 'deepl',
      userDefault: 'claude',
      providers: [
        { provider: 'deepl', available: true },
        { provider: 'claude', available: true },
        { provider: 'openai', available: false },
      ],
    })
    expect(JSON.stringify(get.json())).not.toContain('key')

    const update = await app.inject({
      method: 'PATCH',
      url: '/api/session/translation-provider',
      headers: auth(),
      payload: { provider: 'deepl' },
    })
    expect(update.statusCode).toBe(200)
    expect(service.setCalls).toEqual([{ userId: AGENT_ID, provider: 'deepl' }])
  })

  it('rejects an unknown provider and a body-supplied user id', async () => {
    const unknown = await app.inject({
      method: 'PATCH', url: '/api/session/translation-provider', headers: auth(),
      payload: { provider: 'unknown' },
    })
    expect(unknown.statusCode).toBe(400)

    const impersonation = await app.inject({
      method: 'PATCH', url: '/api/session/translation-provider', headers: auth(),
      payload: { provider: 'deepl', userId: 'someone-else' },
    })
    expect(impersonation.statusCode).toBe(400)
    expect(service.setCalls).toEqual([])
  })

  it('requires authentication for both endpoints', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/translation/providers' })
    const update = await app.inject({
      method: 'PATCH', url: '/api/session/translation-provider', payload: { provider: 'deepl' },
    })
    expect(get.statusCode).toBe(401)
    expect(update.statusCode).toBe(401)
  })
})
