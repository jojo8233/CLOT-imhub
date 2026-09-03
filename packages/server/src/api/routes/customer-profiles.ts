import type { FastifyInstance } from 'fastify'
import {
  CUSTOMER_PROFILE_SEARCH_MAX_LIMIT,
  PLATFORMS,
  customerProfileCodePointLength,
} from '@im-hub/shared'
import { z } from 'zod'
import { CustomerProfileCursorError } from '../../customer-profile/library-query.js'

const searchBody = z.object({
  q: z.string()
    .transform(value => value.trim())
    .refine(value => customerProfileCodePointLength(value) <= 100)
    .optional(),
  platform: z.enum(PLATFORMS).optional(),
  accountId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(CUSTOMER_PROFILE_SEARCH_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict()

export async function customerProfileLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/customer-profiles/search', async (req, reply) => {
    const parsed = searchBody.safeParse(req.body === undefined ? {} : req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: '客户档案库查询无效' })
    }

    try {
      return await req.scoped.customerProfiles().list(parsed.data)
    } catch (error) {
      if (error instanceof CustomerProfileCursorError) {
        return reply.code(400).send({ error: '客户档案库查询无效' })
      }
      req.log.error(
        { err: error, code: 'customer_profile_library_failed' },
        '客户档案库查询失败',
      )
      return reply.code(500).send({ error: '客户档案库加载失败，请稍后重试' })
    }
  })
}
