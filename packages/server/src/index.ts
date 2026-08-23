import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { config } from './config.js'
import { db } from './db/client.js'
import { AdapterManager } from './adapters/manager.js'
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
])

const hub = new WsHub()
const queue = new BullTranslateQueue(redis)
const ingestor = new MessageIngestor(new KyselyMessageRepo(db), queue)

adapters.onMessage((msg) => { void ingestor.ingest(msg) })
adapters.onStatusChange((accountId, status) => {
  void db.updateTable('accounts').set({ status }).where('id', '=', accountId).execute()
})

// Worker 和 Fastify 共用一个进程，但各自独立跑：BullMQ Worker 内部是自己的轮询循环，
// 不占用 Fastify 的事件循环处理时段——一个翻译任务耗时再久，也不会挡住 HTTP 请求的响应。
new Worker<TranslateJobData>(TRANSLATE_QUEUE, async (job) => {
  await runTranslateJob(job.data, {
    loadMessage: async (id) => {
      const row = await db.selectFrom('messages')
        .select(['id', 'body', 'direction', 'conversation_id'])
        .where('id', '=', id)
        .executeTakeFirst()
      return row
        ? { id: row.id, body: row.body, direction: row.direction, conversationId: row.conversation_id }
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
    saveTranslation: async (input) => {
      await db.insertInto('message_translations').values({
        message_id: input.messageId,
        target_lang: input.targetLang,
        provider: input.provider,
        translated_text: input.translatedText,
      }).onConflict(oc => oc.columns(['message_id', 'target_lang']).doUpdateSet({
        translated_text: input.translatedText,
        provider: input.provider,
      })).execute()
    },
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

const app = await buildServer({ adapters, gateway }, hub)
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
