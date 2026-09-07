import {
  TRANSLATION_PROVIDERS,
  type TranslationPreference,
  type TranslationProviderName,
} from '@im-hub/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const updateBody = z.object({
  provider: z.enum(TRANSLATION_PROVIDERS),
}).strict()

export interface TranslationPreferenceRouteService {
  get(userId: string): Promise<TranslationPreference>
  set(userId: string, provider: TranslationProviderName): Promise<TranslationPreference>
}

export interface TranslationPreferenceRouteDeps {
  service: TranslationPreferenceRouteService
}

export async function translationPreferenceRoutes(
  app: FastifyInstance,
  deps: TranslationPreferenceRouteDeps,
): Promise<void> {
  app.get('/api/translation/providers', async req => deps.service.get(req.actor.userId))

  app.patch('/api/session/translation-provider', async (req, reply) => {
    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })
    return deps.service.set(req.actor.userId, parsed.data.provider)
  })
}
