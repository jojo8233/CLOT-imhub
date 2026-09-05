import { describe, expect, it, vi } from 'vitest'
import type { AdminAccount, AdminMutationPreview } from '@im-hub/shared'

import { AccountController } from './account-controller.js'

const account = (revision = 1): AdminAccount => ({
  id: 'account-1', platform: 'telegram', connectionMode: 'adapter', displayName: 'Telegram',
  status: 'connected', ownerUserId: 'user-1', teamId: null, cleanupState: 'not_required',
  pendingCleanupCount: 0, manualCleanupTaskIds: [], revision,
})
const preview: AdminMutationPreview = {
  operationToken: 'preview-token', expiresAt: '2026-09-05T01:00:00.000Z', summary: {},
}

describe('AccountController', () => {
  it('同一 preview 的双击执行只发送一次命令', async () => {
    const execute = vi.fn().mockResolvedValue(account(2))
    const controller = new AccountController('owner-1', {
      search: vi.fn().mockResolvedValue({ items: [account(1)], nextCursor: null }),
      previewAssignment: vi.fn().mockResolvedValue(preview),
      executeAssignment: execute,
    })
    await controller.load({})
    await controller.previewAssignment(account(1), {
      ownerUserId: 'user-2', teamId: null, allowManualCleanup: false,
    })

    await Promise.all([controller.executeAssignment(), controller.executeAssignment()])
    expect(execute).toHaveBeenCalledOnce()
    expect(controller.snapshot().items[0]?.revision).toBe(2)
  })
})
