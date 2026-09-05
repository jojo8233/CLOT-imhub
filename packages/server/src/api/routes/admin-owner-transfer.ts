import type { FastifyInstance, FastifyReply } from 'fastify'
import { ADMIN_EDITABLE_ROLES, type Actor } from '@im-hub/shared'
import { z } from 'zod'
import { AdminAccessError, assertAdminWrite } from '../../organization-admin/admin-guard.js'
import {
  OwnerTransferService,
  OwnerTransferServiceError,
  type OwnerTransferResult,
} from '../../organization-admin/owner-transfer-service.js'
import { publishOrganizationEffects } from '../organization-effects.js'
import type { WsHub } from '../ws.js'

const revision = z.number().int().positive()
const teamResolution = z.discriminatedUnion('action', [
  z.object({
    teamId: z.string().uuid(), action: z.literal('replace_manager'),
    replacementManagerUserId: z.string().uuid(), baseRevision: revision,
  }).strict(),
  z.object({
    teamId: z.string().uuid(), action: z.literal('archive'), baseRevision: revision,
  }).strict(),
])
const accountResolution = z.object({
  accountId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  teamId: z.string().uuid().nullable(),
  baseRevision: revision,
}).strict()
const previewBody = z.object({
  targetUserId: z.string().uuid(),
  currentOwnerNextRole: z.enum(ADMIN_EDITABLE_ROLES),
  currentOwnerTeamIds: z.array(z.string().uuid()).max(100),
  teamResolutions: z.array(teamResolution).max(100),
  accountResolutions: z.array(accountResolution).max(10_000),
  currentOwnerBaseRevision: revision,
  targetUserBaseRevision: revision,
  allowManualCleanup: z.boolean(),
}).strict()
const executeBody = z.object({
  operationToken: z.string().min(1).max(32_768),
  currentPassword: z.string().min(12).max(128),
}).strict()

export interface AdminOwnerTransferRouteDeps {
  service: OwnerTransferService
  writesEnabled: boolean
  hub: WsHub
}

export async function adminOwnerTransferRoutes(
  app: FastifyInstance,
  deps: AdminOwnerTransferRouteDeps,
): Promise<void> {
  app.post('/api/admin/owner-transfer/preview', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const body = previewBody.safeParse(req.body)
    if (!body.success) return invalidBody(reply)
    return sendResult(reply, deps.hub, await deps.service.preview(req.actor, body.data))
  })

  app.post('/api/admin/owner-transfer', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const body = executeBody.safeParse(req.body)
    if (!body.success) return invalidBody(reply)
    try {
      return sendResult(reply, deps.hub, await deps.service.execute(req.actor, body.data))
    } catch (error) {
      if (!(error instanceof OwnerTransferServiceError)) throw error
      if (error.code === 'CLIENT_UPDATE_REQUIRED') {
        return reply.code(409).send({ error: 'client update required', code: error.code })
      }
      return reply.code(422).send({
        error: 'operation preview expired', code: 'OPERATION_PREVIEW_EXPIRED',
      })
    }
  })
}

function sendResult(reply: FastifyReply, hub: WsHub, result: OwnerTransferResult) {
  if (result.kind === 'preview') return reply.send({ preview: result.preview })
  if (result.kind === 'transferred') {
    publishOrganizationEffects(hub, result.effects)
    return reply.send({ currentOwner: result.currentOwner, newOwner: result.newOwner })
  }
  if (result.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' })
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'user not found' })
  if (result.kind === 'conflict') {
    return reply.code(409).send({
      error: 'revision conflict', code: 'REVISION_CONFLICT',
      currentOwner: result.currentOwner, targetUser: result.targetUser,
    })
  }
  return reply.code(409).send({
    error: 'organization invariant',
    code: result.blockers.some(blocker => blocker.code === 'CLIENT_UPDATE_REQUIRED')
      ? 'CLIENT_UPDATE_REQUIRED'
      : 'ORGANIZATION_INVARIANT',
    blockers: result.blockers,
  })
}

function requireWrite(actor: Actor, enabled: boolean, reply: FastifyReply): boolean {
  try {
    assertAdminWrite(actor, enabled)
    return true
  } catch (error) {
    if (!(error instanceof AdminAccessError)) throw error
    if (error.code === 'OWNER_REQUIRED') void reply.code(403).send({ error: 'forbidden' })
    else void reply.code(503).send({
      error: 'organization admin writes disabled', code: 'ADMIN_WRITES_DISABLED',
    })
    return false
  }
}

function invalidBody(reply: FastifyReply) {
  return reply.code(400).send({ error: 'invalid body' })
}
