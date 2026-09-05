import type { OrganizationPostCommitEffects } from '../organization-admin/account-service.js'
import type { WsHub } from './ws.js'

export function publishOrganizationEffects(
  hub: WsHub,
  effects: OrganizationPostCommitEffects,
): void {
  for (const userId of uniqueSorted(effects.organizationChangedUserIds)) {
    hub.publishTo(userId, { type: 'organization_changed' })
  }
  for (const userId of uniqueSorted(effects.cleanupRequestedUserIds)) {
    hub.publishTo(userId, { type: 'desktop_cleanup_requested' })
  }
  for (const userId of uniqueSorted(effects.revokedUserIds)) {
    hub.revokeUser(userId)
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
