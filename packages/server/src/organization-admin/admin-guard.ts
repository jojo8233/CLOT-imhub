import type { Actor } from '@im-hub/shared'

export type AdminAccessErrorCode = 'OWNER_REQUIRED' | 'ADMIN_WRITES_DISABLED'

export class AdminAccessError extends Error {
  constructor(readonly code: AdminAccessErrorCode) {
    super(code)
    this.name = 'AdminAccessError'
  }
}

export function assertOwner(actor: Actor): void {
  if (actor.role !== 'owner') throw new AdminAccessError('OWNER_REQUIRED')
}

export function assertAdminWrite(actor: Actor, writesEnabled: boolean): void {
  assertOwner(actor)
  if (!writesEnabled) throw new AdminAccessError('ADMIN_WRITES_DISABLED')
}
