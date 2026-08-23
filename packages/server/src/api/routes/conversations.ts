import type { FastifyInstance } from 'fastify'

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
      ])
      .orderBy('conversations.last_message_at', 'desc')
      .limit(200)
      .execute()
    return { conversations }
  })
}
