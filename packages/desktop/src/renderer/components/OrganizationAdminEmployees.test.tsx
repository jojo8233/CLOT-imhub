import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OrganizationAdminEmployeesContent } from './OrganizationAdminEmployees.js'

describe('OrganizationAdminEmployees', () => {
  it('显示筛选、角色、状态、零或一个团队、账号数和管理动作', () => {
    const html = renderToStaticMarkup(<OrganizationAdminEmployeesContent
      items={[
        {
          id: 'user-1', email: 'agent@example.test', displayName: 'Agent', role: 'agent',
          disabledAt: null, teamIds: ['team-1'], ownedAccountCount: 4, revision: 1,
        },
        {
          id: 'user-2', email: 'manager@example.test', displayName: 'Manager', role: 'manager',
          disabledAt: null, teamIds: ['team-2', 'team-3'], ownedAccountCount: 0, revision: 1,
        },
      ]}
      loading={false}
      q=""
      status="all"
      role="all"
      teamId=""
      onQueryChange={() => {}}
      onStatusChange={() => {}}
      onRoleChange={() => {}}
      onTeamChange={() => {}}
      onRefresh={() => {}}
      onCreate={() => {}}
      onEdit={() => {}}
      onChangeTeam={() => {}}
      onResetPassword={() => {}}
      onToggleEnabled={() => {}}
      onTransferOwner={() => {}}
    />)
    expect(html).toContain('搜索员工')
    expect(html).toContain('按团队 ID 筛选')
    expect(html).toContain('agent@example.test')
    expect(html).toContain('agent')
    expect(html).toContain('team-1')
    expect(html).toContain('team-2、team-3')
    expect(html).toContain('4 个账号')
    expect(html).toContain('重置密码')
    expect(html).toContain('编辑')
    expect(html).toContain('调整团队')
    expect(html).toContain('停用')
    expect(html).toContain('转让 owner')
  })
})
