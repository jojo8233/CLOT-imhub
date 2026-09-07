import type { FastifyInstance } from 'fastify'

export interface HealthChecks {
  database(): Promise<void>
  redis(): Promise<void>
  initialized(): boolean
}

export async function healthRoutes(
  app: FastifyInstance,
  checks: HealthChecks,
): Promise<void> {
  app.get('/health/live', async () => ({ status: 'live' }))

  app.get('/health/ready', async (_req, reply) => {
    try {
      if (!checks.initialized()) throw new Error('application not initialized')
      await Promise.all([checks.database(), checks.redis()])
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
  })
}
