import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { WhatsAppGraphError } from '../../whatsapp-cloud/graph-client.js'
import {
  WhatsAppOnboardingError,
  type WhatsAppCloudService,
} from '../../whatsapp-cloud/service.js'
import { renderWhatsAppOnboardingPage } from '../../whatsapp-cloud/onboarding-page.js'
import { parseWhatsAppWebhook } from '../../whatsapp-cloud/webhook-payload.js'
import {
  verifyWhatsAppChallengeToken,
  verifyWhatsAppWebhookSignature,
} from '../../whatsapp-cloud/signature.js'

export interface WhatsAppCloudRouteDeps {
  service: WhatsAppCloudService
  webhookVerifyToken: string
  appSecret: string
}

const verificationQuery = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string().min(1),
  'hub.challenge': z.string().min(1).max(256),
})

const onboardBody = z.object({
  displayName: z.string().trim().min(1).max(60),
  code: z.string().min(1).max(4096),
  wabaId: z.string().regex(/^\d+$/).max(64),
  phoneNumberId: z.string().regex(/^\d+$/).max(64),
})

const onboardingSessionBody = z.object({
  displayName: z.string().trim().min(1).max(60),
})
const onboardingSessionParam = z.object({ id: z.string().uuid() })
const completeOnboardingBody = z.object({
  ticket: z.string().min(32).max(256),
  code: z.string().min(1).max(4096),
  wabaId: z.string().regex(/^\d+$/).max(64),
  phoneNumberId: z.string().regex(/^\d+$/).max(64),
})

/** 无登录态的 Meta 回调，只靠 challenge token / POST HMAC 放行。 */
export async function whatsappWebhookRoutes(
  app: FastifyInstance,
  deps: WhatsAppCloudRouteDeps,
): Promise<void> {
  // 只在这个 Fastify encapsulation 内把 JSON 保留为 Buffer，其他业务路由继续正常 parse。
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.get('/api/webhooks/whatsapp', async (req, reply) => {
    const parsed = verificationQuery.safeParse(req.query)
    if (!parsed.success || !verifyWhatsAppChallengeToken(
      parsed.data['hub.verify_token'],
      deps.webhookVerifyToken,
    )) return reply.code(403).send({ error: 'forbidden' })
    return reply.type('text/plain').send(parsed.data['hub.challenge'])
  })

  app.post('/api/webhooks/whatsapp', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !verifyWhatsAppWebhookSignature(
      req.body,
      req.headers['x-hub-signature-256']?.toString(),
      deps.appSecret,
    )) return reply.code(403).send({ error: 'forbidden' })

    let decoded: unknown
    try {
      decoded = JSON.parse(req.body.toString('utf8')) as unknown
    } catch {
      return reply.code(400).send({ error: 'invalid webhook payload' })
    }
    const parsed = parseWhatsAppWebhook(decoded)
    if (!parsed) return reply.code(400).send({ error: 'invalid webhook payload' })

    // 只有规范消息/状态全部安全落库后才 ACK；失败让 Meta 按官方机制重投，唯一键负责去重。
    const result = await deps.service.handleWebhook(parsed)
    if (result.unsupportedMessageCount > 0) {
      req.log.warn(
        { count: result.unsupportedMessageCount },
        '[whatsapp-cloud] 已忽略当前版本不支持的消息类型',
      )
    }
    return { received: true }
  })
}

/** 公开 HTTPS onboarding 页面与一次性 ticket 完成端点；都不依赖 Electron JWT。 */
export async function whatsappOnboardingPublicRoutes(
  app: FastifyInstance,
  deps: WhatsAppCloudRouteDeps,
): Promise<void> {
  app.get('/whatsapp/cloud/onboard', async (_req, reply) => {
    const nonce = randomBytes(18).toString('base64')
    reply.header('Cache-Control', 'no-store')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net; `
      + `style-src 'nonce-${nonce}'; connect-src 'self' https://www.facebook.com https://graph.facebook.com; `
      + 'frame-src https://www.facebook.com https://web.facebook.com; frame-ancestors \'none\'; '
      + 'base-uri \'none\'; form-action \'none\'',
    )
    return reply.type('text/html; charset=utf-8').send(
      renderWhatsAppOnboardingPage(deps.service.publicConfig(), nonce),
    )
  })

  app.post('/api/whatsapp/cloud/onboard/complete', async (req, reply) => {
    const parsed = completeOnboardingBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '关联信息不合法' })
    try {
      await deps.service.completeOnboardingSession(parsed.data)
      return { ok: true }
    } catch (error) {
      if (error instanceof WhatsAppOnboardingError) {
        return reply.code(400).send({ error: '关联票据无效或已过期' })
      }
      if (error instanceof WhatsAppGraphError) {
        req.log.warn({ code: error.code }, '[whatsapp-cloud] Embedded Signup 完成失败')
        return reply.code(502).send({ error: 'Meta 未能确认 WhatsApp Business 授权' })
      }
      throw error
    }
  })
}

/** 已登录 owner/agent 使用的 Embedded Signup 配置与 code 交换。 */
export async function whatsappCloudAccountRoutes(
  app: FastifyInstance,
  deps: WhatsAppCloudRouteDeps,
): Promise<void> {
  app.get('/api/whatsapp/cloud/config', async () => deps.service.publicConfig())

  app.post('/api/whatsapp/cloud/onboarding-sessions', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能关联 WhatsApp 账号' })
    }
    const parsed = onboardingSessionBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '账号名称不合法' })
    const membership = await db.selectFrom('team_members')
      .select('team_id')
      .where('user_id', '=', req.actor.userId)
      .orderBy('is_lead', 'desc')
      .executeTakeFirst()
    const session = await deps.service.createOnboardingSession({
      ownerUserId: req.actor.userId,
      teamId: membership?.team_id ?? null,
      displayName: parsed.data.displayName,
    })
    return reply.code(201).send(session)
  })

  app.get('/api/whatsapp/cloud/onboarding-sessions/:id', async (req, reply) => {
    const params = onboardingSessionParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'session id 不合法' })
    const session = await deps.service.onboardingStatus(params.data.id, req.actor.userId)
    if (!session) return reply.code(404).send({ error: '关联会话不存在' })
    return {
      state: session.state,
      accountId: session.accountId,
      expiresAt: session.expiresAt.toISOString(),
    }
  })

  app.post('/api/whatsapp/cloud/accounts', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能关联 WhatsApp 账号' })
    }
    const parsed = onboardBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '关联信息不合法' })

    const membership = await db.selectFrom('team_members')
      .select('team_id')
      .where('user_id', '=', req.actor.userId)
      .orderBy('is_lead', 'desc')
      .executeTakeFirst()
    try {
      const account = await deps.service.onboardAccount({
        ownerUserId: req.actor.userId,
        teamId: membership?.team_id ?? null,
        displayName: parsed.data.displayName,
        code: parsed.data.code,
        wabaId: parsed.data.wabaId,
        phoneNumberId: parsed.data.phoneNumberId,
      })
      return reply.code(201).send({ account })
    } catch (error) {
      if (error instanceof WhatsAppGraphError) {
        req.log.warn({ code: error.code }, '[whatsapp-cloud] Embedded Signup 后端确认失败')
        return reply.code(502).send({ error: 'Meta 未能确认该 WhatsApp Business 账号授权' })
      }
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : ''
      if (code === '23505') {
        return reply.code(409).send({ error: '该 WhatsApp 号码已经关联到另一个账号' })
      }
      throw error
    }
  })
}
