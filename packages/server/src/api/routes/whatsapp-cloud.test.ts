import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Role } from '@im-hub/shared'
import type { ActorRepo } from '../actor.js'
import type { WhatsAppCloudService } from '../../whatsapp-cloud/service.js'

process.env.DATABASE_URL = 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'whatsapp-cloud-route-test-secret-32'

const USER_ID = 'cloud-route-user'
const APP_SECRET = 'route-app-secret'
const VERIFY_TOKEN = 'route-verify-token'

const actorRepo: ActorRepo = {
  findUser: async (userId) => userId === USER_ID
    ? { id: USER_ID, role: 'owner' as Role, disabled_at: null, session_version: 1 }
    : null,
  findMemberships: async () => [],
}

describe('WhatsApp Cloud API public webhook routes', () => {
  let app: FastifyInstance
  let handleWebhook: ReturnType<typeof vi.fn>
  let completeOnboardingSession: ReturnType<typeof vi.fn>
  let dbModule: typeof import('../../db/client.js')

  beforeAll(async () => {
    handleWebhook = vi.fn(async () => ({
      acceptedInbound: 1, acceptedStatuses: 0, unsupportedMessageCount: 0,
    }))
    completeOnboardingSession = vi.fn(async () => {})
    const service = {
      publicConfig: () => ({ appId: 'public-app-id', configId: 'public-config-id', graphApiVersion: 'v25.0' }),
      handleWebhook,
      onboardAccount: vi.fn(),
      completeOnboardingSession,
      createOnboardingSession: vi.fn(),
      onboardingStatus: vi.fn(),
      sendText: vi.fn(),
    } as unknown as WhatsAppCloudService
    const { buildServer } = await import('../server.js')
    app = await buildServer({
      adapters: {} as never,
      gateway: {} as never,
      whatsappCloud: service,
      whatsappCloudRoutes: { service, webhookVerifyToken: VERIFY_TOKEN, appSecret: APP_SECRET },
    }, new (await import('../ws.js')).WsHub(), { actorRepo })
    dbModule = await import('../../db/client.js')
  })

  afterAll(async () => {
    await app.close()
    await dbModule.db.destroy()
  })

  it('Meta GET challenge 不需要用户 JWT，但必须匹配 verify token', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-ok`,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).toBe('challenge-ok')

    const denied = await app.inject({
      method: 'GET',
      url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x',
    })
    expect(denied.statusCode).toBe(403)
  })

  it('POST 必须按原始字节通过 X-Hub-Signature-256 才交给 service', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
    const signature = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`
    const ok = await app.inject({
      method: 'POST', url: '/api/webhooks/whatsapp', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    })
    expect(ok.statusCode).toBe(200)
    expect(handleWebhook).toHaveBeenCalledTimes(1)

    const denied = await app.inject({
      method: 'POST', url: '/api/webhooks/whatsapp', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=wrong' },
    })
    expect(denied.statusCode).toBe(403)
    expect(handleWebhook).toHaveBeenCalledTimes(1)
  })

  it('公开 config 仍需要用户 JWT，且不返回 app secret 或 verify token', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/api/whatsapp/cloud/config' })
    expect(noAuth.statusCode).toBe(401)
    const { signSession } = await import('../../auth/session.js')
    const token = await signSession({ userId: USER_ID, sessionVersion: 1 }, process.env.JWT_SECRET ?? '')
    const ok = await app.inject({
      method: 'GET', url: '/api/whatsapp/cloud/config',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(ok.json()).toEqual({
      appId: 'public-app-id', configId: 'public-config-id', graphApiVersion: 'v25.0',
    })
    expect(ok.body).not.toContain(APP_SECRET)
    expect(ok.body).not.toContain(VERIFY_TOKEN)
  })

  it('HTTPS onboarding 页面不需要 JWT，使用严格 CSP 且公开完成端点只转交一次性票据', async () => {
    const page = await app.inject({ method: 'GET', url: '/whatsapp/cloud/onboard' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toContain('https://connect.facebook.net')
    expect(page.headers['content-security-policy']).toContain('https://graph.facebook.com')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.body).toContain("location.hash.slice(1)")
    expect(page.body).not.toContain(APP_SECRET)

    const complete = await app.inject({
      method: 'POST', url: '/api/whatsapp/cloud/onboard/complete',
      payload: {
        ticket: 't'.repeat(43), code: 'short-code', wabaId: '100001', phoneNumberId: '200001',
      },
    })
    expect(complete.statusCode).toBe(200)
    expect(completeOnboardingSession).toHaveBeenCalledWith({
      ticket: 't'.repeat(43), code: 'short-code', wabaId: '100001', phoneNumberId: '200001',
    })
  })
})
