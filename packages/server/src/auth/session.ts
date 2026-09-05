import { SignJWT, jwtVerify } from 'jose'

/**
 * 会话只携带身份，不携带权限。
 * 角色必须每请求从数据库重读（见 api/actor.ts 的 loadActor）——
 * token 里的角色副本会在管理员改权限后继续有效到过期，那是提权漏洞。
 */
export interface SessionClaims {
  userId: string
  sessionVersion: number
}

const SESSION_TOKEN_TYPE = 'im-hub-session+jwt'

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({
    kind: 'session',
    userId: claims.userId,
    sessionVersion: claims.sessionVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: SESSION_TOKEN_TYPE })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret))
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] })
  const typedSession = protectedHeader.typ === SESSION_TOKEN_TYPE && payload.kind === 'session'
  if (!typedSession
    || typeof payload.userId !== 'string'
    || payload.userId === ''
    || typeof payload.sessionVersion !== 'number'
    || !Number.isInteger(payload.sessionVersion)
    || payload.sessionVersion < 1) {
    throw new Error('invalid session payload')
  }
  return { userId: payload.userId, sessionVersion: payload.sessionVersion }
}
