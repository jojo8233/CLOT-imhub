import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { config } from './config.js'
import { db } from './db/client.js'
import { AdapterManager } from './adapters/manager.js'
import { SignalAdapter } from './adapters/signal/adapter.js'
import { TelegramAdapter } from './adapters/telegram/adapter.js'
import { KyselyMessageRepo } from './ingest/repo.js'
import { MessageIngestor } from './ingest/ingestor.js'
import { BullTranslateQueue, TRANSLATE_QUEUE, type TranslateJobData } from './pipeline/queue.js'
import { runTranslateJob } from './pipeline/translate-job.js'
import { TranslationCache } from './translation/cache.js'
import { TranslationGateway } from './translation/gateway.js'
import { DeeplProvider } from './translation/providers/deepl.js'
import { OpenAiProvider } from './translation/providers/openai.js'
import { ClaudeProvider } from './translation/providers/claude.js'
import { WsHub } from './api/ws.js'
import { buildServer } from './api/server.js'

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })

const gateway = new TranslationGateway(
  [
    new DeeplProvider(config.DEEPL_API_KEY, config.DEEPL_ENDPOINT),
    new OpenAiProvider(config.OPENAI_API_KEY),
    new ClaudeProvider(config.ANTHROPIC_API_KEY),
  ],
  new TranslationCache(redis),
  ['deepl', 'claude', 'openai'],
)

const adapters = new AdapterManager([
  new TelegramAdapter({
    apiId: config.TELEGRAM_API_ID,
    apiHash: config.TELEGRAM_API_HASH,
    dataDir: config.TDLIB_DATA_DIR,
  }),
  new SignalAdapter({
    binary: config.SIGNAL_CLI_BINARY,
    dataDir: config.SIGNAL_DATA_DIR,
  }),
])

const hub = new WsHub()
const queue = new BullTranslateQueue(redis)
const messageRepo = new KyselyMessageRepo(db)
const ingestor = new MessageIngestor(messageRepo, queue)

adapters.onMessage((msg) => {
  void (async () => {
    await ingestor.ingestDetailed(msg, async result => {
      if (!result.isNew && !msg.editedAt) return

      // 必须在翻译任务入队前推新消息。否则极快的 worker 可能先发 translation，
      // 客户端还没有对应消息行，只能丢掉这条实时译文。
      await messageRepo.withMessageForPublish(result.messageId, message => {
        if (message.deletedAt) return
        if (result.isNew) {
          hub.publishTo(message.ownerUserId, {
            type: 'message',
            messageId: message.id,
            conversationId: message.conversationId,
            accountId: message.accountId,
            platform: message.platform,
            direction: message.direction,
            body: message.body,
            // worker 若已先完成，快照会直接携带译文；否则随后由 translation 事件补上。
            translatedBody: message.translatedBody,
            sentAt: message.sentAt.toISOString(),
            editedAt: message.editedAt?.toISOString() ?? null,
          })
        } else if (message.editedAt
          && msg.editedAt
          && message.editedAt.toISOString() === msg.editedAt.toISOString()) {
          // shadow/fallback 适配器与原生回传可能竞争同一编辑。哪条链路先
          // 落库，哪条就负责发 update；后到的重放会被 revision 去重。
          hub.publishTo(message.ownerUserId, {
            type: 'message_updated',
            messageId: message.id,
            conversationId: message.conversationId,
            body: message.body,
            editedAt: message.editedAt.toISOString(),
            translatedBody: message.translatedBody,
          })
        }
      })
    })
  })()
})

adapters.onMessageIdRemapped((accountId, oldId, newId) => {
  void (async () => {
    const result = await messageRepo.remapMessageId(accountId, oldId, newId)
    if (result?.changed) {
      console.log(`[server] 消息 id 已换成最终值 ${oldId} -> ${newId}`)
    }
    if (result?.removedMessageId) {
      const owner = await db.selectFrom('accounts')
        .select('owner_user_id')
        .where('id', '=', accountId)
        .executeTakeFirst()
      if (owner) {
        hub.publishTo(owner.owner_user_id, {
          type: 'message_merged',
          conversationId: result.conversationId,
          removedMessageId: result.removedMessageId,
          canonicalMessageId: result.messageId,
        })
      }
    }
  })()
})

/**
 * 鉴权挑战只推给账号 owner 本人。
 *
 * 二维码等价于一次登录授权——扫了就是把这个 Telegram 账号接进本系统。
 * 广播给同组其他人等于把授权入口发给了所有人。
 */
adapters.onAuthChallenge((accountId, challenge) => {
  void (async () => {
    const owner = await db.selectFrom('accounts')
      .select('owner_user_id')
      .where('id', '=', accountId)
      .executeTakeFirst()
    if (!owner) return
    hub.publishTo(owner.owner_user_id, {
      type: 'auth_challenge',
      accountId,
      kind: challenge.kind,
      payload: challenge.payload,
    })
  })()
})

/**
 * 鉴权成功后把「本机有可用 session」这件事落库，重启时据此自动重连。
 *
 * 同时推一条 auth_done，客户端收到就把二维码弹窗关掉——不然扫完码界面
 * 还停在二维码上，员工不知道成没成功。
 */
adapters.onCredentialsUpdated((accountId, credentialsRef) => {
  void (async () => {
    const owner = await db.updateTable('accounts')
      .set({ credentials_ref: credentialsRef })
      .where('id', '=', accountId)
      .returning('owner_user_id')
      .executeTakeFirst()
    if (!owner) return
    hub.publishTo(owner.owner_user_id, { type: 'auth_done', accountId, ok: true, reason: null })
  })()
})

adapters.onStatusChange((accountId, status) => {
  void (async () => {
    await db.updateTable('accounts').set({ status }).where('id', '=', accountId).execute()
    const owner = await db
      .selectFrom('accounts')
      .select('owner_user_id')
      .where('id', '=', accountId)
      .executeTakeFirst()
    if (owner) hub.publishTo(owner.owner_user_id, { type: 'account_status', accountId, status })
  })()
})

// Worker 和 Fastify 共用一个进程，但各自独立跑：BullMQ Worker 内部是自己的轮询循环，
// 不占用 Fastify 的事件循环处理时段——一个翻译任务耗时再久，也不会挡住 HTTP 请求的响应。
new Worker<TranslateJobData>(TRANSLATE_QUEUE, async (job) => {
  await runTranslateJob(job.data, {
    loadMessage: async (id) => {
      const row = await db.selectFrom('messages')
        .select(['id', 'body', 'direction', 'conversation_id', 'edited_at'])
        .where('id', '=', id)
        .executeTakeFirst()
      return row
        ? {
            id: row.id,
            body: row.body,
            direction: row.direction,
            conversationId: row.conversation_id,
            revision: row.edited_at?.toISOString() ?? 'initial',
          }
        : null
    },
    // P0 只有全局默认引擎；会话/账号/团队级覆盖在 P2 随管理后台一起补
    loadEngineConfig: async () => ({ global: config.DEFAULT_TRANSLATION_PROVIDER }),
    hasTranslation: async (messageId, targetLang) => {
      const row = await db.selectFrom('message_translations')
        .select('message_id')
        .where('message_id', '=', messageId)
        .where('target_lang', '=', targetLang)
        .executeTakeFirst()
      return row !== undefined
    },
    gateway,
    saveTranslation: input => messageRepo.saveTranslationIfCurrent(input),
    publish: async (event) => {
      const owner = await db.selectFrom('messages')
        .innerJoin('accounts', 'accounts.id', 'messages.account_id')
        .select('accounts.owner_user_id')
        .where('messages.id', '=', event.messageId)
        .executeTakeFirst()
      if (owner) hub.publishTo(owner.owner_user_id, event)
    },
  })
}, { connection: redis })

const app = await buildServer({
  adapters,
  gateway,
  native: {
    ingestor,
    repo: messageRepo,
    publish: (userId, event) => hub.publishTo(userId, event),
  },
}, hub)
await app.listen({ port: config.PORT, host: '0.0.0.0' })

// TDLib 被强杀时可能来不及走完 authorizationStateClosed，本地 session 数据库
// 会留下未完整落盘的状态。退出前逐个断开，给它落盘的机会。
// adapters.disconnect 对从未 connect 过的账号是安全的空操作——AdapterManager
// 内部按 accountId 查连接映射表，查不到直接 return，不会抛错也不会误触发平台调用。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      console.log(`[server] 收到 ${signal}，正在断开所有账号…`)
      const connected = await db.selectFrom('accounts').select('id').where('status', '=', 'connected').execute()
      await Promise.allSettled(connected.map(a => adapters.disconnect(a.id)))
      await app.close()
      await redis.quit()
      await db.destroy()
      process.exit(0)
    })()
  })
}

/**
 * 启动后连接数据库里已登记的平台账号。
 *
 * 连接失败不能让进程退出——一个账号连不上不该拖垮整个服务端。
 */
async function connectRegisteredAccounts(): Promise<void> {
  const telegramReady = Boolean(config.TELEGRAM_API_ID) && Boolean(config.TELEGRAM_API_HASH)
  if (!telegramReady) {
    console.warn(
      '[server] TELEGRAM_API_ID / TELEGRAM_API_HASH 未配置，跳过 Telegram 账号连接。\n' +
        '         去 https://my.telegram.org 申请后填进 .env 即可启用。',
    )
  }

  const all = (await db
    .selectFrom('accounts')
    .select(['id', 'platform', 'display_name', 'credentials_ref', 'status'])
    .execute()
  ).filter((a) => a.platform !== 'telegram' || telegramReady)

  if (all.length === 0) {
    console.log('[server] 数据库里没有可连接的账号，先跑 pnpm --filter @im-hub/server seed')
    return
  }

  // 只自动连接「本机确实有可用 session」的账号，判据是 credentials_ref。
  //
  // 这一栏由适配器在 authorizationStateReady 时写入，所以它精确表示
  // 「这个账号在这台机器上鉴权成功过」。
  //
  // 不能用 TDLib 数据目录是否存在来判断：TDLib 在认证完成之前就会把 db 目录
  // 建好，没登录过的账号一样有这个目录（实测 348K vs 已登录的 7.2M）。
  // 也不该只看 status：员工在手机上解除了这台设备的授权后 status 仍是
  // connected，而那时 session 早就失效了。
  const accounts = all.filter((a) => a.credentials_ref !== null)

  const skipped = all.filter((a) => a.credentials_ref === null)
  if (skipped.length > 0) {
    console.log(
      `[server] 跳过 ${skipped.length} 个尚未关联的账号：${skipped.map((a) => a.display_name).join('、')}\n` +
        '         在客户端点「添加账号」扫码关联即可，不需要在这里操作。',
    )
  }

  if (accounts.length === 0) {
    console.log('[server] 没有已关联的账号，服务端已就绪但没有平台账号在线')
    return
  }

  // connect() 现在建完 client 就返回，鉴权全程异步，所以这里可以并发发起，
  // 也不会再出现「卡在第一个没登录过的账号上导致服务端起不来」。
  await Promise.all(accounts.map(async (account) => {
    try {
      console.log(`[server] 正在恢复「${account.display_name}」的已有会话…`)
      await adapters.connect(account.platform, {
        id: account.id,
        displayName: account.display_name,
        credentialsRef: account.credentials_ref,
      })
    } catch (err) {
      console.error(`[server] 「${account.display_name}」连接失败:`, err)
    }
  }))
}

void connectRegisteredAccounts()
