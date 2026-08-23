import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/types.js'
import type {
  InsertMessageInput,
  InsertMessageResult,
  MessageRepo,
  UpsertConversationInput,
} from './ingestor.js'

export class KyselyMessageRepo implements MessageRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async upsertConversation(input: UpsertConversationInput): Promise<{ id: string }> {
    const row = await this.db
      .insertInto('conversations')
      .values({
        account_id: input.accountId,
        platform_conversation_id: input.platformConversationId,
        // 首次插入时若来自出向消息（联系人未知），用会话 id 兜底满足 NOT NULL；
        // 之后第一条入向消息会把它修正成真实的对方标识。
        contact_external_id: input.contactExternalId ?? input.platformConversationId,
        contact_display_name: input.contactDisplayName,
      })
      .onConflict((oc) =>
        oc.columns(['account_id', 'platform_conversation_id']).doUpdateSet((eb) => ({
          // 注意：不能用 eb.ref('excluded.contact_external_id') —— values() 里为了满足
          // NOT NULL 约束已经把 null 替换成了 platformConversationId 兜底值，
          // excluded 表里看到的永远不是真正的 null，COALESCE 就会失效。
          // 这里直接把原始（可能为 null）的输入值当参数绑进 SQL，绕开 excluded。
          contact_external_id: eb.fn.coalesce(
            sql<string | null>`${input.contactExternalId}`,
            eb.ref('conversations.contact_external_id'),
          ),
          contact_display_name: eb.fn.coalesce(
            sql<string | null>`${input.contactDisplayName}`,
            eb.ref('conversations.contact_display_name'),
          ),
        })),
      )
      .returning('id')
      .executeTakeFirstOrThrow()
    return row
  }

  async insertMessage(input: InsertMessageInput): Promise<InsertMessageResult> {
    const row = await this.db
      .insertInto('messages')
      .values({
        conversation_id: input.conversationId,
        account_id: input.accountId,
        platform: input.platform,
        platform_message_id: input.platformMessageId,
        direction: input.direction,
        sender_external_id: input.senderExternalId,
        body: input.body,
        body_lang: null,
        media_refs: JSON.stringify(input.mediaRefs) as never,
        sent_at: input.sentAt,
        raw: JSON.stringify(input.raw) as never,
      })
      // DO UPDATE 必须是无副作用的自赋值：目的只是让冲突时也能 RETURNING 出行，
      // 拿到既有消息的 id 去补偿可能丢失的翻译任务。DO NOTHING 不返回任何行。
      .onConflict((oc) =>
        oc
          .columns(['account_id', 'platform_message_id'])
          .doUpdateSet((eb) => ({ platform_message_id: eb.ref('excluded.platform_message_id') })),
      )
      // xmax = 0 是 Postgres 里区分"本次插入"与"走了 DO UPDATE 分支"的标准判据：
      // 新插入的行没有被任何事务标记删除，xmax 为 0；被 UPSERT 更新的行则非 0。
      .returning(['id', sql<boolean>`(xmax = 0)`.as('is_new')])
      .executeTakeFirstOrThrow()

    return { id: row.id, isNew: row.is_new }
  }

  async touchConversation(conversationId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('conversations')
      .set({ last_message_at: at })
      .where('id', '=', conversationId)
      .execute()
  }
}
