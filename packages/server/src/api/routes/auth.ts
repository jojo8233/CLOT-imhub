import type { FastifyInstance } from 'fastify'
import type { LoginResponse } from '@im-hub/shared'
import { z } from 'zod'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { hashPassword, verifyPassword } from '../../auth/password.js'
import {
  signInitialPasswordSetup,
  verifyInitialPasswordSetup,
} from '../../auth/initial-password.js'
import { signSession } from '../../auth/session.js'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
}).strict()
const newPassword = z.string().superRefine((value, context) => {
  const length = Array.from(value).length
  if (length < 12 || length > 128) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'password length out of range',
    })
  }
})
const initialPasswordBody = z.object({ newPassword }).strict()
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
}).strict()

/**
 * 用户不存在时拿它当靶子跑一次 argon2，抹平"账号不存在"与"密码错误"的响应时间差。
 * argon2 故意很慢（几十到上百毫秒），只在用户存在时才调用的话，
 * 攻击者能靠响应快慢枚举出哪些邮箱有账号。
 */
const DUMMY_HASH = await hashPassword('timing-equalizer-not-a-real-password')

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const user = await db.selectFrom('users')
      .select([
        'id',
        'role',
        'password_hash',
        'display_name',
        'disabled_at',
        'session_version',
        'must_change_password',
        'temporary_password_expires_at',
      ])
      .where('email', '=', parsed.data.email)
      .executeTakeFirst()

    // 无论用户存在与否都跑一次校验，保持两条路径耗时一致
    const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, parsed.data.password)
    const temporaryPasswordExpired = user?.must_change_password === true
      && (!user.temporary_password_expires_at
        || user.temporary_password_expires_at.getTime() <= Date.now())
    if (!user || user.disabled_at || !ok || temporaryPasswordExpired) {
      return reply.code(401).send({ error: 'invalid credentials' })
    }

    const responseUser = {
      id: user.id,
      role: user.role,
      displayName: user.display_name,
    }
    if (user.must_change_password) {
      const setupToken = await signInitialPasswordSetup({
        userId: user.id,
        sessionVersion: user.session_version,
      }, config.JWT_SECRET)
      return {
        kind: 'password_change_required',
        setupToken,
        user: responseUser,
      } satisfies LoginResponse
    }

    const token = await signSession({
      userId: user.id,
      sessionVersion: user.session_version,
    }, config.JWT_SECRET)
    return {
      kind: 'authenticated',
      token,
      user: responseUser,
    } satisfies LoginResponse
  })

  app.post('/api/auth/initial-password/complete', async (req, reply) => {
    const parsed = initialPasswordBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const authorization = req.headers.authorization
    if (!authorization?.startsWith('InitialPassword ')) {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    let claims: Awaited<ReturnType<typeof verifyInitialPasswordSetup>>
    try {
      claims = await verifyInitialPasswordSetup(
        authorization.slice('InitialPassword '.length),
        config.JWT_SECRET,
      )
    } catch {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    const passwordHash = await hashPassword(parsed.data.newPassword)
    const updated = await db.transaction().execute(async transaction => {
      const user = await transaction.selectFrom('users')
        .select([
          'id',
          'role',
          'display_name',
          'disabled_at',
          'session_version',
          'must_change_password',
          'temporary_password_expires_at',
        ])
        .where('id', '=', claims.userId)
        .forUpdate()
        .executeTakeFirst()
      if (!user
        || user.disabled_at
        || !user.must_change_password
        || user.session_version !== claims.sessionVersion
        || !user.temporary_password_expires_at
        || user.temporary_password_expires_at.getTime() <= Date.now()) {
        return null
      }

      return transaction.updateTable('users')
        .set(expression => ({
          password_hash: passwordHash,
          must_change_password: false,
          temporary_password_expires_at: null,
          session_version: expression('session_version', '+', 1),
          revision: expression('revision', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', user.id)
        .returning(['id', 'role', 'display_name', 'session_version'])
        .executeTakeFirstOrThrow()
    })
    if (!updated) return reply.code(401).send({ error: 'unauthorized' })

    const token = await signSession({
      userId: updated.id,
      sessionVersion: updated.session_version,
    }, config.JWT_SECRET)
    return {
      kind: 'authenticated',
      token,
      user: {
        id: updated.id,
        role: updated.role,
        displayName: updated.display_name,
      },
    } satisfies LoginResponse
  })

  app.post('/api/session/password', async (req, reply) => {
    const parsed = changePasswordBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body' })

    const updated = await db.transaction().execute(async transaction => {
      const user = await transaction.selectFrom('users')
        .select([
          'id',
          'role',
          'display_name',
          'password_hash',
          'session_version',
          'disabled_at',
        ])
        .where('id', '=', req.actor.userId)
        .forUpdate()
        .executeTakeFirst()
      if (!user || user.disabled_at
        || !await verifyPassword(user.password_hash, parsed.data.currentPassword)) {
        return null
      }

      const passwordHash = await hashPassword(parsed.data.newPassword)
      return transaction.updateTable('users')
        .set(expression => ({
          password_hash: passwordHash,
          must_change_password: false,
          temporary_password_expires_at: null,
          session_version: expression('session_version', '+', 1),
          revision: expression('revision', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', user.id)
        .where('session_version', '=', user.session_version)
        .returning(['id', 'role', 'display_name', 'session_version'])
        .executeTakeFirst()
    })
    if (!updated) return reply.code(403).send({ error: 'forbidden' })

    const token = await signSession({
      userId: updated.id,
      sessionVersion: updated.session_version,
    }, config.JWT_SECRET)
    return {
      kind: 'authenticated',
      token,
      user: {
        id: updated.id,
        role: updated.role,
        displayName: updated.display_name,
      },
    } satisfies LoginResponse
  })
}
