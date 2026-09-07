import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { hashPassword } from '../auth/password.js'
import type { Database } from './types.js'

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1_000
const emailSchema = z.string().trim().email().max(320)

export type BootstrapOwnerErrorCode =
  | 'INVALID_EMAIL'
  | 'INVALID_DISPLAY_NAME'
  | 'INVALID_PASSWORD'
  | 'INVALID_TIME'
  | 'DATABASE_NOT_EMPTY'

const ERROR_MESSAGES: Record<BootstrapOwnerErrorCode, string> = {
  INVALID_EMAIL: 'invalid email',
  INVALID_DISPLAY_NAME: 'invalid display name',
  INVALID_PASSWORD: 'invalid password',
  INVALID_TIME: 'invalid bootstrap time',
  DATABASE_NOT_EMPTY: 'database is not empty',
}

export class BootstrapOwnerError extends Error {
  constructor(readonly code: BootstrapOwnerErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'BootstrapOwnerError'
  }
}

export interface BootstrapOwnerInput {
  email: string
  displayName: string
  password: string
  now: Date
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function validateInput(input: BootstrapOwnerInput): {
  email: string
  displayName: string
} {
  const parsedEmail = emailSchema.safeParse(input.email)
  if (!parsedEmail.success) throw new BootstrapOwnerError('INVALID_EMAIL')

  const displayName = input.displayName.trim()
  const displayNameLength = codePointLength(displayName)
  if (displayNameLength < 1 || displayNameLength > 100) {
    throw new BootstrapOwnerError('INVALID_DISPLAY_NAME')
  }

  const passwordLength = codePointLength(input.password)
  if (passwordLength < 12 || passwordLength > 128) {
    throw new BootstrapOwnerError('INVALID_PASSWORD')
  }
  if (!Number.isFinite(input.now.getTime())) throw new BootstrapOwnerError('INVALID_TIME')

  return {
    email: parsedEmail.data.toLowerCase(),
    displayName,
  }
}

export async function bootstrapOwner(
  db: Kysely<Database>,
  input: BootstrapOwnerInput,
): Promise<{ id: string }> {
  const normalized = validateInput(input)
  const expiresAt = new Date(input.now.getTime() + TEMPORARY_PASSWORD_LIFETIME_MS)

  return db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('im-hub-bootstrap-owner'))`
      .execute(transaction)
    const existing = await transaction.selectFrom('users')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow()
    if (Number(existing.count) !== 0) {
      throw new BootstrapOwnerError('DATABASE_NOT_EMPTY')
    }

    const passwordHash = await hashPassword(input.password)
    return transaction.insertInto('users').values({
      email: normalized.email,
      display_name: normalized.displayName,
      role: 'owner',
      password_hash: passwordHash,
      must_change_password: true,
      temporary_password_expires_at: expiresAt,
    }).returning('id').executeTakeFirstOrThrow()
  })
}
