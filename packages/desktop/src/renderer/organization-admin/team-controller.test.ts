import { describe, expect, it, vi } from 'vitest'
import type { AdminMutationPreview, AdminTeam } from '@im-hub/shared'

import { HttpError } from '../api/client.js'
import { TeamController } from './team-controller.js'

const team = (revision = 1): AdminTeam => ({
  id: 'team-1', name: 'Sales', managerUserId: 'manager-1', agentCount: 2,
  accountCount: 3, disabledAt: null, revision,
})
const preview: AdminMutationPreview = {
  operationToken: 'preview-token', expiresAt: '2026-09-05T01:00:00.000Z', summary: {},
}

describe('TeamController', () => {
  it('409 用最新团队快照替换旧行，同时保留未提交的换主管草稿', async () => {
    const current = team(2)
    const controller = new TeamController('owner-1', {
      search: vi.fn().mockResolvedValue({ items: [team(1)], nextCursor: null }),
      previewChange: vi.fn().mockResolvedValue(preview),
      executeChange: vi.fn().mockRejectedValue(new HttpError(
        409, 'conflict', 'REVISION_CONFLICT', { current },
      )),
    })
    const outcomes: string[] = []
    controller.subscribe(() => outcomes.push(controller.snapshot().outcome))
    await controller.load({})
    await controller.previewChange(team(1), {
      managerUserId: 'manager-2', allowManualCleanup: false,
    })

    await expect(controller.executeChange()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(controller.snapshot().items[0]?.revision).toBe(2)
    expect(controller.snapshot().draft).toEqual({
      managerUserId: 'manager-2', allowManualCleanup: false,
    })
    expect(controller.snapshot().preview).toBeNull()
    expect(outcomes).toEqual(expect.arrayContaining(['executing', 'conflict']))
  })
})
