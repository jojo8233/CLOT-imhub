import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import type { ScopedDb } from '../../rbac/scoped-db.js'
import type { AdapterManager } from '../../adapters/manager.js'
import type { TranslationGateway } from '../../translation/gateway.js'
import { resolveTargetLang } from '../../translation/target-lang.js'

const sendBody = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1, '消息内容不能为空白'),
  /** true 表示 body 已经是目标语言（员工在预览里看过并确认过的文本），原样发出，绝不再翻译一次。 */
  preTranslated: z.boolean().default(false),
  /** 不传时由 resolveTargetLang 按会话锁定/客户语言/兜底解析 */
  targetLang: z.string().min(2).optional(),
})

const previewBody = z.object({
  conversationId: z.string().uuid(),
  text: z.string().trim().min(1, '消息内容不能为空白'),
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
      'conversations.target_lang as target_lang',
      'accounts.id as account_id',
    ])
    .where('conversations.id', '=', conversationId)
    .executeTakeFirst()
}

/**
 * 客户从没发过消息的新会话（员工主动发起）：latestInboundLang 就是 null，
 * resolveTargetLang 会落到 FALLBACK_TARGET_LANG——这是唯一合理的选择，
 * 此时没有任何客户语言信号可用。
 */
async function findLatestInboundLang(scoped: ScopedDb, conversationId: string): Promise<string | null> {
  const row = await scoped.accountsJoinedWithConversations()
    .innerJoin('messages', 'messages.conversation_id', 'conversations.id')
    .select('messages.body_lang as body_lang')
    .where('conversations.id', '=', conversationId)
    .where('messages.direction', '=', 'in')
    .where('messages.deleted_at', 'is', null)
    .orderBy('messages.sent_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.body_lang ?? null
}

async function resolveConversationTargetLang(
  scoped: ScopedDb,
  conversationId: string,
  lockedLang: string | null,
): Promise<string> {
  const latestInboundLang = await findLatestInboundLang(scoped, conversationId)
  return resolveTargetLang({ lockedLang, latestInboundLang })
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
        'messages.sent_at as sent_at', 'messages.edited_at as edited_at',
        'message_translations.translated_text as translated_text',
      ])
      .where('conversations.id', '=', id)
      .where('messages.deleted_at', 'is', null)
      .orderBy('messages.sent_at', 'asc')
      .limit(500)
      .execute()
    return { messages }
  })

  /**
   * 预览：只翻译，不发送。员工确认无误后再调用 /api/messages/send（preTranslated: true）。
   *
   * 回译只是给员工的气味测试，不是正确性证明——回译服务失败不该挡住整个预览，
   * 所以单独 catch，backTranslated 退化成 null，前端提示「回译不可用」。
   */
  app.post('/api/messages/translate-preview', async (req, reply) => {
    const parsed = previewBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const conv = await findVisibleConversation(req.scoped, parsed.data.conversationId)
    if (!conv) return reply.code(404).send({ error: 'not found' })

    const targetLang = await resolveConversationTargetLang(
      req.scoped, parsed.data.conversationId, conv.target_lang,
    )

    const translated = await deps.gateway.translate({
      text: parsed.data.text,
      from: 'auto',
      to: targetLang,
      config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
    })

    let backTranslated: string | null = null
    try {
      const back = await deps.gateway.translate({
        text: translated.text,
        from: targetLang,
        to: 'zh',
        config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
      })
      backTranslated = back.text
    } catch (err) {
      req.log.warn({ err }, '[translate-preview] 回译失败，预览仍继续，只是不带回译对照')
    }

    return { translated: translated.text, backTranslated, targetLang, provider: translated.provider }
  })

  /**
   * 发送。preTranslated: true 时 body 已经是员工在预览里确认过的最终文本，
   * 原样发出，绝不重译——重译结果可能和员工看到、确认过的预览不一致，
   * 那样"先预览再确认"这件事就失去意义了。
   *
   * preTranslated 缺省为 false：保持 P0 时期的直接行为，员工输入中文、
   * 服务端翻译后发出——这条路径是给还没升级到预览流程的旧客户端用的。
   */
  app.post('/api/messages/send', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能发送消息' })
    }
    const parsed = sendBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const conv = await findVisibleConversation(req.scoped, parsed.data.conversationId)
    if (!conv) return reply.code(404).send({ error: 'not found' })

    let sentText = parsed.data.body
    let provider: string | undefined

    if (!parsed.data.preTranslated) {
      const targetLang = parsed.data.targetLang
        ?? await resolveConversationTargetLang(req.scoped, parsed.data.conversationId, conv.target_lang)

      const translated = await deps.gateway.translate({
        text: parsed.data.body,
        from: 'auto',
        to: targetLang,
        config: { global: config.DEFAULT_TRANSLATION_PROVIDER },
      })
      sentText = translated.text
      provider = translated.provider
    }

    const platformMessageId = await deps.adapters.send(
      conv.account_id,
      conv.platform_conversation_id,
      { body: sentText },
    )

    return { platformMessageId, sentText, provider }
  })
}
