import { z } from 'zod'
import { db } from '../db/client.js'
import { KyselyTelegramShadowRepo } from './telegram-repo.js'

const HOUR_MS = 60 * 60 * 1_000
const SECOND_MS = 1_000
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_GRACE_SECONDS = 120

const argsSchema = z.object({
  accountId: z.string().uuid(),
  windowHours: z.coerce.number().positive().max(24 * 31).default(DEFAULT_WINDOW_HOURS),
  graceSeconds: z.coerce.number().nonnegative().max(60 * 60).default(DEFAULT_GRACE_SECONDS),
})

async function run(): Promise<void> {
  const parsed = argsSchema.safeParse({
    accountId: process.argv[2],
    windowHours: process.argv[3],
    graceSeconds: process.argv[4],
  })
  if (!parsed.success) {
    throw new Error('usage: pnpm --filter @im-hub/server shadow-report <account-uuid> [hours] [grace-seconds]')
  }

  const account = await db.selectFrom('accounts')
    .select('id')
    .where('id', '=', parsed.data.accountId)
    .where('platform', '=', 'telegram')
    .executeTakeFirst()
  if (!account) throw new Error('Telegram account not found')

  const now = new Date()
  const settledBefore = new Date(now.getTime() - parsed.data.graceSeconds * SECOND_MS)
  const observedAfter = new Date(settledBefore.getTime() - parsed.data.windowHours * HOUR_MS)
  const report = await new KyselyTelegramShadowRepo(db).summarize({
    accountId: account.id,
    observedAfter,
    settledBefore,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

try {
  await run()
} finally {
  await db.destroy()
}
