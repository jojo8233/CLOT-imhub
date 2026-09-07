import { createHash } from 'node:crypto'
import { normalizeIP } from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const AUTH_TIME_WINDOW_MS = 15 * 60 * 1000
const LOGIN_IP_MAX = 30
const LOGIN_ACCOUNT_MAX = 10
const PASSWORD_CHANGE_MAX = 10

type RateLimitCheck = ReturnType<FastifyInstance['createRateLimit']>

export interface AuthRateLimits {
  guardLogin(request: FastifyRequest, reply: FastifyReply): Promise<void>
  guardInitialPassword(request: FastifyRequest, reply: FastifyReply): Promise<void>
  guardPasswordChange(request: FastifyRequest, reply: FastifyReply): Promise<void>
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function loginIpKey(ip: string): string {
  return `login-ip:${normalizeIP(ip, 64)}`
}

export function loginAccountKey(ip: string, email: string): string {
  return `login-account:${normalizeIP(ip, 64)}:${digest(email.trim().toLowerCase())}`
}

function initialPasswordKey(ip: string): string {
  return `initial-password:${normalizeIP(ip, 64)}`
}

function passwordChangeKey(ip: string, userId: string): string {
  return `password-change:${normalizeIP(ip, 64)}:${userId}`
}

function loginEmail(request: FastifyRequest): string | null {
  if (typeof request.body !== 'object' || request.body === null) return null
  const email = Reflect.get(request.body, 'email')
  return typeof email === 'string' ? email : null
}

async function enforce(
  check: RateLimitCheck,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    const result = await check(request)
    if (!result.isAllowed && result.isExceeded) {
      const retryAfterSeconds = Math.max(1, result.ttlInSeconds)
      reply.header('retry-after', String(retryAfterSeconds))
      reply.code(429).send({ error: 'too many requests', retryAfterSeconds })
      return false
    }
    return true
  } catch {
    request.log.error('authentication rate limit store unavailable')
    reply.code(503).send({ error: 'authentication temporarily unavailable' })
    return false
  }
}

export function createAuthRateLimits(app: FastifyInstance): AuthRateLimits {
  const loginIpLimit = app.createRateLimit({
    max: LOGIN_IP_MAX,
    timeWindow: AUTH_TIME_WINDOW_MS,
    ipv6Subnet: 64,
    keyGenerator: request => loginIpKey(request.ip),
  })
  const loginAccountLimit = app.createRateLimit({
    max: LOGIN_ACCOUNT_MAX,
    timeWindow: AUTH_TIME_WINDOW_MS,
    ipv6Subnet: 64,
    keyGenerator: request => loginAccountKey(request.ip, loginEmail(request) ?? ''),
  })
  const initialPasswordLimit = app.createRateLimit({
    max: PASSWORD_CHANGE_MAX,
    timeWindow: AUTH_TIME_WINDOW_MS,
    ipv6Subnet: 64,
    keyGenerator: request => initialPasswordKey(request.ip),
  })
  const passwordChangeLimit = app.createRateLimit({
    max: PASSWORD_CHANGE_MAX,
    timeWindow: AUTH_TIME_WINDOW_MS,
    ipv6Subnet: 64,
    keyGenerator: request => passwordChangeKey(request.ip, request.actor.userId),
  })
  return {
    guardLogin: async (request, reply) => {
      if (!await enforce(loginIpLimit, request, reply)) return
      if (loginEmail(request) === null) return
      await enforce(loginAccountLimit, request, reply)
    },
    guardInitialPassword: async (request, reply) => {
      await enforce(initialPasswordLimit, request, reply)
    },
    guardPasswordChange: async (request, reply) => {
      await enforce(passwordChangeLimit, request, reply)
    },
  }
}
