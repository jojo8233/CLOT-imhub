/**
 * 把一个平台账号退回未登录状态，用于换绑另一个号。
 *
 * 会清掉三处，缺一处都会导致换号失败或残留：
 *   1. 该账号下的会话与消息（译文随外键级联删除）
 *   2. accounts.status 改回 pending_auth，否则启动时会自动重连旧 session
 *   3. 磁盘上的 TDLib session 目录，否则它会用旧凭据直接登回原来的号
 *
 * 用法（服务端必须先停掉，否则它正握着 session 文件）：
 *   set -a && . ./.env && set +a
 *   pnpm --filter @im-hub/server reset-account "TG 组内号"
 */
import { rmSync } from 'node:fs'
import * as path from 'node:path'
import { config } from '../config.js'
import { db } from './client.js'

const needle = process.argv[2]?.trim()
if (!needle) {
  console.error('用法：pnpm --filter @im-hub/server reset-account "<账号名片段或 id>"')
  process.exit(1)
}

const accounts = await db
  .selectFrom('accounts')
  .select(['id', 'display_name', 'platform', 'status'])
  .execute()

const matched = accounts.filter((a) => a.id === needle || a.display_name.includes(needle))

if (matched.length === 0) {
  console.error(`没有匹配「${needle}」的账号。现有账号：`)
  for (const a of accounts) console.error(`  ${a.display_name}  (${a.platform}, ${a.status})`)
  process.exit(1)
}
if (matched.length > 1) {
  console.error(`「${needle}」匹配到多个账号，请写得更具体：`)
  for (const a of matched) console.error(`  ${a.display_name}  ${a.id}`)
  process.exit(1)
}

const account = matched[0]!

const { n: convCount } = await db
  .selectFrom('conversations')
  .select(db.fn.countAll<string>().as('n'))
  .where('account_id', '=', account.id)
  .executeTakeFirstOrThrow()

const { n: msgCount } = await db
  .selectFrom('messages')
  .select(db.fn.countAll<string>().as('n'))
  .where('account_id', '=', account.id)
  .executeTakeFirstOrThrow()

console.log(`即将重置「${account.display_name}」(${account.platform})`)
console.log(`  将删除 ${convCount} 个会话、${msgCount} 条消息及其译文`)

// messages 与 message_translations 由外键级联，删会话即可带走
await db.deleteFrom('messages').where('account_id', '=', account.id).execute()
await db.deleteFrom('conversations').where('account_id', '=', account.id).execute()
await db.updateTable('accounts').set({ status: 'pending_auth' }).where('id', '=', account.id).execute()

const sessionDir = path.join(config.TDLIB_DATA_DIR, account.id)
rmSync(sessionDir, { recursive: true, force: true })

console.log(`  已清空数据库记录`)
console.log(`  已删除 session 目录 ${sessionDir}`)
console.log(`  状态已改回 pending_auth`)
console.log('')
console.log('接下来用新号登录：')
console.log(`  IM_HUB_LOGIN_ACCOUNT="${account.display_name}" pnpm --filter @im-hub/server exec tsx src/index.ts`)
console.log('')
console.log('别忘了去旧号手机上解除这台设备的授权：')
console.log('  Telegram → 设置 → 隐私与安全 → 已登录设备 → 找到本机会话 → 终止')

await db.destroy()
