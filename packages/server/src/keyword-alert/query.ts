import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type {
  KeywordAlertSeverity,
  KeywordAlertStatusFilter,
  Platform,
  ScopeFilter,
} from '@im-hub/shared'

const CURSOR_VERSION = 1
const SHA256_HEX = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/

export interface KeywordAlertFilterIdentity {
  actorUserId: string
  scope: ScopeFilter
  status: KeywordAlertStatusFilter
  severity: KeywordAlertSeverity | null
  platform: Platform | null
  accountId: string | null
}

export interface KeywordAlertCursorPosition {
  createdAt: string
  alertId: string
  fingerprint: string
}

interface KeywordAlertCursorPayload extends KeywordAlertCursorPosition {
  v: typeof CURSOR_VERSION
}

export class KeywordAlertCursorError extends Error {
  constructor() {
    super('Invalid keyword alert cursor')
    this.name = 'KeywordAlertCursorError'
  }
}

export function keywordAlertFilterFingerprint(input: KeywordAlertFilterIdentity): string {
  const scope = input.scope.kind === 'teams'
    ? { kind: input.scope.kind, teamIds: [...input.scope.teamIds].sort() }
    : input.scope
  const identity = JSON.stringify({
    actorUserId: input.actorUserId,
    scope,
    status: input.status,
    severity: input.severity,
    platform: input.platform,
    accountId: input.accountId,
  })
  return createHash('sha256').update(identity).digest('hex')
}

export function encodeKeywordAlertCursor(position: KeywordAlertCursorPosition): string {
  assertPosition(position)
  const payload: KeywordAlertCursorPayload = {
    v: CURSOR_VERSION,
    createdAt: position.createdAt,
    alertId: position.alertId,
    fingerprint: position.fingerprint,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeKeywordAlertCursor(
  encoded: string,
  expectedFingerprint: string,
): KeywordAlertCursorPosition {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new KeywordAlertCursorError()
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw new KeywordAlertCursorError()
    const parsed: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isCursorPayload(parsed) || parsed.fingerprint !== expectedFingerprint) {
      throw new KeywordAlertCursorError()
    }
    return {
      createdAt: parsed.createdAt,
      alertId: parsed.alertId,
      fingerprint: parsed.fingerprint,
    }
  } catch (error) {
    if (error instanceof KeywordAlertCursorError) throw error
    throw new KeywordAlertCursorError()
  }
}

function assertPosition(position: KeywordAlertCursorPosition): void {
  if (!validIsoDate(position.createdAt)
    || !UUID.test(position.alertId)
    || !SHA256_HEX.test(position.fingerprint)) {
    throw new KeywordAlertCursorError()
  }
}

function isCursorPayload(value: unknown): value is KeywordAlertCursorPayload {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== 4
    || keys[0] !== 'alertId'
    || keys[1] !== 'createdAt'
    || keys[2] !== 'fingerprint'
    || keys[3] !== 'v') return false
  const candidate = value as Record<string, unknown>
  return candidate.v === CURSOR_VERSION
    && typeof candidate.createdAt === 'string'
    && validIsoDate(candidate.createdAt)
    && typeof candidate.alertId === 'string'
    && UUID.test(candidate.alertId)
    && typeof candidate.fingerprint === 'string'
    && SHA256_HEX.test(candidate.fingerprint)
}

function validIsoDate(value: string): boolean {
  if (!UTC_TIMESTAMP.test(value)) return false
  const millisecondValue = `${value.slice(0, 23)}Z`
  const date = new Date(millisecondValue)
  return Number.isFinite(date.getTime()) && date.toISOString() === millisecondValue
}
