import { describe, expect, it } from 'vitest'
import type { Actor } from '@im-hub/shared'
import { resolveScope } from './scope.js'

const base: Omit<Actor, 'role'> = { userId: 'u1', leadTeamIds: [] }

describe('resolveScope', () => {
  it('owner 看全局', () => {
    expect(resolveScope({ ...base, role: 'owner' }))
      .toEqual({ kind: 'all' })
  })

  it('auditor 保持全局可见', () => {
    expect(resolveScope({ ...base, role: 'auditor' }))
      .toEqual({ kind: 'all' })
  })

  it('manager 只看自己带的组', () => {
    expect(resolveScope({ ...base, role: 'manager', leadTeamIds: ['t1', 't2'] }))
      .toEqual({ kind: 'teams', teamIds: ['t1', 't2'] })
  })

  it('manager 没带任何组时 teamIds 为空', () => {
    expect(resolveScope({ ...base, role: 'manager', leadTeamIds: [] }))
      .toEqual({ kind: 'teams', teamIds: [] })
  })

  it('agent 只看自己', () => {
    expect(resolveScope({ ...base, role: 'agent', userId: 'u9' }))
      .toEqual({ kind: 'self', userId: 'u9' })
  })
})
