import { createHash } from 'node:crypto'
import type { Platform } from '@im-hub/shared'
import { z } from 'zod'

const cursorSchema = z.object({
  v: z.literal(1),
  snapshotAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  conversationId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export interface CustomerProfileFilterIdentity {
  q: string | null
  platform: Platform | null
  accountId: string | null
}

export interface CustomerProfileCursorPosition {
  snapshotAt: string
  updatedAt: string
  conversationId: string
  fingerprint: string
}

export class CustomerProfileCursorError extends Error {
  constructor() {
    super('invalid customer profile cursor')
    this.name = 'CustomerProfileCursorError'
  }
}

export function escapeCustomerProfileLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

export function customerProfileFilterFingerprint(
  filters: CustomerProfileFilterIdentity,
): string {
  return createHash('sha256')
    .update(JSON.stringify([filters.q, filters.platform, filters.accountId]))
    .digest('hex')
}

export function encodeCustomerProfileCursor(
  position: CustomerProfileCursorPosition,
): string {
  return Buffer.from(JSON.stringify({ v: 1, ...position }), 'utf8').toString('base64url')
}

export function decodeCustomerProfileCursor(
  encoded: string,
  expectedFingerprint: string,
): CustomerProfileCursorPosition {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    )
    if (parsed.fingerprint !== expectedFingerprint) {
      throw new CustomerProfileCursorError()
    }
    return {
      snapshotAt: parsed.snapshotAt,
      updatedAt: parsed.updatedAt,
      conversationId: parsed.conversationId,
      fingerprint: parsed.fingerprint,
    }
  } catch (error) {
    if (error instanceof CustomerProfileCursorError) throw error
    throw new CustomerProfileCursorError()
  }
}
