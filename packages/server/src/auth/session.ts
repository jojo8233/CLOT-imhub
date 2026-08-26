import { SignJWT, jwtVerify } from 'jose'

/**
 * 会话只携带身份，不携带权限。
 * 角色必须每请求从数据库重读（见 api/actor.ts 的 loadActor）——
 * token 里的角色副本会在管理员改权限后继续有效到过期，那是提权漏洞。
 */
export interface SessionClaims {
  userId: string
}

const SESSION_TOKEN_TYPE = 'im-hub-session+jwt'

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ kind: 'session', userId: claims.userId })
    .setProtectedHeader({ alg: 'HS256', typ: SESSION_TOKEN_TYPE })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret))
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] })
  // 兼容本次上线前已经签出的、最长仅剩 12 小时的无 typ session；新的 native grant
  // 带独立 typ/kind，因此不会落入这个兼容分支。兼容窗口会随旧 token 自然过期消失。
  const typedSession = protectedHeader.typ === SESSION_TOKEN_TYPE && payload.kind === 'session'
  const legacySession = protectedHeader.typ === undefined && payload.kind === undefined
  if ((!typedSession && !legacySession)
    || typeof payload.userId !== 'string'
    || payload.userId === '') {
    throw new Error('invalid session payload: userId')
  }
  return { userId: payload.userId }
}
