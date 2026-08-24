import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const targetLangBody = z.object({
  /** null 表示解锁、回到自动跟随客户语言 */
  targetLang: z.string().min(2).nullable(),
})

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

  /** 按会话锁定/解锁目标语言。锁定后自动跟随客户语言的推断（resolveTargetLang）失效。 */
  app.patch('/api/conversations/:id/target-lang', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = targetLangBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const ok = await req.scoped.updateConversationTargetLang(id, parsed.data.targetLang)
    if (!ok) return reply.code(404).send({ error: 'not found' })

    return { id, targetLang: parsed.data.targetLang }
  })
}
