import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { KEYWORD_ALERT_SEVERITIES } from '@im-hub/shared'
import { z } from 'zod'
import {
  KeywordPatternError,
  normalizeKeywordPattern,
} from '../../keyword-alert/matcher.js'

const invalidRequest = { error: '关键词规则请求无效' } as const
const notFound = { error: '关键词规则不存在' } as const
const duplicate = { error: '关键词规则已存在' } as const

function validPattern(value: string): boolean {
  try {
    normalizeKeywordPattern(value)
    return true
  } catch (error) {
    if (error instanceof KeywordPatternError) return false
    throw error
  }
}

const pattern = z.string().refine(validPattern)
const revision = z.number().int().min(1)
const ruleParams = z.object({ id: z.string().uuid() }).strict()
const createBody = z.object({
  pattern,
  severity: z.enum(KEYWORD_ALERT_SEVERITIES),
  enabled: z.boolean(),
}).strict()
const updateBody = z.object({
  baseRevision: revision,
  pattern: pattern.optional(),
  severity: z.enum(KEYWORD_ALERT_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
}).strict().refine(value => (
  value.pattern !== undefined
    || value.severity !== undefined
    || value.enabled !== undefined
))
const removeBody = z.object({ baseRevision: revision }).strict()
const retryBody = z.object({}).strict()

function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.actor.role === 'owner') return true
  reply.code(403).send({ error: 'forbidden' })
  return false
}

function parsedBody(body: unknown): unknown {
  return body === undefined ? {} : body
}

function serverFailure(req: FastifyRequest, reply: FastifyReply) {
  req.log.error({ code: 'keyword_rule_operation_failed' }, '关键词规则操作失败')
  return reply.code(500).send({ error: '关键词规则操作失败，请稍后重试' })
}

export async function keywordRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/keyword-rules', async (req, reply) => {
    if (!requireOwner(req, reply)) return
    try {
      const result = await req.scoped.keywordRules().list()
      return { rules: result.rules, degradedScanCount: result.degradedScanCount }
    } catch {
      return serverFailure(req, reply)
    }
  })

  app.post('/api/keyword-rules', async (req, reply) => {
    if (!requireOwner(req, reply)) return
    const body = createBody.safeParse(parsedBody(req.body))
    if (!body.success) return reply.code(400).send(invalidRequest)

    try {
      const result = await req.scoped.keywordRules().create(req.actor.userId, body.data)
      if (result.kind === 'duplicate') return reply.code(409).send(duplicate)
      return reply.code(201).send(result.rule)
    } catch {
      return serverFailure(req, reply)
    }
  })

  app.patch('/api/keyword-rules/:id', async (req, reply) => {
    if (!requireOwner(req, reply)) return
    const params = ruleParams.safeParse(req.params)
    const body = updateBody.safeParse(parsedBody(req.body))
    if (!params.success || !body.success) return reply.code(400).send(invalidRequest)

    try {
      const result = await req.scoped.keywordRules().update(
        params.data.id,
        req.actor.userId,
        body.data,
      )
      switch (result.kind) {
        case 'updated':
          return reply.send(result.rule)
        case 'not_found':
          return reply.code(404).send(notFound)
        case 'conflict':
          return reply.code(409).send({
            error: '关键词规则已被更新',
            currentRevision: result.currentRevision,
          })
        case 'duplicate':
          return reply.code(409).send(duplicate)
      }
    } catch {
      return serverFailure(req, reply)
    }
  })

  app.delete('/api/keyword-rules/:id', async (req, reply) => {
    if (!requireOwner(req, reply)) return
    const params = ruleParams.safeParse(req.params)
    const body = removeBody.safeParse(parsedBody(req.body))
    if (!params.success || !body.success) return reply.code(400).send(invalidRequest)

    try {
      const result = await req.scoped.keywordRules().remove(
        params.data.id,
        req.actor.userId,
        body.data.baseRevision,
      )
      switch (result.kind) {
        case 'removed':
          return reply.send({ deleted: true })
        case 'not_found':
          return reply.code(404).send(notFound)
        case 'conflict':
          return reply.code(409).send({
            error: '关键词规则已被更新',
            currentRevision: result.currentRevision,
          })
      }
    } catch {
      return serverFailure(req, reply)
    }
  })

  app.post('/api/keyword-alert-scans/retry', async (req, reply) => {
    if (!requireOwner(req, reply)) return
    const body = retryBody.safeParse(parsedBody(req.body))
    if (!body.success) return reply.code(400).send(invalidRequest)

    try {
      const result = await req.scoped.keywordRules().retryDegraded(new Date())
      return { retried: result.retried }
    } catch {
      return serverFailure(req, reply)
    }
  })
}
