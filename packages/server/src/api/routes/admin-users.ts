import type { FastifyInstance, FastifyReply } from 'fastify'
import { ADMIN_EDITABLE_ROLES, ROLES, type Actor } from '@im-hub/shared'
import { z } from 'zod'
import { AdminCursorError, OrganizationReadRepo } from '../../organization-admin/read-repo.js'
import {
  UserAdminService,
  UserAdminServiceError,
  type UserCredentialMutationResult,
  type UserDisableResult,
  type UserMutationResult,
} from '../../organization-admin/user-service.js'
import type { WsHub } from '../ws.js'
import { AdminAccessError, assertAdminWrite, assertOwner } from '../../organization-admin/admin-guard.js'
import { publishOrganizationEffects } from '../organization-effects.js'

const revision = z.number().int().positive()
const idParams = z.object({ id: z.string().uuid() }).strict()
const searchBody = z.object({
  q: z.string().max(200).optional(),
  roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length).optional(),
  status: z.enum(['enabled', 'disabled', 'all']).optional(),
  teamId: z.string().uuid().nullable().optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
const createBody = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(ADMIN_EDITABLE_ROLES),
  teamId: z.string().uuid().nullable(),
}).strict()
const updateBody = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  role: z.enum(ADMIN_EDITABLE_ROLES).optional(),
  baseRevision: revision,
}).strict().refine(value => value.displayName !== undefined || value.role !== undefined)
const revisionBody = z.object({ baseRevision: revision }).strict()
const teamResolution = z.discriminatedUnion('action', [
  z.object({
    teamId: z.string().uuid(),
    action: z.literal('replace_manager'),
    replacementManagerUserId: z.string().uuid(),
    baseRevision: revision,
  }).strict(),
  z.object({
    teamId: z.string().uuid(),
    action: z.literal('archive'),
    baseRevision: revision,
  }).strict(),
])
const disableBody = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('preview'),
    baseRevision: revision,
    input: z.object({
      teamResolutions: z.array(teamResolution).max(100),
      allowManualCleanup: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    phase: z.literal('execute'),
    operationToken: z.string().min(1).max(8_192),
  }).strict(),
])

export interface AdminUserRouteDeps {
  readRepo: OrganizationReadRepo
  userService: UserAdminService
  writesEnabled: boolean
  hub: WsHub
}

export async function adminUserRoutes(
  app: FastifyInstance,
  deps: AdminUserRouteDeps,
): Promise<void> {
  app.post('/api/admin/users/search', async (req, reply) => {
    if (!requireOwner(req.actor, reply)) return
    const parsed = searchBody.safeParse(req.body)
    if (!parsed.success) return invalidBody(reply)
    try {
      return await deps.readRepo.searchUsers(req.actor, parsed.data)
    } catch (error) {
      if (error instanceof AdminCursorError) return invalidBody(reply)
      throw error
    }
  })

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) return invalidBody(reply)
    try {
      const result = await deps.userService.create(req.actor, parsed.data)
      reply.header('cache-control', 'no-store')
      return reply.code(201).send(result)
    } catch (error) {
      return sendUserServiceError(reply, error)
    }
  })

  app.patch('/api/admin/users/:id', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = updateBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    const result = await deps.userService.update(req.actor, params.data.id, body.data)
    if (result.kind === 'updated' && result.revokeSession) deps.hub.revokeUser(result.user.id)
    return sendMutationResult(reply, result)
  })

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = revisionBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    const result = await deps.userService.resetPassword(req.actor, params.data.id, body.data)
    return sendCredentialResult(reply, deps.hub, result)
  })

  app.post('/api/admin/users/:id/enable', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = revisionBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    const result = await deps.userService.enable(req.actor, params.data.id, body.data)
    return sendCredentialResult(reply, deps.hub, result)
  })

  app.post('/api/admin/users/:id/disable', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = disableBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    try {
      const result = body.data.phase === 'preview'
        ? await deps.userService.previewDisable(req.actor, params.data.id, {
          baseRevision: body.data.baseRevision,
          teamResolutions: body.data.input.teamResolutions,
          allowManualCleanup: body.data.input.allowManualCleanup,
        })
        : await deps.userService.disable(req.actor, params.data.id, {
          operationToken: body.data.operationToken,
        })
      return sendDisableResult(reply, deps.hub, result)
    } catch (error) {
      return sendUserServiceError(reply, error)
    }
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
    if (error.code === 'OWNER_REQUIRED') {
      void reply.code(403).send({ error: 'forbidden' })
    } else {
      void reply.code(503).send({
        error: 'organization admin writes disabled',
        code: 'ADMIN_WRITES_DISABLED',
      })
    }
    return false
  }
}

function invalidBody(reply: FastifyReply) {
  return reply.code(400).send({ error: 'invalid body' })
}

function sendMutationResult(reply: FastifyReply, result: UserMutationResult) {
  if (result.kind === 'updated') return reply.send({ user: result.user })
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'user not found' })
  if (result.kind === 'conflict') {
    return reply.code(409).send({
      error: 'revision conflict', code: 'REVISION_CONFLICT', current: result.current,
    })
  }
  if (result.kind === 'blocked') {
    return reply.code(409).send({
      error: 'organization invariant', code: 'ORGANIZATION_INVARIANT', blockers: result.blockers,
    })
  }
  const exhaustive: never = result
  throw new Error(`unhandled user mutation result: ${String(exhaustive)}`)
}

function sendCredentialResult(
  reply: FastifyReply,
  hub: WsHub,
  result: UserCredentialMutationResult,
) {
  if (result.kind !== 'updated') return sendMutationResult(reply, result)
  hub.revokeUser(result.user.id)
  reply.header('cache-control', 'no-store')
  return reply.send({
    user: result.user,
    temporaryPassword: result.temporaryPassword,
    temporaryPasswordExpiresAt: result.temporaryPasswordExpiresAt,
  })
}

function sendDisableResult(reply: FastifyReply, hub: WsHub, result: UserDisableResult) {
  if (result.kind === 'preview') return reply.send({ preview: result.preview })
  if (result.kind === 'disabled') {
    publishOrganizationEffects(hub, result.effects)
    return reply.send({ user: result.user })
  }
  return sendMutationResult(reply, result)
}

function sendUserServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof UserAdminServiceError)) throw error
  if (error.code === 'OPERATION_PREVIEW_EXPIRED') {
    return reply.code(422).send({
      error: 'operation preview expired', code: 'OPERATION_PREVIEW_EXPIRED',
    })
  }
  if (error.code === 'CLIENT_UPDATE_REQUIRED') {
    return reply.code(409).send({ error: 'client update required', code: error.code })
  }
  const blockerCode = error.code === 'DUPLICATE_EMAIL' ? 'DUPLICATE_EMAIL' : error.code
  return reply.code(409).send({
    error: 'organization invariant',
    code: 'ORGANIZATION_INVARIANT',
    blockers: [{ code: blockerCode, count: 1 }],
  })
}
