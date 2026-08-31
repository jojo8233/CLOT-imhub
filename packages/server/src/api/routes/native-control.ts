import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import type { NativeControlGrantResponse, NativeControlGrantVerification } from '@im-hub/shared'
import { normalizeSignalAci, normalizeWhatsAppWebUserId } from '@im-hub/shared'
import { signNativeControlGrant } from '../../auth/native-control-grant.js'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { authorizeNativeControl } from '../native-control.js'

const idParam = z.object({ id: z.string().uuid() })
const grantBody = z.object({
  /** Signal 首次绑定时由已登记的 WebContentsView 上报实际 ACI；不接受 accountId。 */
  platformAccountExternalId: z.string().trim().min(1).max(512).optional(),
}).optional()

export async function nativeControlRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/accounts/:id/native-control-grant', async (req, reply) => {
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '账号 id 不合法' })
    const body = grantBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: '平台身份不合法' })
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号不能操控平台账号' })
    }

    const requestedPlatformIdentity = body.data?.platformAccountExternalId ?? null

    const result = await db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom('accounts')
        .select([
          'id', 'platform', 'owner_user_id', 'platform_account_external_id', 'native_control_version',
          'connection_mode',
        ])
        .where('id', '=', params.data.id)
        .where('owner_user_id', '=', req.actor.userId)
        .forUpdate()
        .executeTakeFirst()
      if (!current) return { account: null, error: null }
      if (current.platform === 'telegram') {
        if (!current.platform_account_external_id) return { account: current, error: 'identity_missing' as const }
      } else if (current.platform === 'signal' && current.connection_mode === 'native_desktop') {
        if (!requestedPlatformIdentity) return { account: current, error: 'identity_missing' as const }
        let requestedSignalIdentity: string
        try {
          requestedSignalIdentity = normalizeSignalAci(requestedPlatformIdentity)
        } catch {
          return { account: current, error: 'identity_invalid' as const }
        }
        if (current.platform_account_external_id
          && current.platform_account_external_id !== requestedSignalIdentity) {
          return { account: current, error: 'identity_mismatch' as const }
        }
        current.platform_account_external_id = requestedSignalIdentity
      } else if (current.platform === 'whatsapp'
        && (current.connection_mode === 'web_shell' || current.connection_mode === 'adapter')) {
        if (!requestedPlatformIdentity) return { account: current, error: 'identity_missing' as const }
        let requestedWhatsAppIdentity: string
        try {
          requestedWhatsAppIdentity = normalizeWhatsAppWebUserId(requestedPlatformIdentity)
        } catch {
          return { account: current, error: 'identity_invalid' as const }
        }
        if (current.platform_account_external_id
          && current.platform_account_external_id !== requestedWhatsAppIdentity) {
          return { account: current, error: 'identity_mismatch' as const }
        }
        current.platform_account_external_id = requestedWhatsAppIdentity
      } else {
        return { account: current, error: 'unsupported' as const }
      }

      const account = await trx.updateTable('accounts')
        .set({
          native_control_version: sql<number>`native_control_version + 1`,
          ...(current.platform === 'signal' || current.platform === 'whatsapp'
            ? {
                platform_account_external_id: current.platform_account_external_id,
                status: 'connected' as const,
              }
            : {}),
        })
        .where('id', '=', current.id)
        .returning([
          'id', 'platform', 'owner_user_id', 'platform_account_external_id', 'native_control_version',
          'connection_mode',
        ])
        .executeTakeFirstOrThrow()
      return { account, error: null }
    })

    const { account } = result
    if (!account) return reply.code(404).send({ error: '账号不存在或不属于你' })
    if (result.error === 'unsupported') {
      return reply.code(409).send({ error: '该平台尚未支持原生账号控制' })
    }
    if (result.error === 'identity_invalid') {
      return reply.code(400).send({ error: '平台身份不合法' })
    }
    if (result.error === 'identity_mismatch') {
      return reply.code(409).send({ error: '平台登录身份与已绑定账号不一致' })
    }
    if (result.error === 'identity_missing' || !account.platform_account_external_id) {
      return reply.code(409).send({ error: '平台身份尚未就绪，请等待账号连接后重试' })
    }
    if (!Number.isSafeInteger(account.native_control_version)
      || account.native_control_version <= 0) {
      return reply.code(409).send({ error: '账号控制版本无效，请重新连接账号' })
    }

    const { grant, claims } = await signNativeControlGrant({
      userId: account.owner_user_id,
      accountId: account.id,
      platform: account.platform,
      expectedPlatformAccountExternalId: account.platform_account_external_id,
      controlVersion: account.native_control_version,
    }, config.JWT_SECRET)
    return {
      grant,
      expiresAt: claims.expiresAt.toISOString(),
    } satisfies NativeControlGrantResponse
  })

  app.post('/api/native/control-grant/verify', async (req, reply) => {
    try {
      const control = await authorizeNativeControl(req.headers.authorization)
      return {
        accountId: control.accountId,
        platform: control.platform,
        expectedPlatformAccountExternalId: control.expectedPlatformAccountExternalId,
        expiresAt: control.claims.expiresAt.toISOString(),
      } satisfies NativeControlGrantVerification
    } catch {
      return reply.code(401).send({ error: 'native control unavailable' })
    }
  })

  app.delete('/api/native/control-grant', async (req, reply) => {
    try {
      const control = await authorizeNativeControl(req.headers.authorization)
      await db.updateTable('accounts')
        .set({ native_control_version: sql<number>`native_control_version + 1` })
        .where('id', '=', control.accountId)
        .where('native_control_version', '=', control.claims.controlVersion)
        .execute()
      return { ok: true }
    } catch {
      return reply.code(401).send({ error: 'native control unavailable' })
    }
  })
}
