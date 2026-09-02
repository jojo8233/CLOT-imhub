import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  CUSTOMER_PROFILE_MAX_CODE_POINTS,
  customerProfileCodePointLength,
  normalizeCustomerProfileText,
} from '@im-hub/shared'

const targetLangBody = z.object({
  /** null 表示解锁、回到自动跟随客户语言 */
  targetLang: z.string().min(2).nullable(),
})

function profileText(max: number) {
  return z.union([z.string(), z.null()])
    .transform(normalizeCustomerProfileText)
    .refine(value => value === null || customerProfileCodePointLength(value) <= max)
}

const customerProfileParams = z.object({ id: z.string().uuid() })

const customerProfileBody = z.object({
  name: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.name),
  ageLocation: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.ageLocation),
  occupation: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.occupation),
  family: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.family),
  interests: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.interests),
  other: profileText(CUSTOMER_PROFILE_MAX_CODE_POINTS.other),
  expectedRevision: z.number().int().min(0),
}).strict()

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/conversations', async (req) => {
    // 一条 join 查询直接拿会话，不再先查可见账号 id 再二次查询：
    // 少一次往返，也少一处可能忘记过滤的地方。
    const conversations = await req.scoped.accountsJoinedWithConversations()
      .select([
        'conversations.id as id',
        'conversations.account_id as account_id',
        'conversations.contact_display_name as contact_display_name',
        'conversations.contact_external_id as contact_external_id',
        'conversations.last_message_at as last_message_at',
        'conversations.target_lang as target_lang',
      ])
      .orderBy('conversations.last_message_at', 'desc')
      .limit(200)
      .execute()
    return { conversations }
  })

  app.get('/api/conversations/:id/customer-profile', async (req, reply) => {
    const params = customerProfileParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '客户档案请求无效' })
    const profile = await req.scoped.customerProfiles().get(params.data.id)
    if (!profile) return reply.code(404).send({ error: 'not found' })
    return profile
  })

  app.put('/api/conversations/:id/customer-profile', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能修改客户档案' })
    }
    const params = customerProfileParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '客户档案请求无效' })
    const parsed = customerProfileBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '客户档案内容无效' })

    const result = await req.scoped.customerProfiles().save(
      params.data.id,
      req.actor.userId,
      parsed.data,
    )
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'not found' })
    if (result.kind === 'conflict') {
      return reply.code(409).send({
        error: '档案已被其他人更新',
        currentRevision: result.currentRevision,
      })
    }
    return result.profile
  })

  /** 按会话锁定/解锁目标语言。锁定后自动跟随客户语言的推断（resolveTargetLang）失效。 */
  app.patch('/api/conversations/:id/target-lang', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能修改回复语言' })
    }
    const { id } = req.params as { id: string }
    const parsed = targetLangBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const ok = await req.scoped.updateConversationTargetLang(id, parsed.data.targetLang)
    if (!ok) return reply.code(404).send({ error: 'not found' })

    return { id, targetLang: parsed.data.targetLang }
  })
}
