import type { FastifyInstance } from 'fastify'
import type {
  Role,
  TranslationPreference,
  TranslationProviderName,
} from '@im-hub/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActorRepo } from '../actor.js'

process.env.DATABASE_URL ??= 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'translate-route-test-secret-32-chars'

const AGENT_ID = '10000000-0000-4000-8000-000000000011'
const translate = vi.fn()
const resolveTranslationProvider = vi.fn<(
  userId: string,
  override?: TranslationProviderName,
) => Promise<TranslationProviderName>>()

const preferenceService = {
  get: vi.fn(async (): Promise<TranslationPreference> => ({
    companyDefault: 'deepl',
    userDefault: 'deepl',
    providers: [
      { provider: 'deepl', available: true },
      { provider: 'claude', available: true },
      { provider: 'openai', available: true },
    ],
  })),
  set: vi.fn(async (): Promise<TranslationPreference> => preferenceService.get()),
  resolve: resolveTranslationProvider,
}

const actorRepo: ActorRepo = {
  findUser: async userId => userId === AGENT_ID
    ? { id: AGENT_ID, role: 'agent' as Role, disabled_at: null, session_version: 1 }
    : null,
  findMemberships: async () => [],
}

let app: FastifyInstance
let token: string

beforeAll(async () => {
  const { buildServer } = await import('../server.js')
  const { signSession } = await import('../../auth/session.js')
  const { WsHub } = await import('../ws.js')
  app = await buildServer({
    adapters: {} as never,
    gateway: { translate } as never,
    translationPreferences: preferenceService,
  }, new WsHub(), { actorRepo })
  token = await signSession(
    { userId: AGENT_ID, sessionVersion: 1 },
    process.env.JWT_SECRET ?? '',
  )
})

beforeEach(() => {
  translate.mockReset()
  resolveTranslationProvider.mockReset().mockResolvedValue('deepl')
})

afterAll(async () => {
  await app.close()
  const dbModule = await import('../../db/client.js')
  await dbModule.db.destroy()
})

function auth() {
  return { authorization: `Bearer ${token}` }
}

describe('POST /api/translate/batch', () => {
  it('用调用者身份解析显式 provider，并返回实际降级元数据', async () => {
    resolveTranslationProvider.mockResolvedValueOnce('claude')
    translate.mockResolvedValueOnce({
      text: '你好', detectedLang: 'en', provider: 'openai', cached: false,
      downgradedFrom: ['claude'],
    })

    const response = await app.inject({
      method: 'POST', url: '/api/translate/batch', headers: auth(),
      payload: { texts: ['hello'], targetLang: 'zh', provider: 'claude' },
    })

    expect(response.statusCode).toBe(200)
    expect(resolveTranslationProvider).toHaveBeenCalledWith(AGENT_ID, 'claude')
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({
      config: { global: 'claude' },
    }))
    expect(response.json()).toMatchObject({
      results: [{
        translated: '你好', requestedProvider: 'claude', provider: 'openai',
        downgraded: true, failed: false,
      }],
    })
  })

  it('拒绝 body 夹带伪造用户身份', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/translate/batch', headers: auth(),
      payload: { texts: ['hello'], targetLang: 'zh', userId: 'someone-else' },
    })

    expect(response.statusCode).toBe(400)
    expect(resolveTranslationProvider).not.toHaveBeenCalled()
    expect(translate).not.toHaveBeenCalled()
  })
})
