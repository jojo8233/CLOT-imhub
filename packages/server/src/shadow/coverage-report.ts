import { z } from 'zod'
import { db } from '../db/client.js'
import { KyselyTelegramShadowCoverageRepo } from './coverage.js'

const argsSchema = z.object({
  accountId: z.string().uuid(),
  sentAfter: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  sentBefore: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  conversationId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(2_048).optional(),
})

const USAGE = 'usage: pnpm --filter @im-hub/server shadow-coverage '
  + '<account-uuid> <sent-after-iso> <sent-before-iso> [limit] [conversation-uuid|-] [cursor]'

async function run(): Promise<void> {
  const parsed = argsSchema.safeParse({
    accountId: process.argv[2],
    sentAfter: process.argv[3],
    sentBefore: process.argv[4],
    limit: process.argv[5],
    conversationId: process.argv[6] && process.argv[6] !== '-' ? process.argv[6] : undefined,
    cursor: process.argv[7],
  })
  if (!parsed.success) throw new Error(USAGE)

  const account = await db.selectFrom('accounts')
    .select('id')
    .where('id', '=', parsed.data.accountId)
    .where('platform', '=', 'telegram')
    .executeTakeFirst()
  if (!account) throw new Error('Telegram account not found')

  if (parsed.data.conversationId) {
    const conversation = await db.selectFrom('conversations')
      .select('id')
      .where('id', '=', parsed.data.conversationId)
      .where('account_id', '=', account.id)
      .executeTakeFirst()
    if (!conversation) throw new Error('Telegram conversation not found for account')
  }

  const report = await new KyselyTelegramShadowCoverageRepo(db).scan({
    accountId: account.id,
    conversationId: parsed.data.conversationId,
    sentAfter: parsed.data.sentAfter,
    sentBefore: parsed.data.sentBefore,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

try {
  await run()
} finally {
  await db.destroy()
}
