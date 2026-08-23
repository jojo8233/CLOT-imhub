import { describe, expect, it } from 'vitest'
import type { Actor } from '@im-hub/shared'
import { resolveScope } from './scope.js'

const base: Omit<Actor, 'role'> = { userId: 'u1', leadTeamIds: [] }

describe('resolveScope', () => {
  it('owner 看全局且不写审计', () => {
    expect(resolveScope({ ...base, role: 'owner' }))
      .toEqual({ kind: 'all', requiresAudit: false })
  })

  it('auditor 看全局但强制写审计', () => {
    expect(resolveScope({ ...base, role: 'auditor' }))
      .toEqual({ kind: 'all', requiresAudit: true })
  })

  it('manager 只看自己带的组', () => {
    expect(resolveScope({ ...base, role: 'manager', leadTeamIds: ['t1', 't2'] }))
      .toEqual({ kind: 'teams', teamIds: ['t1', 't2'], requiresAudit: false })
  })

  it('manager 没带任何组时 teamIds 为空', () => {
    expect(resolveScope({ ...base, role: 'manager', leadTeamIds: [] }))
      .toEqual({ kind: 'teams', teamIds: [], requiresAudit: false })
  })

  it('agent 只看自己', () => {
    expect(resolveScope({ ...base, role: 'agent', userId: 'u9' }))
      .toEqual({ kind: 'self', userId: 'u9', requiresAudit: false })
  })
})
