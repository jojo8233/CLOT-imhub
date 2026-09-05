import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OrganizationAdminAccountsContent } from './OrganizationAdminAccounts.js'

describe('OrganizationAdminAccounts', () => {
  it('显示平台、连接模式、状态、负责人、团队与清理状态，不提供删除动作', () => {
    const html = renderToStaticMarkup(<OrganizationAdminAccountsContent
      items={[{
        id: 'account-1', platform: 'signal', connectionMode: 'native_desktop',
        displayName: 'Signal Sales', status: 'connected', ownerUserId: 'user-1',
        teamId: 'team-1', cleanupState: 'manual_required', pendingCleanupCount: 2,
        manualCleanupTaskIds: ['task-1', 'task-2'], revision: 3,
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
    expect(html).not.toContain('自动清理 Signal')
    expect(html).not.toContain('删除账号')
  })
})
