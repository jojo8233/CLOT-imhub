import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  KEYWORD_ALERT_PAGE_MAX_LIMIT,
  KEYWORD_ALERT_SEVERITIES,
  PLATFORMS,
} from '@im-hub/shared'
import { z } from 'zod'
import { KeywordAlertCursorError } from '../../keyword-alert/query.js'

const invalidRequest = { error: '关键词告警请求无效' } as const
const notFound = { error: '关键词告警不存在' } as const
const statusFilters = ['pending', 'acknowledged', 'all'] as const

const searchBody = z.object({
  status: z.enum(statusFilters),
  severity: z.enum(KEYWORD_ALERT_SEVERITIES).optional(),
  platform: z.enum(PLATFORMS).optional(),
  accountId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(KEYWORD_ALERT_PAGE_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
}).strict()
const alertParams = z.object({ id: z.string().uuid() }).strict()
const acknowledgeBody = z.object({}).strict()

function parsedBody(body: unknown): unknown {
  return body === undefined ? {} : body
}

function serverFailure(app: FastifyInstance, reply: FastifyReply) {
  app.log.error({ code: 'keyword_alert_operation_failed' }, '关键词告警操作失败')
  return reply.code(500).send({ error: '关键词告警操作失败，请稍后重试' })
}

export async function keywordAlertRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/keyword-alerts/search', async (req, reply) => {
    const body = searchBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send(invalidRequest)
    if (req.actor.role === 'auditor' && body.data.status !== 'all') {
      return reply.code(400).send(invalidRequest)
    }

    try {
      return await req.scoped.keywordAlerts().list(body.data)
    } catch (error) {
      if (error instanceof KeywordAlertCursorError) {
        return reply.code(400).send(invalidRequest)
      }
      return serverFailure(app, reply)
    }
  })

  app.get('/api/keyword-alerts/unacknowledged-count', async (req, reply) => {
    try {
      return { count: await req.scoped.keywordAlerts().unacknowledgedCount() }
    } catch {
      return serverFailure(app, reply)
    }
  })

  app.patch('/api/keyword-alerts/:id/acknowledge', { logLevel: 'silent' }, async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const params = alertParams.safeParse(req.params)
    const body = acknowledgeBody.safeParse(parsedBody(req.body))
    if (!params.success || !body.success) return reply.code(400).send(invalidRequest)

    try {
      const result = await req.scoped.keywordAlerts().acknowledge(params.data.id, new Date())
      if (result === null) return reply.code(404).send(notFound)
      return result
    } catch {
      return serverFailure(app, reply)
    }
  })
}
