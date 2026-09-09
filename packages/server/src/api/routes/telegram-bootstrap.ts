import type { FastifyInstance } from 'fastify'
import type { TelegramBootstrapResponse } from '@im-hub/shared'
import { z } from 'zod'

export interface TelegramBootstrapConfig {
  readonly apiId: number
  readonly apiHash: string
}

const idParam = z.object({ id: z.string().uuid() })
const emptyObject = z.object({}).strict()

const invalidRequest = { error: 'invalid telegram bootstrap request' } as const
const forbidden = { error: 'telegram bootstrap forbidden' } as const
const accountUnavailable = { error: 'telegram account unavailable' } as const
const unsupported = { error: 'telegram bootstrap unsupported' } as const
const bootstrapUnavailable = { error: 'telegram bootstrap unavailable' } as const

function isValidConfig(value: TelegramBootstrapConfig): boolean {
  return Number.isSafeInteger(value.apiId)
    && value.apiId > 0
    && value.apiId <= 2_147_483_647
    && /^[0-9a-fA-F]{32}$/.test(value.apiHash)
}

function isContentTypeParserError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('FST_ERR_CTP_')
}

export async function telegramBootstrapRoutes(
  app: FastifyInstance,
  telegramBootstrap: Readonly<TelegramBootstrapConfig>,
): Promise<void> {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('Pragma', 'no-cache')
    reply.header('X-Content-Type-Options', 'nosniff')
    return payload
  })
  app.setErrorHandler((error, _req, reply) => {
    if (isContentTypeParserError(error)) {
      return reply.code(400).send(invalidRequest)
    }
    return reply.code(503).send(bootstrapUnavailable)
  })

  app.post('/api/accounts/:id/telegram-bootstrap', {
    // Fastify 默认会把完整 req.url 写进 incoming-request 日志。该路由必须拒绝
    // query，同时也不能在拒绝前把调用方夹带的敏感值写进日志。
    logLevel: 'silent',
  }, async (req, reply) => {
    const params = idParam.safeParse(req.params)
    const query = emptyObject.safeParse(req.query)
    const body = emptyObject.optional().safeParse(req.body)
    if (!params.success || !query.success || !body.success) {
      return reply.code(400).send(invalidRequest)
    }
    if (req.actor.role === 'auditor') {
      return reply.code(403).send(forbidden)
    }

    try {
      const account = await req.scoped.accounts()
        .select(['accounts.id', 'accounts.platform', 'accounts.connection_mode'])
        .where('accounts.id', '=', params.data.id)
        .where('accounts.owner_user_id', '=', req.actor.userId)
        .executeTakeFirst()
      if (!account) return reply.code(404).send(accountUnavailable)
      if (account.platform !== 'telegram' || account.connection_mode !== 'adapter') {
        return reply.code(409).send(unsupported)
      }
      if (!isValidConfig(telegramBootstrap)) {
        return reply.code(503).send(bootstrapUnavailable)
      }

      const response: TelegramBootstrapResponse = {
        apiId: telegramBootstrap.apiId,
        apiHash: telegramBootstrap.apiHash,
      }
      return reply.send(response)
    } catch {
      return reply.code(503).send(bootstrapUnavailable)
    }
  })
}
