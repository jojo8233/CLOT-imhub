import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '../db/types.js'
import { recordTelegramShadowObservation } from '../shadow/telegram-repo.js'
import type { TelegramShadowObservation } from '../shadow/telegram.js'
import {
  messageRevision,
  type InsertMessageInput,
  type InsertMessageResult,
  type MessageRepo,
  type UpsertConversationInput,
} from './ingestor.js'

export interface SaveTranslationIfCurrentInput {
  messageId: string
  targetLang: string
  provider: string
  translatedText: string
  revision: string
  detectedLang: string | null
}

export interface MessageIdRemapResult {
  messageId: string
  conversationId: string
  changed: boolean
  /** temp/final 已各自落库时被合并删除的内部 messages.id。 */
  removedMessageId: string | null
  /** 非空表示事件违反消息身份约束，调用方必须永久拒绝而不是重试。 */
  integrityViolation?: 'cross_conversation'
}

export interface MessagePublicationSnapshot {
  id: string
  conversationId: string
  accountId: string
  ownerUserId: string
  platform: 'telegram' | 'signal' | 'whatsapp' | 'zoom'
  direction: 'in' | 'out'
  body: string
  translatedBody: string | null
  sentAt: Date
  editedAt: Date | null
  editVersion: number | null
  deletedAt: Date | null
}

interface StoredMessageIdentity {
  id: string
  conversation_id: string
  platform_message_id: string
  body: string
  body_lang: string | null
  edited_at: Date | null
  edit_version: number | null
  deleted_at: Date | null
}

function laterDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function firstHasNewerEdit(first: StoredMessageIdentity, second: StoredMessageIdentity): boolean {
  if (first.edit_version !== null || second.edit_version !== null) {
    if (first.edit_version === null) return false
    if (second.edit_version === null) return true
    return first.edit_version > second.edit_version
  }
  return first.edited_at !== null
    && (second.edited_at === null || first.edited_at > second.edited_at)
}

export class KyselyMessageRepo implements MessageRepo {
  private readonly accountLifecycleTails = new Map<string, Promise<void>>()

  constructor(private readonly db: Kysely<Database>) {}

  private async serializeAccountLifecycle<T>(
    accountId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    // 先在进程内排队，再取 DB connection。否则同账号 outbox burst 会让
    // 每个等 advisory lock 的请求都占一条连接，把池耗尽。DB advisory lock
    // 仍保留，用于多进程/多实例之间的最终串行化。
    const previous = this.accountLifecycleTails.get(accountId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.accountLifecycleTails.set(accountId, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.accountLifecycleTails.get(accountId) === tail) {
        this.accountLifecycleTails.delete(accountId)
      }
    }
  }

  private async lockAccountMessageLifecycle(
    trx: Transaction<Database>,
    accountId: string,
  ): Promise<void> {
    // alias 与当前 direct id 是同一条消息，却可能是不同字符串。按事件携带
    // id 加锁会让 edit/delete 与多段 remap 错开，导致状态落到随后被合并删除
    // 的旧行。这里用短事务的 account 级生命周期锁收口正确性；不同账号仍并行。
    const lockKey = `message-lifecycle:${accountId}`
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx)
  }

  private async pointAliases(
    trx: Transaction<Database>,
    accountId: string,
    platformMessageIds: string[],
    messageId: string,
  ): Promise<void> {
    for (const platformMessageId of new Set(platformMessageIds)) {
      await trx.insertInto('message_id_aliases').values({
        account_id: accountId,
        platform_message_id: platformMessageId,
        message_id: messageId,
      }).onConflict(oc => oc.columns(['account_id', 'platform_message_id']).doUpdateSet({
        message_id: messageId,
      })).execute()
    }
  }

  private async lockStoredMessageRows(
    trx: Transaction<Database>,
    messageIds: string[],
  ): Promise<void> {
    const ids = [...new Set(messageIds)].sort()
    if (ids.length === 0) return
    await trx.selectFrom('messages')
      .select('id')
      .where('id', 'in', ids)
      .orderBy('id')
      .forUpdate()
      .execute()
  }

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
    this.assertShadowObservationAccount(input.accountId, input.shadowObservation)
    return this.serializeAccountLifecycle(input.accountId, () => this.db.transaction().execute(async (trx) => {
      await this.lockAccountMessageLifecycle(trx, input.accountId)
      const existing = await this.findMessage(trx, input.accountId, input.platformMessageId)
      if (existing) {
        const result = await this.updateExistingMessage(trx, existing, input)
        await this.recordShadowObservation(trx, input.shadowObservation)
        return result
      }

      // 并发首次上报靠唯一约束兜底。DO NOTHING 后若没返回行，说明另一个事务抢先
      // 插入；再按 id/alias 读取即可，不能退回“先查再盲插”。
      const inserted = await trx.insertInto('messages')
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
          reply_to_platform_message_id: input.replyToPlatformMessageId,
          edited_at: input.editedAt,
          edit_version: input.editVersion,
          deleted_at: null,
          sent_at: input.sentAt,
          raw: JSON.stringify(input.raw) as never,
        })
        .onConflict((oc) => oc.columns(['account_id', 'platform_message_id']).doNothing())
        .returning('id')
        .executeTakeFirst()

      if (inserted) {
        await this.recordShadowObservation(trx, input.shadowObservation)
        return { id: inserted.id, isNew: true, contentChanged: false }
      }

      const raced = await this.findMessage(trx, input.accountId, input.platformMessageId)
      if (!raced) throw new Error('message conflict occurred but canonical row was not found')
      const result = await this.updateExistingMessage(trx, raced, input)
      await this.recordShadowObservation(trx, input.shadowObservation)
      return result
    }))
  }

  async saveTranslationIfCurrent(input: SaveTranslationIfCurrentInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // 与编辑更新争用同一行锁：谁先拿到都能得到确定结果。旧任务若先写，随后
      // 的编辑会删除译文；编辑若先完成，这里会看到新 revision 并拒绝旧结果。
      const message = await trx.selectFrom('messages')
        .select(['edited_at', 'edit_version'])
        .where('id', '=', input.messageId)
        .forUpdate()
        .executeTakeFirst()
      if (!message
        || messageRevision(message.edit_version, message.edited_at) !== input.revision) return false

      await trx.insertInto('message_translations').values({
        message_id: input.messageId,
        target_lang: input.targetLang,
        provider: input.provider,
        translated_text: input.translatedText,
      }).onConflict(oc => oc.columns(['message_id', 'target_lang']).doUpdateSet({
        translated_text: input.translatedText,
        provider: input.provider,
      })).execute()
      if (input.detectedLang) {
        await trx.updateTable('messages')
          .set({ body_lang: input.detectedLang })
          .where('id', '=', input.messageId)
          .execute()
      }
      return true
    })
  }

  async withMessageForPublish(
    messageId: string,
    action: (message: MessagePublicationSnapshot) => void,
  ): Promise<boolean> {
    return this.db.transaction().execute(async trx => {
      // share lock 持有到 WS publish 结束。更重要的是在锁内读取当前规范快照：旧
      // upsert 即使在 touch 等待期间被新编辑超越，也只会发布数据库里的最新版本。
      const row = await trx.selectFrom('messages')
        .select([
          'id', 'conversation_id', 'account_id', 'platform', 'direction', 'body',
          'sent_at', 'edited_at', 'edit_version', 'deleted_at',
        ])
        .where('id', '=', messageId)
        .forShare()
        .executeTakeFirst()
      if (!row) return false

      // 仍在同一事务连接内补齐发布所需信息，避免持有 share lock 时从全局连接池
      // 再取连接而形成池耗尽自锁。译文也必须在锁内读取：若 worker 先完成，首次
      // message 直接携带译文；若这里先拿锁，则 worker 会在 message 发布后再发事件。
      const account = await trx.selectFrom('accounts')
        .select('owner_user_id')
        .where('id', '=', row.account_id)
        .executeTakeFirstOrThrow()
      const translation = await trx.selectFrom('message_translations')
        .select('translated_text')
        .where('message_id', '=', row.id)
        .where('target_lang', '=', 'zh')
        .executeTakeFirst()
      action({
        id: row.id,
        conversationId: row.conversation_id,
        accountId: row.account_id,
        ownerUserId: account.owner_user_id,
        platform: row.platform,
        direction: row.direction,
        body: row.body,
        translatedBody: translation?.translated_text ?? null,
        sentAt: row.sent_at,
        editedAt: row.edited_at,
        editVersion: row.edit_version,
        deletedAt: row.deleted_at,
      })
      return true
    })
  }

  private async findMessage(
    executor: Kysely<Database> | Transaction<Database>,
    accountId: string,
    platformMessageId: string,
  ): Promise<StoredMessageIdentity | undefined> {
    const direct = await executor.selectFrom('messages')
      .select([
        'id', 'conversation_id', 'platform_message_id', 'body', 'body_lang',
        'edited_at', 'edit_version', 'deleted_at',
      ])
      .where('account_id', '=', accountId)
      .where('platform_message_id', '=', platformMessageId)
      .executeTakeFirst()
    if (direct) return direct

    return executor.selectFrom('message_id_aliases')
      .innerJoin('messages', 'messages.id', 'message_id_aliases.message_id')
      .select([
        'messages.id as id',
        'messages.conversation_id as conversation_id',
        'messages.platform_message_id as platform_message_id',
        'messages.body as body',
        'messages.body_lang as body_lang',
        'messages.edited_at as edited_at',
        'messages.edit_version as edit_version',
        'messages.deleted_at as deleted_at',
      ])
      .where('message_id_aliases.account_id', '=', accountId)
      .where('message_id_aliases.platform_message_id', '=', platformMessageId)
      .executeTakeFirst()
  }

  private async updateExistingMessage(
    trx: Transaction<Database>,
    existing: { id: string; edited_at: Date | null; edit_version: number | null },
    input: InsertMessageInput,
  ): Promise<InsertMessageResult> {
    if (!input.editedAt && input.editVersion === null) {
      return { id: existing.id, isNew: false, contentChanged: false }
    }

    const isNewerEdit = input.editVersion === null
      ? sql<boolean>`edit_version is null
          and (edited_at is null or edited_at < ${input.editedAt})`
      : sql<boolean>`(edit_version is null or edit_version < ${input.editVersion})`

    const updated = await trx.updateTable('messages')
      .set({
        body: input.body,
        body_lang: null,
        media_refs: JSON.stringify(input.mediaRefs) as never,
        reply_to_platform_message_id: input.replyToPlatformMessageId,
        edited_at: input.editedAt ?? existing.edited_at,
        edit_version: input.editVersion,
        raw: JSON.stringify(input.raw) as never,
      })
      .where('id', '=', existing.id)
      .where(isNewerEdit)
      .executeTakeFirst()
    const contentChanged = (updated.numUpdatedRows ?? 0n) > 0n

    if (contentChanged) {
      // 旧正文的译文已经失效。删掉后由 ingestor 重新派发同一个 messageId 的翻译任务。
      await trx.deleteFrom('message_translations').where('message_id', '=', existing.id).execute()
    }
    return { id: existing.id, isNew: false, contentChanged }
  }

  async markMessageDeleted(
    accountId: string,
    platformMessageId: string,
    deletedAt: Date,
    shadowObservation?: TelegramShadowObservation,
  ): Promise<{ messageId: string; conversationId: string; changed: boolean } | null> {
    this.assertShadowObservationAccount(accountId, shadowObservation)
    return this.serializeAccountLifecycle(accountId, () => this.db.transaction().execute(async (trx) => {
      await this.lockAccountMessageLifecycle(trx, accountId)
      await this.recordShadowObservation(trx, shadowObservation)
      const existing = await this.findMessage(trx, accountId, platformMessageId)
      if (!existing) return null
      const result = await trx.updateTable('messages')
        .set({ deleted_at: deletedAt })
        .where('id', '=', existing.id)
        .where(sql<boolean>`(deleted_at is null or deleted_at < ${deletedAt})`)
        .executeTakeFirst()
      return {
        messageId: existing.id,
        conversationId: existing.conversation_id,
        changed: (result.numUpdatedRows ?? 0n) > 0n,
      }
    }))
  }

  async remapMessageId(
    accountId: string,
    oldPlatformMessageId: string,
    newPlatformMessageId: string,
    shadowObservation?: TelegramShadowObservation,
  ): Promise<MessageIdRemapResult | null> {
    this.assertShadowObservationAccount(accountId, shadowObservation)
    if (oldPlatformMessageId === newPlatformMessageId) {
      if (shadowObservation) {
        await recordTelegramShadowObservation(this.db, shadowObservation)
      }
      const same = await this.findMessage(this.db, accountId, newPlatformMessageId)
      return same ? {
        messageId: same.id, conversationId: same.conversation_id,
        changed: false, removedMessageId: null,
      } : null
    }

    return this.serializeAccountLifecycle(accountId, () => this.db.transaction().execute(async (trx) => {
      await this.lockAccountMessageLifecycle(trx, accountId)
      await this.recordShadowObservation(trx, shadowObservation)
      let oldRow = await this.findMessage(trx, accountId, oldPlatformMessageId)
      let newRow = await this.findMessage(trx, accountId, newPlatformMessageId)
      // 翻译 worker 按内部 UUID 锁 messages 行，不走 platform id advisory lock。
      // 这里按 UUID 排序加 FOR UPDATE 并在等待后重读，确保已提交译文能被迁移；
      // 若 remap 先持锁，旧 worker 会在删除提交后看到无行并丢弃旧 revision。
      await this.lockStoredMessageRows(trx, [oldRow?.id, newRow?.id].filter((id): id is string => Boolean(id)))
      oldRow = await this.findMessage(trx, accountId, oldPlatformMessageId)
      newRow = await this.findMessage(trx, accountId, newPlatformMessageId)
      if (!oldRow && !newRow) return null
      if (oldRow && newRow && oldRow.id !== newRow.id
        && oldRow.conversation_id !== newRow.conversation_id) {
        // 平台 id remap 只能描述同一条消息。跨会话合并会静默删掉另一位客户的消息。
        return {
          messageId: oldRow.id,
          conversationId: oldRow.conversation_id,
          changed: false,
          removedMessageId: null,
          integrityViolation: 'cross_conversation',
        }
      }

      if (!oldRow && newRow) {
        await this.pointAliases(trx, accountId, [oldPlatformMessageId], newRow.id)
        return {
          messageId: newRow.id, conversationId: newRow.conversation_id,
          changed: false, removedMessageId: null,
        }
      }

      if (!oldRow) return null

      // 两个 id 已经都指向同一规范行，这是重放或多段 remap 的旧步骤。
      // 不能再把 direct id 改回 newPlatformMessageId，否则会丢掉当前更新的 direct id。
      if (newRow?.id === oldRow.id) {
        return {
          messageId: oldRow.id, conversationId: oldRow.conversation_id,
          changed: false, removedMessageId: null,
        }
      }

      if (newRow && newRow.id !== oldRow.id) {
        const deletedAt = laterDate(oldRow.deleted_at, newRow.deleted_at)

        if (firstHasNewerEdit(oldRow, newRow)) {
          // 临时 id 行包含更新的编辑版本时保留整行，避免只保留 final 行而丢失
          // body/media/reply/raw。final 行的删除状态仍要合并，随后把 direct id 改为 final。
          await trx.updateTable('messages')
            .set({ deleted_at: deletedAt })
            .where('id', '=', oldRow.id)
            .execute()
          await trx.updateTable('message_id_aliases')
            .set({ message_id: oldRow.id })
            .where('message_id', '=', newRow.id)
            .execute()
          await this.pointAliases(trx, accountId, [
            oldPlatformMessageId,
            oldRow.platform_message_id,
            newPlatformMessageId,
            newRow.platform_message_id,
          ], oldRow.id)
          await trx.deleteFrom('messages').where('id', '=', newRow.id).execute()
          await trx.updateTable('messages')
            .set({ platform_message_id: newRow.platform_message_id })
            .where('id', '=', oldRow.id)
            .execute()
          return {
            messageId: oldRow.id, conversationId: oldRow.conversation_id,
            changed: true, removedMessageId: newRow.id,
          }
        }

        // final 行版本相同或更新时以它为规范行。只有正文一致才迁移 temp 译文，
        // 否则 temp 译文属于旧正文，合并后会造成错译。
        if (oldRow.body === newRow.body) {
          await sql`
            insert into message_translations (message_id, target_lang, provider, translated_text, created_at)
            select ${newRow.id}::uuid, target_lang, provider, translated_text, created_at
            from message_translations where message_id = ${oldRow.id}::uuid
            on conflict (message_id, target_lang) do nothing
          `.execute(trx)
        }
        await trx.updateTable('messages')
          .set({
            deleted_at: deletedAt,
            body_lang: newRow.body_lang ?? (oldRow.body === newRow.body ? oldRow.body_lang : null),
          })
          .where('id', '=', newRow.id)
          .execute()
        await trx.updateTable('message_id_aliases')
          .set({ message_id: newRow.id })
          .where('message_id', '=', oldRow.id)
          .execute()
        await this.pointAliases(trx, accountId, [
          oldPlatformMessageId,
          oldRow.platform_message_id,
          newPlatformMessageId,
        ], newRow.id)
        await trx.deleteFrom('messages').where('id', '=', oldRow.id).execute()
        return {
          messageId: newRow.id, conversationId: newRow.conversation_id,
          changed: true, removedMessageId: oldRow.id,
        }
      }

      await this.pointAliases(trx, accountId, [
        oldPlatformMessageId,
        oldRow.platform_message_id,
      ], oldRow.id)
      await trx.updateTable('messages')
        .set({ platform_message_id: newPlatformMessageId })
        .where('id', '=', oldRow.id)
        .execute()
      return {
        messageId: oldRow.id, conversationId: oldRow.conversation_id,
        changed: true, removedMessageId: null,
      }
    }))
  }

  async touchConversation(conversationId: string, at: Date): Promise<void> {
    await this.db
      .updateTable('conversations')
      .set({
        last_message_at: sql<Date>`greatest(
          coalesce(last_message_at, '-infinity'::timestamptz),
          ${at}
        )`,
      })
      .where('id', '=', conversationId)
      .execute()
  }

  private async recordShadowObservation(
    trx: Transaction<Database>,
    observation: TelegramShadowObservation | undefined,
  ): Promise<void> {
    if (observation) await recordTelegramShadowObservation(trx, observation)
  }

  private assertShadowObservationAccount(
    accountId: string,
    observation: TelegramShadowObservation | undefined,
  ): void {
    if (observation && observation.accountId !== accountId) {
      throw new Error('shadow observation account does not match message account')
    }
  }
}
