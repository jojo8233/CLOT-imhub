/**
 * 起飞前体检：把「能不能跑通真实链路」拆成一条条可判定的检查，
 * 一次告诉你全部缺什么，而不是让你对着一个 zod 报错逐个试。
 *
 * 用法：set -a && . ./.env && set +a && pnpm --filter @im-hub/server preflight
 */
import Redis from 'ioredis'
import { config } from '../config.js'
import { db } from './client.js'

type Result = { ok: boolean; label: string; detail: string }

const results: Result[] = []
function check(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail })
}

// --- 依赖服务 ---
try {
  const r = await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()
  check(true, 'PostgreSQL', `已连接，users 表有 ${String(r.n)} 行`)
} catch (err) {
  check(false, 'PostgreSQL', `连不上：${err instanceof Error ? err.message : String(err)}`)
}

const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true })
try {
  await redis.connect()
  check(true, 'Redis', `已连接（${await redis.ping()}）`)
} catch (err) {
  check(false, 'Redis', `连不上：${err instanceof Error ? err.message : String(err)}`)
} finally {
  redis.disconnect()
}

// --- migration 是否跑过 ---
try {
  const migrated = await db
    .selectFrom('kysely_migration' as never)
    .select('name' as never)
    .execute()
  check(migrated.length > 0, 'Migration', migrated.length > 0 ? `已应用 ${migrated.length} 个` : '一个都没跑，执行 pnpm db:migrate')
} catch {
  check(false, 'Migration', '没跑过，执行 pnpm db:migrate')
}

// --- seed 数据 ---
try {
  const accounts = await db.selectFrom('accounts').select(['display_name', 'platform']).execute()
  check(
    accounts.length > 0,
    'Seed 数据',
    accounts.length > 0
      ? `${accounts.length} 个账号：${accounts.map((a) => a.display_name).join('、')}`
      : '没有账号，执行 pnpm --filter @im-hub/server seed',
  )
} catch {
  check(false, 'Seed 数据', '查不到，先跑 migration 再跑 seed')
}

// --- Telegram 凭据 ---
const hasTg = Boolean(config.TELEGRAM_API_ID) && Boolean(config.TELEGRAM_API_HASH)
check(
  hasTg,
  'Telegram 凭据',
  hasTg
    ? `api_id = ${config.TELEGRAM_API_ID}`
    : '未配置。去 https://my.telegram.org → API development tools 申请，填进 .env 的 TELEGRAM_API_ID / TELEGRAM_API_HASH',
)

// --- 翻译引擎 ---
const keys: Record<string, string> = {
  deepl: config.DEEPL_API_KEY,
  openai: config.OPENAI_API_KEY,
  claude: config.ANTHROPIC_API_KEY,
}
const filled = Object.entries(keys).filter(([, v]) => v !== '').map(([k]) => k)
check(
  filled.length > 0,
  '翻译引擎 key',
  filled.length > 0 ? `已配置：${filled.join('、')}` : '一个都没配，DeepL 有免费额度最省事',
)

const preferred = config.DEFAULT_TRANSLATION_PROVIDER
check(
  filled.includes(preferred),
  '默认引擎指向',
  filled.includes(preferred)
    ? `DEFAULT_TRANSLATION_PROVIDER = ${preferred}，且该引擎已配 key`
    : `DEFAULT_TRANSLATION_PROVIDER = ${preferred}，但这个引擎没配 key。` +
      (filled.length > 0 ? `改成 ${filled[0]}，或补上 ${preferred} 的 key` : ''),
)

// --- 输出 ---
console.log('')
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.label.padEnd(16)} ${r.detail}`)
}

const failed = results.filter((r) => !r.ok)
console.log('')
if (failed.length === 0) {
  console.log('全部就绪。启动服务端：pnpm dev:server')
} else {
  console.log(`还有 ${failed.length} 项未就绪，按上面的提示处理后重跑本脚本。`)
}

await db.destroy()
process.exit(failed.length === 0 ? 0 : 1)
