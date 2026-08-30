import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from '../db/types.js'
import { testDatabaseUrl } from '../db/test-db.js'
import { buildTelegramDeleteObservation } from '../shadow/telegram.js'
import { KyselyMessageRepo } from './repo.js'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: testDatabaseUrl() }),
  }),
})
const repo = new KyselyMessageRepo(db)

let accountId: string
let ownerUserId: string

beforeEach(async () => {
  // 每个用例从干净状态开始；顺序按外键依赖倒序
  await db.deleteFrom('message_translations').execute()
  await db.deleteFrom('message_reactions').execute()
  await db.deleteFrom('messages').execute()
  await db.deleteFrom('conversations').execute()
  await db.deleteFrom('accounts').execute()
  await db.deleteFrom('team_members').execute()
  await db.deleteFrom('users').execute()

  const user = await db.insertInto('users').values({
    email: 'repo-test@example.com', display_name: 'T', role: 'agent', password_hash: 'x',
  }).returning('id').executeTakeFirstOrThrow()
  ownerUserId = user.id

  const acc = await db.insertInto('accounts').values({
    platform: 'telegram', owner_user_id: user.id, display_name: 'TG', status: 'connected',
  }).returning('id').executeTakeFirstOrThrow()

  accountId = acc.id
})

afterAll(async () => { await db.destroy() })

function msg(over: Partial<Parameters<typeof repo.insertMessage>[0]> = {}) {
  return {
    conversationId: '', accountId, platform: 'telegram' as const,
    platformMessageId: '555', direction: 'in' as const, senderExternalId: '777',
    body: 'hello', mediaRefs: [], replyToPlatformMessageId: null, editedAt: null,
    sentAt: new Date('2026-08-24T00:00:00Z'), raw: {},
    ...over,
    editVersion: over.editVersion ?? null,
  }
}

describe('KyselyMessageRepo.upsertConversation', () => {
  it('首次插入返回新 id', async () => {
    const { id } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    expect(id).toBeTruthy()
  })

  it('同一 (account, conversation) 重复 upsert 返回同一个 id', async () => {
    const a = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    const b = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    expect(b.id).toBe(a.id)
  })

  it('出向消息传 null 时不抹掉已知的联系人身份', async () => {
    await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: 'Jane',
    })
    await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: null, contactDisplayName: null,
    })
    const row = await db.selectFrom('conversations')
      .select(['contact_external_id', 'contact_display_name'])
      .where('platform_conversation_id', '=', 'c1').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('777')
    expect(row.contact_display_name).toBe('Jane')
  })

  it('会话由出向消息首次创建时用会话 id 兜底，之后被入向消息修正', async () => {
    await repo.upsertConversation({
      accountId, platformConversationId: 'c2', contactExternalId: null, contactDisplayName: null,
    })
    let row = await db.selectFrom('conversations').select('contact_external_id')
      .where('platform_conversation_id', '=', 'c2').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('c2')

    await repo.upsertConversation({
      accountId, platformConversationId: 'c2', contactExternalId: '888', contactDisplayName: 'Bob',
    })
    row = await db.selectFrom('conversations').select('contact_external_id')
      .where('platform_conversation_id', '=', 'c2').executeTakeFirstOrThrow()
    expect(row.contact_external_id).toBe('888')
  })
})

describe('KyselyMessageRepo.upsertMessageReaction', () => {
  it('目标消息未到也保存唯一回应，并拒绝同时间或更旧的乱序覆盖', async () => {
    const target = 'sender:1700000000000'
    const reactor = 'reactor'
    const firstAt = new Date('2026-08-30T01:00:00.000Z')
    const removedAt = new Date('2026-08-30T01:01:00.000Z')

    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, '👍', firstAt,
    )).resolves.toEqual({ changed: true })
    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, '❤️', firstAt,
    )).resolves.toEqual({ changed: false })
    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, null, firstAt,
    )).resolves.toEqual({ changed: true })
    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, '👍', firstAt,
    )).resolves.toEqual({ changed: false })
    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, null, removedAt,
    )).resolves.toEqual({ changed: true })
    await expect(repo.upsertMessageReaction(
      accountId, target, reactor, '👍', new Date('2026-08-30T01:00:30.000Z'),
    )).resolves.toEqual({ changed: false })

    const row = await db.selectFrom('message_reactions')
      .select(['emoji', 'reacted_at'])
      .where('account_id', '=', accountId)
      .where('platform_message_id', '=', target)
      .where('reactor_external_id', '=', reactor)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ emoji: null, reacted_at: removedAt })
  })

  it('同一目标的不同回应者各自保留一行', async () => {
    const target = 'sender:1700000000000'
    const reactedAt = new Date('2026-08-30T01:00:00.000Z')
    await repo.upsertMessageReaction(accountId, target, 'reactor-1', '👍', reactedAt)
    await repo.upsertMessageReaction(accountId, target, 'reactor-2', '❤️', reactedAt)
    const rows = await db.selectFrom('message_reactions')
      .select('reactor_external_id')
      .where('account_id', '=', accountId)
      .where('platform_message_id', '=', target)
      .orderBy('reactor_external_id')
      .execute()
    expect(rows).toEqual([
      { reactor_external_id: 'reactor-1' },
      { reactor_external_id: 'reactor-2' },
    ])
  })
})

describe('KyselyMessageRepo.insertMessage', () => {
  it('首次插入 isNew 为 true', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const r = await repo.insertMessage(msg({ conversationId }))
    expect(r.isNew).toBe(true)
    expect(r.id).toBeTruthy()
  })

  it('重复插入同一 platform_message_id 时 isNew 为 false 且返回既有 id', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId }))
    const second = await repo.insertMessage(msg({ conversationId, body: '改过的内容' }))
    expect(second.isNew).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('重复插入不会覆盖已存的消息内容', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({ conversationId }))
    await repo.insertMessage(msg({ conversationId, body: '改过的内容' }))
    const row = await db.selectFrom('messages').select('body')
      .where('platform_message_id', '=', '555').executeTakeFirstOrThrow()
    expect(row.body).toBe('hello')
  })

  it('数据库里只留一行，去重约束真的生效', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({ conversationId }))
    await repo.insertMessage(msg({ conversationId }))
    const rows = await db.selectFrom('messages').select('id')
      .where('platform_message_id', '=', '555').execute()
    expect(rows).toHaveLength(1)
  })

  it('消息与 shadow 来源观测在同一入库事务中收敛', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({
      conversationId,
      shadowObservation: {
        accountId, source: 'tdlib', eventType: 'upsert',
        factKey: 'upsert:555:base', semanticHash: 'a'.repeat(64),
      },
    }))

    const observation = await db.selectFrom('telegram_shadow_observations')
      .select(['source', 'fact_key', 'observation_count'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow()
    expect(observation).toEqual({
      source: 'tdlib', fact_key: 'upsert:555:base', observation_count: 1,
    })
  })

  it('拒绝把 shadow 观测记到其他账号，且不留半条消息', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await expect(repo.insertMessage(msg({
      conversationId,
      shadowObservation: {
        accountId: '00000000-0000-0000-0000-000000000000',
        source: 'tdlib', eventType: 'upsert',
        factKey: 'upsert:555:base', semanticHash: 'a'.repeat(64),
      },
    }))).rejects.toThrow('shadow observation account does not match message account')

    const rows = await db.selectFrom('messages').select('id').execute()
    expect(rows).toHaveLength(0)
  })

  it('带较新 editedAt 的事件更新正文并使旧译文失效', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId }))
    await db.updateTable('messages').set({ body_lang: 'en' }).where('id', '=', first.id).execute()
    await db.insertInto('message_translations').values({
      message_id: first.id, target_lang: 'zh', provider: 'deepl', translated_text: '旧译文',
    }).execute()

    const edited = await repo.insertMessage(msg({
      conversationId, body: 'edited body', editedAt: new Date('2026-08-24T01:00:00Z'),
      replyToPlatformMessageId: 'reply-1',
    }))
    expect(edited).toMatchObject({ id: first.id, isNew: false, contentChanged: true })
    const row = await db.selectFrom('messages')
      .select(['body', 'body_lang', 'reply_to_platform_message_id', 'edited_at'])
      .where('id', '=', first.id).executeTakeFirstOrThrow()
    expect(row.body).toBe('edited body')
    expect(row.reply_to_platform_message_id).toBe('reply-1')
    expect(row.edited_at?.toISOString()).toBe('2026-08-24T01:00:00.000Z')
    expect(row.body_lang).toBeNull()
    expect(await db.selectFrom('message_translations').select('message_id').execute()).toHaveLength(0)
  })

  it('只保存与当前正文 revision 匹配的译文', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({
      conversationId, editedAt: new Date('2026-08-24T01:00:00Z'),
    }))
    const base = {
      messageId: first.id, targetLang: 'zh', provider: 'deepl', translatedText: '译文', detectedLang: 'en',
    }
    expect(await repo.saveTranslationIfCurrent({ ...base, revision: 'initial' })).toBe(false)
    expect(await repo.saveTranslationIfCurrent({
      ...base, revision: '2026-08-24T01:00:00.000Z',
    })).toBe(true)
    const translation = await db.selectFrom('message_translations')
      .select('translated_text').where('message_id', '=', first.id).executeTakeFirstOrThrow()
    const message = await db.selectFrom('messages')
      .select('body_lang').where('id', '=', first.id).executeTakeFirstOrThrow()
    expect(translation.translated_text).toBe('译文')
    expect(message.body_lang).toBe('en')
  })

  it('有 editVersion 后只接受更大的版本，不再由 editedAt 猜测先后', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const editedAt = new Date('2026-08-24T01:00:00Z')
    const first = await repo.insertMessage(msg({
      conversationId, body: 'version 10', editedAt, editVersion: 10,
    }))

    const stale = await repo.insertMessage(msg({
      conversationId,
      body: 'stale version 9 with later clock',
      editedAt: new Date('2026-08-24T02:00:00Z'),
      editVersion: 9,
    }))
    expect(stale.contentChanged).toBe(false)

    const newer = await repo.insertMessage(msg({
      conversationId, body: 'version 11 in same second', editedAt, editVersion: 11,
    }))
    expect(newer.contentChanged).toBe(true)

    const row = await db.selectFrom('messages')
      .select(['body', 'edited_at', 'edit_version'])
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ body: 'version 11 in same second', edit_version: 11 })
    expect(row.edited_at?.toISOString()).toBe(editedAt.toISOString())

    const translation = {
      messageId: first.id,
      targetLang: 'zh',
      provider: 'deepl',
      translatedText: '译文',
      detectedLang: 'en',
    }
    expect(await repo.saveTranslationIfCurrent({ ...translation, revision: 'version:10' })).toBe(false)
    expect(await repo.saveTranslationIfCurrent({ ...translation, revision: 'version:11' })).toBe(true)
  })

  it('翻译 worker 先持有消息锁时，首次发布快照等待并携带已提交译文', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const message = await repo.insertMessage(msg({ conversationId }))

    let releaseWorker!: () => void
    let workerLocked!: () => void
    const release = new Promise<void>(resolve => { releaseWorker = resolve })
    const locked = new Promise<void>(resolve => { workerLocked = resolve })
    const worker = db.transaction().execute(async trx => {
      await trx.selectFrom('messages').select('id')
        .where('id', '=', message.id).forUpdate().executeTakeFirstOrThrow()
      await trx.insertInto('message_translations').values({
        message_id: message.id, target_lang: 'zh', provider: 'deepl', translated_text: '已完成译文',
      }).execute()
      workerLocked()
      await release
    })
    await locked

    let snapshot: Parameters<Parameters<typeof repo.withMessageForPublish>[1]>[0] | undefined
    const publishing = repo.withMessageForPublish(message.id, current => { snapshot = current })
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseWorker()
    await Promise.all([worker, publishing])

    expect(snapshot).toMatchObject({
      id: message.id,
      ownerUserId,
      translatedBody: '已完成译文',
    })
  })

  it('临时 id 换成最终 id 后，迟到的临时 id 重放仍命中同一行', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId, platformMessageId: 'temp-1' }))
    expect(await repo.remapMessageId(accountId, 'temp-1', 'final-1')).toMatchObject({ changed: true })

    const replay = await repo.insertMessage(msg({ conversationId, platformMessageId: 'temp-1' }))
    expect(replay).toMatchObject({ id: first.id, isNew: false })
    const rows = await db.selectFrom('messages').select(['id', 'platform_message_id']).execute()
    expect(rows).toEqual([{ id: first.id, platform_message_id: 'final-1' }])
  })

  it('多段 remap 后重放旧步骤不回退 direct id，所有历史 id 仍去重', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId, platformMessageId: 'temp-chain' }))
    await repo.remapMessageId(accountId, 'temp-chain', 'final-1-chain')
    await repo.remapMessageId(accountId, 'final-1-chain', 'final-2-chain')
    expect(await repo.remapMessageId(accountId, 'temp-chain', 'final-1-chain')).toMatchObject({
      messageId: first.id, changed: false,
    })

    for (const platformMessageId of ['temp-chain', 'final-1-chain', 'final-2-chain']) {
      expect(await repo.insertMessage(msg({ conversationId, platformMessageId }))).toMatchObject({
        id: first.id, isNew: false,
      })
    }
    expect(await db.selectFrom('messages').select(['id', 'platform_message_id']).execute())
      .toEqual([{ id: first.id, platform_message_id: 'final-2-chain' }])
  })

  it('temp/final 已各自落库时保留较新编辑、删除状态并报告被合并行', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const temp = await repo.insertMessage(msg({
      conversationId, platformMessageId: 'temp-1', body: 'initial',
    }))
    await repo.insertMessage(msg({
      conversationId,
      platformMessageId: 'temp-1',
      body: 'edited body',
      editedAt: new Date('2026-08-24T01:00:00Z'),
      mediaRefs: [{ kind: 'image', remoteId: 'image-1' }],
      replyToPlatformMessageId: 'reply-1',
      raw: { version: 'edited' },
    }))
    await repo.saveTranslationIfCurrent({
      messageId: temp.id, targetLang: 'zh', provider: 'deepl', translatedText: '新译文',
      revision: '2026-08-24T01:00:00.000Z', detectedLang: 'en',
    })
    const final = await repo.insertMessage(msg({
      conversationId, platformMessageId: 'final-1', body: 'initial',
    }))
    const deletedAt = new Date('2026-08-24T02:00:00Z')
    await repo.markMessageDeleted(accountId, 'final-1', deletedAt)

    const remapped = await repo.remapMessageId(accountId, 'temp-1', 'final-1')
    expect(remapped).toMatchObject({
      messageId: temp.id, removedMessageId: final.id, changed: true,
    })
    const rows = await db.selectFrom('messages').select([
      'id', 'platform_message_id', 'body', 'media_refs', 'reply_to_platform_message_id',
      'edited_at', 'deleted_at', 'raw',
    ]).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: temp.id,
      platform_message_id: 'final-1',
      body: 'edited body',
      media_refs: [{ kind: 'image', remoteId: 'image-1' }],
      reply_to_platform_message_id: 'reply-1',
      raw: { version: 'edited' },
    })
    expect(rows[0]?.edited_at?.toISOString()).toBe('2026-08-24T01:00:00.000Z')
    expect(rows[0]?.deleted_at?.toISOString()).toBe(deletedAt.toISOString())
    expect(await db.selectFrom('message_translations').select('translated_text')
      .where('message_id', '=', temp.id).executeTakeFirstOrThrow()).toMatchObject({
      translated_text: '新译文',
    })
  })

  it('编辑、删除与 temp/final remap 并发时不丢生命周期状态', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({
      conversationId, platformMessageId: 'temp-race', body: 'initial',
    }))
    await repo.insertMessage(msg({
      conversationId, platformMessageId: 'final-race', body: 'initial',
    }))
    const editedAt = new Date('2026-08-24T03:00:00Z')
    const deletedAt = new Date('2026-08-24T04:00:00Z')

    await Promise.all([
      repo.insertMessage(msg({
        conversationId, platformMessageId: 'temp-race', body: 'edited concurrently', editedAt,
      })),
      repo.markMessageDeleted(accountId, 'temp-race', deletedAt),
      repo.remapMessageId(accountId, 'temp-race', 'final-race'),
    ])

    const rows = await db.selectFrom('messages')
      .select(['platform_message_id', 'body', 'edited_at', 'deleted_at'])
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.platform_message_id).toBe('final-race')
    expect(rows[0]?.body).toBe('edited concurrently')
    expect(rows[0]?.edited_at?.toISOString()).toBe(editedAt.toISOString())
    expect(rows[0]?.deleted_at?.toISOString()).toBe(deletedAt.toISOString())
  })

  it('alias 删除与下一段 remap 并发时，删除状态落到最终规范行', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    await repo.insertMessage(msg({ conversationId, platformMessageId: 'temp-alias-race' }))
    await repo.remapMessageId(accountId, 'temp-alias-race', 'final-1-alias-race')
    await repo.insertMessage(msg({ conversationId, platformMessageId: 'final-2-alias-race' }))
    const deletedAt = new Date('2026-08-24T05:00:00Z')

    await Promise.all([
      repo.markMessageDeleted(accountId, 'temp-alias-race', deletedAt),
      repo.remapMessageId(accountId, 'final-1-alias-race', 'final-2-alias-race'),
    ])

    const rows = await db.selectFrom('messages')
      .select(['platform_message_id', 'deleted_at'])
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.platform_message_id).toBe('final-2-alias-race')
    expect(rows[0]?.deleted_at?.toISOString()).toBe(deletedAt.toISOString())
  })

  it('拒绝把同一账号下两个不同会话的消息 remap 合并', async () => {
    const firstConversation = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const secondConversation = await repo.upsertConversation({
      accountId, platformConversationId: 'c2', contactExternalId: '888', contactDisplayName: null,
    })
    await repo.insertMessage(msg({
      conversationId: firstConversation.id, platformMessageId: 'temp-cross',
    }))
    await repo.insertMessage(msg({
      conversationId: secondConversation.id, platformMessageId: 'final-cross',
    }))

    expect(await repo.remapMessageId(accountId, 'temp-cross', 'final-cross')).toMatchObject({
      changed: false,
      removedMessageId: null,
      integrityViolation: 'cross_conversation',
    })
    expect(await db.selectFrom('messages').select('id').execute()).toHaveLength(2)
  })

  it('翻译事务与 remap 并发时，已提交译文迁移到规范行', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const temp = await repo.insertMessage(msg({
      conversationId, platformMessageId: 'temp-translation', body: 'same body',
    }))
    await repo.insertMessage(msg({
      conversationId, platformMessageId: 'final-translation', body: 'same body',
    }))

    let releaseWorker!: () => void
    let workerLocked!: () => void
    const release = new Promise<void>(resolve => { releaseWorker = resolve })
    const locked = new Promise<void>(resolve => { workerLocked = resolve })
    const worker = db.transaction().execute(async trx => {
      await trx.selectFrom('messages').select('id')
        .where('id', '=', temp.id).forUpdate().executeTakeFirstOrThrow()
      await trx.insertInto('message_translations').values({
        message_id: temp.id, target_lang: 'zh', provider: 'deepl', translated_text: '并发译文',
      }).execute()
      workerLocked()
      await release
    })
    await locked
    const remap = repo.remapMessageId(accountId, 'temp-translation', 'final-translation')
    // 让 remap 到达 FOR UPDATE 等待点，再提交模拟中的 worker 事务。
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseWorker()
    const [, result] = await Promise.all([worker, remap])
    expect(result).not.toBeNull()
    if (!result) throw new Error('expected remap result')
    expect(await db.selectFrom('message_translations').select('translated_text')
      .where('message_id', '=', result.messageId).executeTakeFirstOrThrow()).toMatchObject({
      translated_text: '并发译文',
    })
  })

  it('删除事件幂等写入 deleted_at', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId }))
    const deletedAt = new Date('2026-08-24T02:00:00Z')
    expect(await repo.markMessageDeleted(accountId, '555', deletedAt)).toMatchObject({ changed: true })
    expect(await repo.markMessageDeleted(accountId, '555', deletedAt)).toMatchObject({ changed: false })
    const row = await db.selectFrom('messages').select('deleted_at').where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    expect(row.deleted_at?.toISOString()).toBe(deletedAt.toISOString())
  })

  it('删除状态与 TDLib shadow 观测在同一事务中落库', async () => {
    const { id: conversationId } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const first = await repo.insertMessage(msg({ conversationId }))
    const deletedAt = new Date('2026-08-24T02:00:00Z')

    expect(await repo.markMessageDeleted(
      accountId,
      '555',
      deletedAt,
      buildTelegramDeleteObservation(accountId, 'tdlib', '555'),
    )).toMatchObject({ changed: true })

    const message = await db.selectFrom('messages').select('deleted_at').where('id', '=', first.id)
      .executeTakeFirstOrThrow()
    const observation = await db.selectFrom('telegram_shadow_observations')
      .select(['source', 'event_type', 'fact_key', 'observation_count'])
      .where('account_id', '=', accountId)
      .where('fact_key', '=', 'delete:555')
      .executeTakeFirstOrThrow()
    expect(message.deleted_at?.toISOString()).toBe(deletedAt.toISOString())
    expect(observation).toEqual({
      source: 'tdlib', event_type: 'delete', fact_key: 'delete:555', observation_count: 1,
    })
  })
})

describe('KyselyMessageRepo.touchConversation', () => {
  it('last_message_at 只前进，不被迟到旧消息回退', async () => {
    const { id } = await repo.upsertConversation({
      accountId, platformConversationId: 'c1', contactExternalId: '777', contactDisplayName: null,
    })
    const at = new Date('2026-08-24T12:00:00Z')
    await repo.touchConversation(id, at)
    await repo.touchConversation(id, new Date('2026-08-24T10:00:00Z'))
    const row = await db.selectFrom('conversations').select('last_message_at')
      .where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.last_message_at?.toISOString()).toBe(at.toISOString())
  })
})
