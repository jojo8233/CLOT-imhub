import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  DESKTOP_INSTALLATION_CAPABILITIES,
  type DesktopInstallationCapability,
} from '@im-hub/shared'
import { z } from 'zod'
import {
  DeviceService,
  DeviceServiceError,
  type DeviceIdentity,
} from '../../organization-admin/device-service.js'

const headersSchema = z.object({
  'x-im-hub-installation-id': z.string().uuid(),
  'x-im-hub-device-credential': z.string().min(32).max(256),
})
const registrationBody = z.object({
  clientVersion: z.string().min(1).max(64),
  capabilities: z.array(z.enum(DESKTOP_INSTALLATION_CAPABILITIES)).max(16),
}).strict()
const syncBody = z.object({
  accountIds: z.array(z.string().uuid()).max(500),
}).strict()
const emptyBody = z.object({}).strict()
const taskParams = z.object({ id: z.string().uuid() }).strict()

export interface DesktopInstallationRouteDeps {
  deviceService: DeviceService
}

export async function desktopInstallationRoutes(
  app: FastifyInstance,
  deps: DesktopInstallationRouteDeps,
): Promise<void> {
  app.post('/api/desktop/installations/register', async (req, reply) => {
    const identity = parseIdentity(req)
    const body = registrationBody.safeParse(req.body)
    if (!identity || !body.success) return invalidRequest(reply)
    try {
      return await deps.deviceService.register(req.actor, {
        ...identity,
        clientVersion: body.data.clientVersion,
        capabilities: body.data.capabilities as DesktopInstallationCapability[],
      })
    } catch (error) {
      return sendDeviceError(reply, error)
    }
  })

  app.post('/api/desktop/installations/heartbeat', async (req, reply) => {
    const identity = parseIdentity(req)
    const body = registrationBody.safeParse(req.body)
    if (!identity || !body.success) return invalidRequest(reply)
    try {
      return await deps.deviceService.heartbeat(req.actor, {
        ...identity,
        clientVersion: body.data.clientVersion,
        capabilities: body.data.capabilities as DesktopInstallationCapability[],
      })
    } catch (error) {
      return sendDeviceError(reply, error)
    }
  })

  app.post('/api/desktop/installations/sync-mounts', async (req, reply) => {
    const identity = parseIdentity(req)
    const body = syncBody.safeParse(req.body)
    if (!identity || !body.success) return invalidRequest(reply)
    try {
      return await deps.deviceService.syncMounts(req.actor, {
        ...identity,
        accountIds: body.data.accountIds,
      })
    } catch (error) {
      return sendDeviceError(reply, error)
    }
  })

  app.post('/api/desktop/cleanup-tasks/claim', async (req, reply) => {
    const identity = parseIdentity(req)
    const body = emptyBody.safeParse(req.body ?? {})
    if (!identity || !body.success) return invalidRequest(reply)
    try {
      return await deps.deviceService.claimAutomaticTasks(req.actor, identity)
    } catch (error) {
      return sendDeviceError(reply, error)
    }
  })

  app.post('/api/desktop/cleanup-tasks/:id/complete', async (req, reply) => {
    const identity = parseIdentity(req)
    const params = taskParams.safeParse(req.params)
    const body = emptyBody.safeParse(req.body ?? {})
    if (!identity || !params.success || !body.success) return invalidRequest(reply)
    try {
      return await deps.deviceService.completeAutomaticTask(req.actor, {
        ...identity,
        taskId: params.data.id,
      })
    } catch (error) {
      return sendDeviceError(reply, error)
    }
  })
}

function parseIdentity(req: FastifyRequest): DeviceIdentity | null {
  const parsed = headersSchema.safeParse(req.headers)
  if (!parsed.success) return null
  return {
    installationId: parsed.data['x-im-hub-installation-id'],
    credential: parsed.data['x-im-hub-device-credential'],
  }
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({ error: 'invalid device request' })
}

function sendDeviceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof DeviceServiceError)) throw error
  if (error.code === 'DEVICE_CREDENTIAL_INVALID') {
    return reply.code(401).send({ error: 'device credential invalid', code: error.code })
  }
  if (error.code === 'ACCOUNT_NOT_OWNED' || error.code === 'OWNER_REQUIRED') {
    return reply.code(403).send({ error: 'forbidden' })
  }
  if (error.code === 'TASK_NOT_FOUND') {
    return reply.code(404).send({ error: 'cleanup task not found' })
  }
  if (error.code === 'DEVICE_CLEANUP_PENDING') {
    return reply.code(409).send({ error: 'device cleanup pending', code: error.code })
  }
  if (error.code === 'TASK_INVALID_STATE') {
    return reply.code(409).send({ error: 'cleanup task state invalid' })
  }
  const exhaustive: never = error.code
  throw new Error(`unhandled device service error: ${exhaustive}`)
}
