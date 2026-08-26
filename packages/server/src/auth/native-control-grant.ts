import { randomUUID } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { Platform } from '@im-hub/shared'
import { NATIVE_CONTROL_GRANT_TTL_SECONDS } from '@im-hub/shared'

const NATIVE_CONTROL_TOKEN_TYPE = 'im-hub-native-control+jwt'

export interface NativeControlGrantClaims {
  grantId: string
  userId: string
  accountId: string
  platform: Platform
  expectedPlatformAccountExternalId: string
  controlVersion: number
  expiresAt: Date
}

interface SignNativeControlGrantInput {
  userId: string
  accountId: string
  platform: Platform
  expectedPlatformAccountExternalId: string
  controlVersion: number
  now?: Date
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signNativeControlGrant(
  input: SignNativeControlGrantInput,
  secret: string,
): Promise<{ grant: string; claims: NativeControlGrantClaims }> {
  const now = input.now ?? new Date()
  const issuedAt = Math.floor(now.getTime() / 1_000)
  const expiresAtSeconds = issuedAt + NATIVE_CONTROL_GRANT_TTL_SECONDS
  const grantId = randomUUID()
  const grant = await new SignJWT({
    kind: 'native-control',
    userId: input.userId,
    accountId: input.accountId,
    platform: input.platform,
    expectedPlatformAccountExternalId: input.expectedPlatformAccountExternalId,
    controlVersion: input.controlVersion,
  })
    .setProtectedHeader({ alg: 'HS256', typ: NATIVE_CONTROL_TOKEN_TYPE })
    .setJti(grantId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(key(secret))

  return {
    grant,
    claims: {
      grantId,
      userId: input.userId,
      accountId: input.accountId,
      platform: input.platform,
      expectedPlatformAccountExternalId: input.expectedPlatformAccountExternalId,
      controlVersion: input.controlVersion,
      expiresAt: new Date(expiresAtSeconds * 1_000),
    },
  }
}

export async function verifyNativeControlGrant(
  grant: string,
  secret: string,
): Promise<NativeControlGrantClaims> {
  const { payload, protectedHeader } = await jwtVerify(grant, key(secret), { algorithms: ['HS256'] })
  if (protectedHeader.typ !== NATIVE_CONTROL_TOKEN_TYPE
    || payload.kind !== 'native-control'
    || typeof payload.jti !== 'string'
    || payload.jti === ''
    || typeof payload.userId !== 'string'
    || payload.userId === ''
    || typeof payload.accountId !== 'string'
    || payload.accountId === ''
    || !['telegram', 'signal', 'whatsapp', 'zoom'].includes(String(payload.platform))
    || typeof payload.expectedPlatformAccountExternalId !== 'string'
    || payload.expectedPlatformAccountExternalId === ''
    || !Number.isSafeInteger(payload.controlVersion)
    || (payload.controlVersion as number) < 0
    || typeof payload.exp !== 'number') {
    throw new Error('invalid native control grant')
  }

  return {
    grantId: payload.jti,
    userId: payload.userId,
    accountId: payload.accountId,
    platform: payload.platform as Platform,
    expectedPlatformAccountExternalId: payload.expectedPlatformAccountExternalId,
    controlVersion: payload.controlVersion as number,
    expiresAt: new Date(payload.exp * 1_000),
  }
}
