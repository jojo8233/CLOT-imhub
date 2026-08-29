import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  TelegramShadowCoverageInputError,
  type KyselyTelegramShadowCoverageRepo,
  type TelegramShadowCoverageReport,
} from '../../shadow/coverage.js'
import type {
  TelegramShadowRefresher,
  TelegramShadowRefreshResult,
} from '../../shadow/refresh.js'

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({
  mode: z.enum(['dry_run', 'refresh_tdlib']).default('dry_run'),
  sentAfter: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  sentBefore: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(10).default(10),
  cursor: z.string().min(1).max(2_048).optional(),
  confirm: z.string().optional(),
})

export interface TelegramShadowRefreshRouteDeps {
  coverage: Pick<KyselyTelegramShadowCoverageRepo, 'scan'>
  refresher: Pick<TelegramShadowRefresher, 'refreshTdlib'>
}

export async function telegramShadowRefreshRoutes(
  app: FastifyInstance,
  deps: TelegramShadowRefreshRouteDeps,
): Promise<void> {
  app.post('/api/accounts/:id/telegram-shadow-refresh', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params)
    const body = bodySchema.safeParse(req.body)
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid bounded shadow refresh request' })
    }

    const account = await req.scoped.accounts()
      .select(['id', 'platform', 'status', 'owner_user_id'])
      .where('accounts.id', '=', params.data.id)
      .executeTakeFirst()
    // 平台主动读取只允许账号 owner；manager 可见不等于能操作下属的平台会话。
    if (!account || account.owner_user_id !== req.actor.userId) {
      return reply.code(404).send({ error: 'account not found or not owned by actor' })
    }
    if (account.platform !== 'telegram') {
      return reply.code(400).send({ error: 'shadow refresh only supports Telegram accounts' })
    }

    if (body.data.conversationId) {
      const conversation = await req.scoped.accountsJoinedWithConversations()
        .select('conversations.id')
        .where('accounts.id', '=', account.id)
        .where('conversations.id', '=', body.data.conversationId)
        .executeTakeFirst()
      if (!conversation) {
        return reply.code(404).send({ error: 'conversation not found for account' })
      }
    }

    const scanInput = {
      accountId: account.id,
      conversationId: body.data.conversationId,
      sentAfter: body.data.sentAfter,
      sentBefore: body.data.sentBefore,
      limit: body.data.limit,
      cursor: body.data.cursor,
      sampleLimit: 20,
    }
    let before: TelegramShadowCoverageReport
    try {
      before = await deps.coverage.scan(scanInput)
    } catch (err) {
      if (err instanceof TelegramShadowCoverageInputError) {
        return reply.code(400).send({ error: 'invalid coverage window or cursor' })
      }
      throw err
    }
    if (body.data.mode === 'dry_run') return { mode: 'dry_run', coverage: before }

    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: 'auditor is read-only' })
    }
    if (body.data.confirm !== 'REFRESH_TDLIB_SHADOW') {
      return reply.code(400).send({ error: 'explicit TDLib shadow refresh confirmation required' })
    }
    if (account.status !== 'connected') {
      return reply.code(409).send({ error: 'Telegram account is not connected' })
    }

    const candidates = before.actions.tdlibRefreshCandidates
    let refresh: TelegramShadowRefreshResult = {
      requested: 0,
      found: 0,
      recorded: 0,
      unavailable: 0,
      unsupported: 0,
      failed: 0,
    }
    if (candidates.length > 0) {
      try {
        refresh = await deps.refresher.refreshTdlib(account.id, candidates)
      } catch (err) {
        req.log.warn({ err, accountId: account.id }, 'bounded TDLib shadow refresh could not start')
        return reply.code(409).send({ error: 'TDLib shadow refresh is unavailable' })
      }
    }

    const after = await deps.coverage.scan(scanInput)
    return { mode: 'refresh_tdlib', before, refresh, after }
  })
}
