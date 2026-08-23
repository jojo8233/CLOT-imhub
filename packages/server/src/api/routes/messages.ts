import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import type { ScopedDb } from '../../rbac/scoped-db.js'
import type { AdapterManager } from '../../adapters/manager.js'
import type { TranslationGateway } from '../../translation/gateway.js'

const sendBody = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1, '消息内容不能为空白'),
  targetLang: z.string().min(2),
})

export interface MessageRouteDeps {
  adapters: AdapterManager
  gateway: TranslationGateway
}

/** 在 scope 内查一个会话，查不到就是无权访问。所有会话相关操作都先过它。 */
async function findVisibleConversation(scoped: ScopedDb, conversationId: string) {
  return scoped.accountsJoinedWithConversations()
    .select([
      'conversations.id as conversation_id',
      'conversations.platform_conversation_id as platform_conversation_id',
      'accounts.id as account_id',
    ])
    .where('conversations.id', '=', conversationId)
    .executeTakeFirst()
}

export async function messageRoutes(app: FastifyInstance, deps: MessageRouteDeps): Promise<void> {
  app.get('/api/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string }
    const conv = await findVisibleConversation(req.scoped, id)
    if (!conv) return reply.code(404).send({ error: 'not found' })

    // 复用同一条 scoped 查询继续 join messages：既避免了裸 db 的二次未过滤查询，
    // 也不需要额外一次往返——上面的 findVisibleConversation 只用来产出 404。
    const messages = await req.scoped.accountsJoinedWithConversations()
      .innerJoin('messages', 'messages.conversation_id', 'conversations.id')
      .leftJoin('message_translations', j => j
        .onRef('message_translations.message_id', '=', 'messages.id')
        .on('message_translations.target_lang', '=', 'zh'))
      .select([
        'messages.id as id', 'messages.direction as direction', 'messages.body as body',
        'messages.sent_at as sent_at', 'message_translations.translated_text as translated_text',
      ])
      .where('conversations.id', '=', id)
      .orderBy('messages.sent_at', 'asc')
      .limit(500)
      .execute()
    return { messages }
  })

  /** 发送前同步翻译：员工输入中文，译成客户语言后再交给适配器。 */
  app.post('/api/messages/send', async (req, reply) => {
    const parsed = sendBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const conv = await findVisibleConversation(req.scoped, parsed.data.conversationId)
    if (!conv) return reply.code(404).send({ error: 'not found' })

    const translated = await deps.gateway.translate({
      text: parsed.data.body,
      from: 'auto',
      to: parsed.data.targetLang,
      config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
    })

    const platformMessageId = await deps.adapters.send(
      conv.account_id,
      conv.platform_conversation_id,
      { body: translated.text },
    )

    return { platformMessageId, sentText: translated.text, provider: translated.provider }
  })
}
