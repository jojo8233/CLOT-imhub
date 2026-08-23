import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import { db } from '../../db/client.js'
import { hashPassword, verifyPassword } from '../../auth/password.js'
import { signSession } from '../../auth/session.js'

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) })

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
      .select(['id', 'role', 'password_hash', 'display_name', 'disabled_at'])
      .where('email', '=', parsed.data.email)
      .executeTakeFirst()

    // 无论用户存在与否都跑一次校验，保持两条路径耗时一致
    const ok = await verifyPassword(user?.password_hash ?? DUMMY_HASH, parsed.data.password)
    if (!user || user.disabled_at || !ok) {
      return reply.code(401).send({ error: 'invalid credentials' })
    }

    const token = await signSession({ userId: user.id }, config.JWT_SECRET)
    return { token, user: { id: user.id, role: user.role, displayName: user.display_name } }
  })
}
