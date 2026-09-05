import { describe, expect, it, vi } from 'vitest'
import type { AdminAccount, AdminTeam, AdminTeamResolution } from '@im-hub/shared'
import { HttpError } from '../api/client.js'
import {
  ownerTransferAccountResolutions,
} from './OrganizationAdminEmployees.js'
import { previewWithManualCleanupFallback } from '../organization-admin/manual-cleanup.js'

const teams: AdminTeam[] = [
  { id: 'target-team', name: 'Target', managerUserId: 'target', agentCount: 0, accountCount: 1, disabledAt: null, revision: 2 },
  { id: 'archive-team', name: 'Archive', managerUserId: 'manager', agentCount: 0, accountCount: 1, disabledAt: null, revision: 3 },
  { id: 'other-team', name: 'Other', managerUserId: 'other', agentCount: 0, accountCount: 1, disabledAt: null, revision: 4 },
  { id: 'owner-new-team', name: 'Owner next team', managerUserId: 'old-manager', agentCount: 0, accountCount: 1, disabledAt: null, revision: 5 },
]

const resolutions: AdminTeamResolution[] = [
  { teamId: 'target-team', action: 'replace_manager', replacementManagerUserId: 'manager-2', baseRevision: 2 },
  { teamId: 'archive-team', action: 'archive', baseRevision: 3 },
  { teamId: 'owner-new-team', action: 'replace_manager', replacementManagerUserId: 'owner', baseRevision: 5 },
]

const accounts: AdminAccount[] = [
  account('owner-account', 'owner', 'other-team', 1),
  account('target-managed-account', 'target', 'target-team', 2),
  account('archived-account', 'agent', 'archive-team', 3),
  account('unaffected-account', 'agent', 'other-team', 4),
  account('displaced-account', 'old-manager', 'owner-new-team', 5),
]

describe('ownerTransferAccountResolutions', () => {
  it('覆盖当前 owner、离任主管与归档团队账号，并保留无关账号', () => {
    expect(ownerTransferAccountResolutions(accounts, teams, resolutions, 'owner', 'target')).toEqual([
      { accountId: 'archived-account', ownerUserId: 'agent', teamId: null, baseRevision: 3 },
      { accountId: 'displaced-account', ownerUserId: 'target', teamId: 'owner-new-team', baseRevision: 5 },
      { accountId: 'owner-account', ownerUserId: 'target', teamId: 'other-team', baseRevision: 1 },
    ])
  })

  it('旧版在线客户端默认阻断，只有 owner 明确确认后才以人工模式重新预览', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new HttpError(409, 'client update required', 'CLIENT_UPDATE_REQUIRED'))
      .mockResolvedValueOnce('preview')
    const confirm = vi.fn(() => true)

    await expect(previewWithManualCleanupFallback(request, confirm)).resolves.toBe('preview')

    expect(request.mock.calls).toEqual([[false], [true]])
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('owner 不确认人工覆盖时保留客户端升级阻断', async () => {
    const error = new HttpError(409, 'client update required', 'CLIENT_UPDATE_REQUIRED')
    const request = vi.fn().mockRejectedValue(error)

    await expect(previewWithManualCleanupFallback(request, () => false)).rejects.toBe(error)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(false)
  })
})

function account(id: string, ownerUserId: string, teamId: string | null, revision: number): AdminAccount {
  return {
    id, ownerUserId, teamId, revision, platform: 'telegram', connectionMode: 'adapter',
    displayName: id, status: 'connected', cleanupState: 'not_required', pendingCleanupCount: 0,
    manualCleanupTasks: [],
  }
}
