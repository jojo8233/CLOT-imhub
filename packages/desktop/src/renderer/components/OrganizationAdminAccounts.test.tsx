import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  confirmOneManualCleanupTask,
  OrganizationAdminAccountsContent,
} from './OrganizationAdminAccounts.js'

describe('OrganizationAdminAccounts', () => {
  it('显示平台、连接模式、状态、负责人、团队与清理状态，不提供删除动作', () => {
    const html = renderToStaticMarkup(<OrganizationAdminAccountsContent
      items={[{
        id: 'account-1', platform: 'signal', connectionMode: 'native_desktop',
        displayName: 'Signal Sales', status: 'connected', ownerUserId: 'user-1',
        teamId: 'team-1', cleanupState: 'manual_required', pendingCleanupCount: 2,
        manualCleanupTasks: [
          { id: 'task-1', installationId: 'installation-11111111', reason: 'signal_official_unlink', createdAt: '2026-09-05T00:00:00.000Z' },
          { id: 'task-2', installationId: null, reason: 'signal_official_unlink', createdAt: '2026-09-05T01:00:00.000Z' },
        ],
        revision: 3,
      }]}
      loading={false}
      q=""
      platform="all"
      cleanupState="all"
      onQueryChange={() => {}}
      onPlatformChange={() => {}}
      onCleanupStateChange={() => {}}
      onRefresh={() => {}}
      onAssign={() => {}}
      onConfirmManualCleanup={() => {}}
    />)
    expect(html).toContain('Signal')
    expect(html).toContain('native_desktop')
    expect(html).toContain('user-1')
    expect(html).toContain('team-1')
    expect(html).toContain('2 项待处理')
    expect(html).toContain('需在 Signal 官方已关联设备中人工解除')
    expect(html).toContain('确认已在官方解除')
    expect(html.match(/确认已在官方解除/g)).toHaveLength(2)
    expect(html).toContain('设备 …11111111')
    expect(html).toContain('未知旧设备')
    expect(html).not.toContain('自动清理 Signal')
    expect(html).not.toContain('删除账号')
  })

  it('一次确认只完成所选人工清理任务', async () => {
    const complete = vi.fn().mockResolvedValue(undefined)

    await confirmOneManualCleanupTask('task-2', () => true, complete)

    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith('task-2')
  })
})
