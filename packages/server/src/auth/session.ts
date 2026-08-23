import { SignJWT, jwtVerify } from 'jose'
import type { Role } from '@im-hub/shared'

export interface SessionClaims {
  userId: string
  role: Role
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return new SignJWT({ userId: claims.userId, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret))
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(secret))
  return { userId: payload.userId as string, role: payload.role as Role }
}
