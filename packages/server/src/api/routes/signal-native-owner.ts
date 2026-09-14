import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { normalizeSignalAci, type SignalNativeExistingAccountResponse } from '@im-hub/shared'

const resolveBody = z.object({
  platformAccountExternalId: z.string().min(1).max(512),
}).strict()

/** Resolve existing ownership only; an unbound account must never claim a profile here. */
export async function signalNativeOwnerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/accounts/signal-native/resolve-existing', {
    onSend: async (_req, reply, payload) => {
      reply.header('Cache-Control', 'no-store')
      return payload
    },
  }, async (req, reply) => {
    if (req.actor.role === 'auditor') return reply.code(403).send({ error: '账号身份解析不可用' })
    const body = resolveBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: '平台身份参数无效' })
    let identity: string
    try {
      identity = normalizeSignalAci(body.data.platformAccountExternalId)
    } catch {
      return reply.code(400).send({ error: '平台身份参数无效' })
    }

    const matches = await req.scoped.accounts().select('id')
      .where('owner_user_id', '=', req.actor.userId)
      .where('platform', '=', 'signal')
      .where('connection_mode', '=', 'native_desktop')
      .where('platform_account_external_id', '=', identity)
      .limit(2).execute()
    const [account] = matches
    if (!account) return reply.code(404).send({ error: '未找到已绑定账号' })
    if (matches.length !== 1) return reply.code(409).send({ error: '已绑定账号身份不唯一' })
    return { accountId: account.id } satisfies SignalNativeExistingAccountResponse
  })
}
