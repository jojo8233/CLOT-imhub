import { NATIVE_CONTROL_AUTH_SCHEME, type Platform } from '@im-hub/shared'
import { config } from '../config.js'
import { db } from '../db/client.js'
import {
  verifyNativeControlGrant,
  type NativeControlGrantClaims,
} from '../auth/native-control-grant.js'

const MAX_GRANT_LENGTH = 8_192

export class NativeControlAuthorizationError extends Error {
  constructor() {
    super('native control unavailable')
    this.name = 'NativeControlAuthorizationError'
  }
}

export interface AuthorizedNativeControl {
  claims: NativeControlGrantClaims
  id: string
  accountId: string
  userId: string
  platform: Platform
  expectedPlatformAccountExternalId: string
}

export function isNativeControlAuthorization(value: string | undefined): boolean {
  return value?.startsWith(`${NATIVE_CONTROL_AUTH_SCHEME} `) ?? false
}

function extractGrant(header: string | undefined): string {
  if (!isNativeControlAuthorization(header)) throw new NativeControlAuthorizationError()
  const grant = header!.slice(NATIVE_CONTROL_AUTH_SCHEME.length + 1)
  if (grant === '' || grant.length > MAX_GRANT_LENGTH || grant.trim() !== grant) {
    throw new NativeControlAuthorizationError()
  }
  return grant
}

export async function authorizeNativeControl(
  authorization: string | undefined,
  requestedAccountId?: string,
): Promise<AuthorizedNativeControl> {
  try {
    const claims = await verifyNativeControlGrant(extractGrant(authorization), config.JWT_SECRET)
    if (requestedAccountId !== undefined && claims.accountId !== requestedAccountId) {
      throw new NativeControlAuthorizationError()
    }
    const account = await db.selectFrom('accounts')
      .innerJoin('users', 'users.id', 'accounts.owner_user_id')
      .select([
        'accounts.id as id',
        'accounts.platform as platform',
        'accounts.owner_user_id as owner_user_id',
        'accounts.platform_account_external_id as platform_account_external_id',
        'accounts.native_control_version as native_control_version',
        'users.role as user_role',
        'users.disabled_at as user_disabled_at',
      ])
      .where('accounts.id', '=', claims.accountId)
      .executeTakeFirst()
    if (!account
      || account.owner_user_id !== claims.userId
      || account.platform !== claims.platform
      || account.platform_account_external_id !== claims.expectedPlatformAccountExternalId
      || account.native_control_version !== claims.controlVersion
      || account.user_disabled_at !== null
      || account.user_role === 'auditor') {
      throw new NativeControlAuthorizationError()
    }
    return {
      claims,
      id: account.id,
      accountId: account.id,
      userId: account.owner_user_id,
      platform: account.platform,
      expectedPlatformAccountExternalId: account.platform_account_external_id,
    }
  } catch (error) {
    if (error instanceof NativeControlAuthorizationError) throw error
    throw new NativeControlAuthorizationError()
  }
}
