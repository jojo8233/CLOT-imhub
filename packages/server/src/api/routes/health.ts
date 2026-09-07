import type { FastifyInstance } from 'fastify'

export interface HealthChecks {
  timeoutMs?: number
  database(): Promise<void>
  redis(): Promise<void>
  initialized(): boolean
}

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3500

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('health check deadline exceeded')), timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function healthRoutes(
  app: FastifyInstance,
  checks: HealthChecks,
): Promise<void> {
  app.get('/health/live', async () => ({ status: 'live' }))

  app.get('/health/ready', async (_req, reply) => {
    try {
      if (!checks.initialized()) throw new Error('application not initialized')
      await withinDeadline(
        Promise.all([checks.database(), checks.redis()]),
        checks.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      )
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
  })
}
