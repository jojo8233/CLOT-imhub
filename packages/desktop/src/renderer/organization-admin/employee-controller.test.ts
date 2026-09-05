import { describe, expect, it, vi } from 'vitest'
import type { AdminMutationPreview, AdminPage, AdminUser } from '@im-hub/shared'

import { NetworkError } from '../api/client.js'
import { EmployeeController } from './employee-controller.js'

const user = (revision = 1): AdminUser => ({
  id: 'user-1', email: 'agent@example.test', displayName: 'Agent', role: 'agent',
  disabledAt: null, teamIds: [], ownedAccountCount: 0, revision,
})
const preview: AdminMutationPreview = {
  operationToken: 'preview-token', expiresAt: '2026-09-05T01:00:00.000Z', summary: {},
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('EmployeeController', () => {
  it('行 revision 在预览期间变化时丢弃旧 preview，但保留编辑草稿', async () => {
    const previewRequest = deferred<AdminMutationPreview>()
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [user(1)], nextCursor: null })
      .mockResolvedValueOnce({ items: [user(2)], nextCursor: null })
    const controller = new EmployeeController('owner-1', {
      search,
      previewDisable: vi.fn(() => previewRequest.promise),
      executeDisable: vi.fn(),
      create: vi.fn(),
    })
    await controller.load({})

    const pending = controller.previewDisable(user(1), {
      teamResolutions: [], allowManualCleanup: false,
    })
    await controller.load({})
    previewRequest.resolve(preview)
    await pending

    expect(controller.snapshot().preview).toBeNull()
    expect(controller.snapshot().draft).toEqual({ teamResolutions: [], allowManualCleanup: false })
  })

  it('网络结果未知期间禁止重复执行，强制刷新完成后才回 idle', async () => {
    const refresh = deferred<AdminPage<AdminUser>>()
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [user(1)], nextCursor: null })
      .mockImplementationOnce(() => refresh.promise)
    const executeDisable = vi.fn().mockRejectedValue(new NetworkError(new Error('offline')))
    const controller = new EmployeeController('owner-1', {
      search,
      previewDisable: vi.fn().mockResolvedValue(preview),
      executeDisable,
      create: vi.fn(),
    })
    await controller.load({})
    await controller.previewDisable(user(1), { teamResolutions: [], allowManualCleanup: false })

    const first = controller.executeDisable()
    const second = controller.executeDisable()
    await vi.waitFor(() => { expect(controller.snapshot().outcome).toBe('unknown') })
    expect(executeDisable).toHaveBeenCalledOnce()
    refresh.resolve({ items: [user(2)], nextCursor: null })
    await Promise.all([first, second])
    expect(controller.snapshot().outcome).toBe('idle')
  })

  it('临时密码只存在于 create 的即时返回值，不进入快照', async () => {
    const credential = {
      user: user(1), temporaryPassword: 'temporary-password-sentinel',
      temporaryPasswordExpiresAt: '2026-09-06T00:00:00.000Z',
    }
    const controller = new EmployeeController('owner-1', {
      search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      previewDisable: vi.fn(), executeDisable: vi.fn(),
      create: vi.fn().mockResolvedValue(credential),
    })

    await expect(controller.create({
      email: 'agent@example.test', displayName: 'Agent', role: 'agent', teamId: null,
    })).resolves.toEqual(credential)
    expect(JSON.stringify(controller.snapshot())).not.toContain('temporary-password-sentinel')
  })
})
