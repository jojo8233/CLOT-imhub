import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OrganizationAdminTeamsContent } from './OrganizationAdminTeams.js'

describe('OrganizationAdminTeams', () => {
  it('显示主管、成员/账号计数、归档状态和管理动作', () => {
    const html = renderToStaticMarkup(<OrganizationAdminTeamsContent
      items={[{
        id: 'team-1', name: 'Sales', managerUserId: 'manager-1', agentCount: 3,
        accountCount: 8, disabledAt: '2026-09-05T00:00:00.000Z', revision: 2,
      }]}
      loading={false}
      q=""
      status="all"
      onQueryChange={() => {}}
      onStatusChange={() => {}}
      onRefresh={() => {}}
      onCreate={() => {}}
      onRename={() => {}}
      onChangeManager={() => {}}
      onToggleArchive={() => {}}
    />)
    expect(html).toContain('Sales')
    expect(html).toContain('manager-1')
    expect(html).toContain('3 名成员')
    expect(html).toContain('8 个账号')
    expect(html).toContain('已归档')
    expect(html).toContain('重命名')
    expect(html).toContain('恢复')
  })
})
