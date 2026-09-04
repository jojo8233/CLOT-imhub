import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

const TOKEN_TYPE = 'im-hub-admin-operation+jwt'
const TOKEN_PURPOSE = 'admin_operation'
const TOKEN_LIFETIME_SECONDS = 5 * 60

export interface AdminRevisionSnapshot {
  users: Record<string, number>
  teams: Record<string, number>
  accounts: Record<string, number>
}

export interface AdminOperationTokenInput<T> {
  kind: string
  ownerUserId: string
  input: T
  revisions: AdminRevisionSnapshot
}

export interface AdminOperationTokenExpectation {
  kind: string
  ownerUserId: string
}

export class AdminOperationTokenService {
  constructor(
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue<T>(input: AdminOperationTokenInput<T>): Promise<{
    operationToken: string
    expiresAt: string
  }> {
    const issuedAt = Math.floor(this.now().getTime() / 1_000)
    const expiresAt = issuedAt + TOKEN_LIFETIME_SECONDS
    const normalizedInput = normalizeJson(input.input)
    const revisions = normalizeRevisions(input.revisions)
    const operationToken = await new SignJWT({
      purpose: TOKEN_PURPOSE,
      operationKind: input.kind,
      ownerUserId: input.ownerUserId,
      input: normalizedInput,
      inputDigest: digestJson(normalizedInput),
      revisions,
    })
      .setProtectedHeader({ alg: 'HS256', typ: TOKEN_TYPE })
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(this.secret))
    return {
      operationToken,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    }
  }

  async verify<T = unknown>(
    token: string,
    expected: AdminOperationTokenExpectation,
  ): Promise<{ input: T; revisions: AdminRevisionSnapshot }> {
    const result = await jwtVerify(token, new TextEncoder().encode(this.secret), {
      algorithms: ['HS256'],
      typ: TOKEN_TYPE,
      currentDate: this.now(),
    })
    const payload = result.payload
    if (payload.purpose !== TOKEN_PURPOSE
      || payload.operationKind !== expected.kind
      || payload.ownerUserId !== expected.ownerUserId
      || !isJsonValue(payload.input)
      || typeof payload.inputDigest !== 'string'
      || payload.inputDigest !== digestJson(payload.input)
      || !isRevisionSnapshot(payload.revisions)) {
      throw new Error('invalid admin operation token')
    }
    return {
      input: payload.input as T,
      revisions: normalizeRevisions(payload.revisions),
    }
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function normalizeJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('admin operation input must be JSON-safe')
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeJson(value[key])]))
  }
  return value
}

function digestJson(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(normalizeJson(value))).digest('hex')
}

function isRevisionMap(value: unknown): value is Record<string, number> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(item => Number.isSafeInteger(item) && item > 0)
}

function isRevisionSnapshot(value: unknown): value is AdminRevisionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).sort().join(',') === 'accounts,teams,users'
    && isRevisionMap(candidate.users)
    && isRevisionMap(candidate.teams)
    && isRevisionMap(candidate.accounts)
}

function normalizeRevisions(value: AdminRevisionSnapshot): AdminRevisionSnapshot {
  if (!isRevisionSnapshot(value)) throw new Error('invalid admin operation revisions')
  return {
    users: sortRecord(value.users),
    teams: sortRecord(value.teams),
    accounts: sortRecord(value.accounts),
  }
}

function sortRecord(value: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {}
  for (const key of Object.keys(value).sort()) {
    const revision = value[key]
    if (revision === undefined) throw new Error('invalid admin operation revision')
    sorted[key] = revision
  }
  return sorted
}
