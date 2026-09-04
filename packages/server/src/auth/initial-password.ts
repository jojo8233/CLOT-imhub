import { SignJWT, jwtVerify } from 'jose'

export interface InitialPasswordSetupClaims {
  userId: string
  sessionVersion: number
}

const INITIAL_PASSWORD_TOKEN_TYPE = 'im-hub-initial-password+jwt'

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signInitialPasswordSetup(
  claims: InitialPasswordSetupClaims,
  secret: string,
): Promise<string> {
  return new SignJWT({
    purpose: 'initial_password',
    userId: claims.userId,
    sessionVersion: claims.sessionVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: INITIAL_PASSWORD_TOKEN_TYPE })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key(secret))
}

export async function verifyInitialPasswordSetup(
  token: string,
  secret: string,
): Promise<InitialPasswordSetupClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'],
  })
  if (protectedHeader.typ !== INITIAL_PASSWORD_TOKEN_TYPE
    || payload.purpose !== 'initial_password'
    || typeof payload.userId !== 'string'
    || payload.userId === ''
    || typeof payload.sessionVersion !== 'number'
    || !Number.isInteger(payload.sessionVersion)
    || payload.sessionVersion < 1) {
    throw new Error('invalid initial password setup payload')
  }
  return { userId: payload.userId, sessionVersion: payload.sessionVersion }
}
