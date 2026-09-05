import { useState, type ReactNode } from 'react'
import type { Role } from '@im-hub/shared'
import { theme } from '../theme.js'
import { OrganizationAdminAccounts } from './OrganizationAdminAccounts.js'
import { OrganizationAdminEmployees } from './OrganizationAdminEmployees.js'
import { OrganizationAdminTeams } from './OrganizationAdminTeams.js'

type AdminTab = 'employees' | 'teams' | 'accounts'

export function OrganizationAdminView({ role, ownerUserId }: { role: Role; ownerUserId: string }) {
  const [activeTab, setActiveTab] = useState<AdminTab>('employees')
  return <OrganizationAdminViewContent
    role={role}
    activeTab={activeTab}
    onTabChange={setActiveTab}
    employees={<OrganizationAdminEmployees ownerUserId={ownerUserId} />}
    teams={<OrganizationAdminTeams ownerUserId={ownerUserId} />}
    accounts={<OrganizationAdminAccounts ownerUserId={ownerUserId} />}
  />
}

export function OrganizationAdminViewContent({
  role, activeTab, onTabChange, employees, teams, accounts,
}: {
  role: Role
  activeTab: AdminTab
  onTabChange(tab: AdminTab): void
  employees: ReactNode
  teams: ReactNode
  accounts: ReactNode
}) {
  if (role !== 'owner') return null
  const content = activeTab === 'employees' ? employees : activeTab === 'teams' ? teams : accounts
  return (
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: theme.color.surface }}>
      <header style={{ padding: '18px 22px 12px', borderBottom: `1px solid ${theme.color.border}`, background: theme.color.card }}>
        <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy }}>管理中心</div>
        <div style={{ marginTop: 3, color: theme.color.textMuted, fontSize: theme.font.size.sm }}>
          公司内部员工、团队与平台账号管理；仅 owner 可操作
        </div>
        <nav aria-label="管理中心页签" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <TabButton active={activeTab === 'employees'} onClick={() => onTabChange('employees')}>员工</TabButton>
          <TabButton active={activeTab === 'teams'} onClick={() => onTabChange('teams')}>团队</TabButton>
          <TabButton active={activeTab === 'accounts'} onClick={() => onTabChange('accounts')}>平台账号</TabButton>
        </nav>
      </header>
      {content}
    </main>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return <button className="ih-btn" aria-current={active ? 'page' : undefined} onClick={onClick} style={{
    padding: '8px 15px', borderRadius: theme.radius.pill,
    background: active ? theme.color.ink : theme.color.surface,
    color: active ? theme.color.onInk : theme.color.text,
  }}>{children}</button>
}
