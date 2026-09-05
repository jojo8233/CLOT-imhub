import { describe, expect, it } from 'vitest'
import type { AccountCreationContext } from '@im-hub/shared'
import { accountCreationInputForRole, initialCreationTeam } from './AddAccountDialog.js'

const base = { platform: 'telegram', displayName: 'Sales', connectionMode: 'adapter' as const }

describe('AddAccountDialog organization scope', () => {
  it('agent 请求不提交 teamId，manager/owner 才提交所选团队', () => {
    expect(accountCreationInputForRole(base, 'agent', 'team-a')).toEqual(base)
    expect(accountCreationInputForRole(base, 'manager', 'team-a')).toEqual({ ...base, teamId: 'team-a' })
    expect(accountCreationInputForRole(base, 'owner', null)).toEqual({ ...base, teamId: null })
    expect(accountCreationInputForRole(base, 'auditor', 'team-a')).toEqual(base)
    expect(accountCreationInputForRole(base, 'owner', null)).not.toHaveProperty('owner_user_id')
  })

  it('必须选团队时默认首个可选团队，owner 允许未分组时默认未分组', () => {
    const required: AccountCreationContext = {
      selectableTeams: [{ id: 'team-a', name: 'Sales' }],
      requiresTeamSelection: true,
      allowsUngrouped: false,
    }
    expect(initialCreationTeam('manager', required)).toBe('team-a')
    expect(initialCreationTeam('owner', { ...required, requiresTeamSelection: false, allowsUngrouped: true })).toBeNull()
    expect(initialCreationTeam('agent', required)).toBeNull()
  })
})
