import type { FastifyInstance, FastifyReply } from 'fastify'
import { PLATFORMS, type Actor } from '@im-hub/shared'
import { z } from 'zod'
import { AdminAccessError, assertAdminWrite, assertOwner } from '../../organization-admin/admin-guard.js'
import {
  AccountAdminService,
  AccountAdminServiceError,
  type AccountAssignmentResult,
} from '../../organization-admin/account-service.js'
import { DeviceService, DeviceServiceError } from '../../organization-admin/device-service.js'
import { AdminCursorError, OrganizationReadRepo } from '../../organization-admin/read-repo.js'
import { publishOrganizationEffects } from '../organization-effects.js'
import type { WsHub } from '../ws.js'

const revision = z.number().int().positive()
const idParams = z.object({ id: z.string().uuid() }).strict()
const searchBody = z.object({
  q: z.string().max(200).optional(),
  platform: z.enum(PLATFORMS).optional(),
  ownerUserId: z.string().uuid().optional(),
  teamId: z.string().uuid().nullable().optional(),
  cleanupState: z.enum(['not_required', 'pending', 'completed', 'manual_required']).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
const assignmentPreviewBody = z.object({
  ownerUserId: z.string().uuid(),
  teamId: z.string().uuid().nullable(),
  allowManualCleanup: z.boolean(),
  baseRevision: revision,
}).strict()
const assignmentBody = z.object({
  operationToken: z.string().min(1).max(8_192),
}).strict()

export interface AdminAccountRouteDeps {
  readRepo: OrganizationReadRepo
  accountService: AccountAdminService
  deviceService: DeviceService
  writesEnabled: boolean
  hub: WsHub
}

export async function adminAccountRoutes(
  app: FastifyInstance,
  deps: AdminAccountRouteDeps,
): Promise<void> {
  app.post('/api/admin/accounts/search', async (req, reply) => {
    if (!requireOwner(req.actor, reply)) return
    const parsed = searchBody.safeParse(req.body)
    if (!parsed.success) return invalidBody(reply)
    try {
      return await deps.readRepo.searchAccounts(req.actor, parsed.data)
    } catch (error) {
      if (error instanceof AdminCursorError) return invalidBody(reply)
      throw error
    }
  })

  app.post('/api/admin/accounts/:id/assignment-preview', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = assignmentPreviewBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    const result = await deps.accountService.previewAssignment(req.actor, {
      accountId: params.data.id,
      ...body.data,
    })
    return sendAssignmentResult(reply, deps.hub, result)
  })

  app.post('/api/admin/accounts/:id/assign', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = assignmentBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    try {
      const result = await deps.accountService.assign(req.actor, {
        accountId: params.data.id,
        operationToken: body.data.operationToken,
      })
      return sendAssignmentResult(reply, deps.hub, result)
    } catch (error) {
      return sendAccountServiceError(reply, error)
    }
  })

  app.post('/api/admin/desktop/cleanup-tasks/:id/confirm-manual', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    if (!params.success) return invalidBody(reply)
    try {
      await deps.deviceService.confirmManualTask(req.actor, params.data.id)
      return reply.send({ confirmed: true, message: '已确认官方解除' })
    } catch (error) {
      if (!(error instanceof DeviceServiceError)) throw error
      if (error.code === 'TASK_NOT_FOUND') return reply.code(404).send({ error: 'task not found' })
      if (error.code === 'TASK_INVALID_STATE') {
        return reply.code(409).send({ error: 'task is not manual cleanup' })
      }
      return reply.code(403).send({ error: 'forbidden' })
    }
  })
}

function sendAssignmentResult(
  reply: FastifyReply,
  hub: WsHub,
  result: AccountAssignmentResult,
) {
  if (result.kind === 'preview') return reply.send({ preview: result.preview })
  if (result.kind === 'assigned') {
    publishOrganizationEffects(hub, result.effects)
    return reply.send({ account: result.account })
  }
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'account not found' })
  if (result.kind === 'conflict') {
    return reply.code(409).send({
      error: 'revision conflict', code: 'REVISION_CONFLICT', current: result.current,
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

function sendAccountServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AccountAdminServiceError)) throw error
  if (error.code === 'CLIENT_UPDATE_REQUIRED') {
    return reply.code(409).send({ error: 'client update required', code: error.code })
  }
  return reply.code(422).send({
    error: 'operation preview expired', code: 'OPERATION_PREVIEW_EXPIRED',
  })
}

function requireOwner(actor: Actor, reply: FastifyReply): boolean {
  try {
    assertOwner(actor)
    return true
  } catch (error) {
    if (!(error instanceof AdminAccessError)) throw error
    void reply.code(403).send({ error: 'forbidden' })
    return false
  }
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
