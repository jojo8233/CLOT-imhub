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

adapters.onMessage((msg) => {
  void (async () => {
    const messageId = await ingestor.ingest(msg)
    if (!messageId) return

    // 推给该账号的归属人。不推的话新消息和新会话都不会实时出现，
    // 员工得手动刷新才看得到——那就不是聊天软件了。
    const row = await db
      .selectFrom('messages')
      .innerJoin('accounts', 'accounts.id', 'messages.account_id')
      .select([
        'messages.id as id',
        'messages.conversation_id as conversation_id',
        'messages.account_id as account_id',
        'messages.platform as platform',
        'messages.direction as direction',
        'messages.body as body',
        'messages.sent_at as sent_at',
        'accounts.owner_user_id as owner_user_id',
      ])
      .where('messages.id', '=', messageId)
      .executeTakeFirst()

    if (!row) return
    hub.publishTo(row.owner_user_id, {
      type: 'message',
      messageId: row.id,
      conversationId: row.conversation_id,
      accountId: row.account_id,
      platform: row.platform,
      direction: row.direction,
      body: row.body,
      // 译文此刻还没产出，随后由 translation 事件补上
      translatedBody: null,
      sentAt: row.sent_at.toISOString(),
    })
  })()
})

adapters.onMessageIdRemapped((accountId, oldId, newId) => {
  void (async () => {
    const r = await db
      .updateTable('messages')
      .set({ platform_message_id: newId })
      .where('account_id', '=', accountId)
      .where('platform_message_id', '=', oldId)
      .executeTakeFirst()
    if ((r.numUpdatedRows ?? 0n) > 0n) {
      console.log(`[server] 消息 id 已换成最终值 ${oldId} -> ${newId}`)
    }
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

/**
 * 启动后连接数据库里已登记的平台账号。
 *
 * 不 await：TelegramAdapter 的 login() 会阻塞在 stdin 等手机号和验证码，
 * awaiting 会让 HTTP 端口一直起不来。连接失败也不能让进程退出——
 * 一个账号连不上不该拖垮整个服务端。
 */
async function connectRegisteredAccounts(): Promise<void> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
    console.warn(
      '[server] TELEGRAM_API_ID / TELEGRAM_API_HASH 未配置，跳过 Telegram 账号连接。\n' +
        '         去 https://my.telegram.org 申请后填进 .env 即可启用。',
    )
    return
  }

  const all = await db
    .selectFrom('accounts')
    .select(['id', 'platform', 'display_name', 'credentials_ref', 'status'])
    .where('platform', '=', 'telegram')
    .execute()

  if (all.length === 0) {
    console.log('[server] 数据库里没有 Telegram 账号，先跑 pnpm --filter @im-hub/server seed')
    return
  }

  // 只自动连接「上次成功连上过」的账号，判据是数据库里持久化的 status。
  //
  // 不能用「TDLib 数据目录是否存在」来判断：TDLib 在认证完成之前就会把 db 目录
  // 建好，没登录过的账号一样有这个目录（实测 348K vs 已登录的 7.2M），
  // 按目录判断会误认为已登录，重启时照样卡在 stdin 上。
  //
  // 没登录过的账号调 login() 会永久阻塞在 stdin 等手机号——无脑遍历全部账号
  // 会让服务端一旦重启就再也起不来（卡在第一个没登录过的账号上），
  // 而且日志里只有一行「正在连接…」，看不出为什么不动。
  // 首次登录必须显式指定：IM_HUB_LOGIN_ACCOUNT=<账号id 或 名称片段>
  const wanted = process.env.IM_HUB_LOGIN_ACCOUNT?.trim()

  const accounts = all.filter((a) => {
    // 注意：如果员工在手机上主动解除了这台设备的授权，status 仍是 connected，
    // 重连时会退回登录流程并再次阻塞。那种情况需要人工介入，把它改回 pending_auth。
    if (a.status === 'connected') return true
    if (!wanted) return false
    return a.id === wanted || a.display_name.includes(wanted)
  })

  const skipped = all.filter((a) => !accounts.includes(a))
  if (skipped.length > 0) {
    console.log(
      `[server] 跳过 ${skipped.length} 个尚未登录的账号：${skipped.map((a) => a.display_name).join('、')}\n` +
        `         首次登录请指定：IM_HUB_LOGIN_ACCOUNT="${skipped[0]!.display_name}" pnpm --filter @im-hub/server exec tsx src/index.ts`,
    )
  }

  if (accounts.length === 0) {
    console.log('[server] 没有可自动连接的账号，服务端已就绪但没有平台账号在线')
    return
  }

  for (const account of accounts) {
    try {
      console.log(
        account.status !== 'connected'
          ? `[server] 正在首次登录「${account.display_name}」，按提示输入手机号与验证码…`
          : `[server] 正在恢复「${account.display_name}」的已有会话…`,
      )
      await adapters.connect(account.platform, {
        id: account.id,
        displayName: account.display_name,
        credentialsRef: account.credentials_ref,
      })
      console.log(`[server] 「${account.display_name}」已连接`)
    } catch (err) {
      console.error(`[server] 「${account.display_name}」连接失败:`, err)
    }
  }
}

void connectRegisteredAccounts()
