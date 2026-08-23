import { SignJWT, jwtVerify } from 'jose'

/**
 * 会话只携带身份，不携带权限。
 * 角色必须每请求从数据库重读（见 api/actor.ts 的 loadActor）——
 * token 里的角色副本会在管理员改权限后继续有效到过期，那是提权漏洞。
 */
export interface SessionClaims {
  userId: string
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ userId: claims.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret))
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(secret))
  if (typeof payload.userId !== 'string' || payload.userId === '') {
    throw new Error('invalid session payload: userId')
  }
  return { userId: payload.userId }
}
