import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Actor } from '@im-hub/shared'
import { z } from 'zod'
import { AdminAccessError, assertAdminWrite, assertOwner } from '../../organization-admin/admin-guard.js'
import { AdminCursorError, OrganizationReadRepo } from '../../organization-admin/read-repo.js'
import {
  TeamAdminService,
  TeamAdminServiceError,
  type AgentTeamMutationResult,
  type TeamMutationResult,
} from '../../organization-admin/team-service.js'
import type { WsHub } from '../ws.js'

const revision = z.number().int().positive()
const idParams = z.object({ id: z.string().uuid() }).strict()
const searchBody = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['enabled', 'archived', 'all']).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  managerUserId: z.string().uuid(),
}).strict()
const updateBody = z.object({
  name: z.string().trim().min(1).max(100),
  baseRevision: revision,
}).strict()
const managerChangeBody = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('preview'),
    baseRevision: revision,
    input: z.object({
      managerUserId: z.string().uuid(),
      allowManualCleanup: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    phase: z.literal('execute'),
    operationToken: z.string().min(1).max(8_192),
  }).strict(),
])
const archiveBody = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('preview'),
    baseRevision: revision,
    input: z.object({ allowManualCleanup: z.boolean() }).strict(),
  }).strict(),
  z.object({
    phase: z.literal('execute'),
    operationToken: z.string().min(1).max(8_192),
  }).strict(),
])
const restoreBody = z.object({
  managerUserId: z.string().uuid(),
  baseRevision: revision,
}).strict()
const agentTeamBody = z.object({
  teamId: z.string().uuid().nullable(),
  baseRevision: revision,
}).strict()

export interface AdminTeamRouteDeps {
  readRepo: OrganizationReadRepo
  teamService: TeamAdminService
  writesEnabled: boolean
  hub: WsHub
}

export async function adminTeamRoutes(
  app: FastifyInstance,
  deps: AdminTeamRouteDeps,
): Promise<void> {
  app.post('/api/admin/teams/search', async (req, reply) => {
    if (!requireOwner(req.actor, reply)) return
    const parsed = searchBody.safeParse(req.body)
    if (!parsed.success) return invalidBody(reply)
    try {
      return await deps.readRepo.searchTeams(req.actor, parsed.data)
    } catch (error) {
      if (error instanceof AdminCursorError) return invalidBody(reply)
      throw error
    }
  })

  app.post('/api/admin/teams', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) return invalidBody(reply)
    return sendTeamResult(reply, deps.hub, await deps.teamService.create(req.actor, parsed.data), 201)
  })

  app.patch('/api/admin/teams/:id', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = updateBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    return sendTeamResult(
      reply,
      deps.hub,
      await deps.teamService.update(req.actor, params.data.id, body.data),
    )
  })

  app.post('/api/admin/teams/:id/change-manager', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = managerChangeBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    try {
      const result = body.data.phase === 'preview'
        ? await deps.teamService.previewManagerChange(req.actor, params.data.id, {
          managerUserId: body.data.input.managerUserId,
          allowManualCleanup: body.data.input.allowManualCleanup,
          baseRevision: body.data.baseRevision,
        })
        : await deps.teamService.executeManagerChange(req.actor, params.data.id, {
          operationToken: body.data.operationToken,
        })
      return sendTeamResult(reply, deps.hub, result)
    } catch (error) {
      return sendTeamServiceError(reply, error)
    }
  })

  app.post('/api/admin/teams/:id/archive', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = archiveBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    try {
      const result = body.data.phase === 'preview'
        ? await deps.teamService.previewArchive(req.actor, params.data.id, {
          baseRevision: body.data.baseRevision,
          allowManualCleanup: body.data.input.allowManualCleanup,
        })
        : await deps.teamService.executeArchive(req.actor, params.data.id, {
          operationToken: body.data.operationToken,
        })
      return sendTeamResult(reply, deps.hub, result)
    } catch (error) {
      return sendTeamServiceError(reply, error)
    }
  })

  app.post('/api/admin/teams/:id/restore', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = restoreBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    return sendTeamResult(
      reply,
      deps.hub,
      await deps.teamService.restore(req.actor, params.data.id, body.data),
    )
  })

  app.post('/api/admin/agents/:id/change-team', async (req, reply) => {
    if (!requireWrite(req.actor, deps.writesEnabled, reply)) return
    const params = idParams.safeParse(req.params)
    const body = agentTeamBody.safeParse(req.body)
    if (!params.success || !body.success) return invalidBody(reply)
    const result = await deps.teamService.changeAgentTeam(req.actor, params.data.id, body.data)
    return sendAgentResult(reply, deps.hub, result)
  })
}

function sendTeamResult(
  reply: FastifyReply,
  hub: WsHub,
  result: TeamMutationResult,
  successStatus = 200,
) {
  if (result.kind === 'changed') {
    publishOrganizationChanges(hub, result.affectedUserIds)
    return reply.code(successStatus).send({ team: result.team })
  }
  if (result.kind === 'preview') return reply.send({ preview: result.preview })
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'team not found' })
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

function sendAgentResult(reply: FastifyReply, hub: WsHub, result: AgentTeamMutationResult) {
  if (result.kind === 'changed') {
    publishOrganizationChanges(hub, [result.user.id])
    return reply.send({ user: result.user, affectedAccountIds: result.affectedAccountIds })
  }
  if (result.kind === 'not_found') return reply.code(404).send({ error: 'agent not found' })
  if (result.kind === 'conflict') {
    return reply.code(409).send({
      error: 'revision conflict', code: 'REVISION_CONFLICT', current: result.current,
    })
  }
  return reply.code(409).send({
    error: 'organization invariant', code: 'ORGANIZATION_INVARIANT', blockers: result.blockers,
  })
}

function publishOrganizationChanges(hub: WsHub, userIds: string[]) {
  for (const userId of [...new Set(userIds)].sort()) {
    hub.publishTo(userId, { type: 'organization_changed' })
  }
}

function sendTeamServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof TeamAdminServiceError)) throw error
  if (error.code === 'CLIENT_UPDATE_REQUIRED') {
    return reply.code(409).send({
      error: 'client update required', code: 'CLIENT_UPDATE_REQUIRED',
    })
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
