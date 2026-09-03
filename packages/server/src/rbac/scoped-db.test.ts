import { describe, expect, it } from 'vitest'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { Database } from '../db/types.js'
import { ScopedCustomerProfileRepo } from '../customer-profile/repo.js'
import { KeywordRuleRepo } from '../keyword-alert/rule-repo.js'
import { ScopedDb } from './scoped-db.js'

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

describe('ScopedDb', () => {
  it('accounts() 已经带上 agent 的过滤条件', () => {
    const scoped = new ScopedDb(db, { kind: 'self', userId: 'u9' })
    const q = scoped.accounts().selectAll().compile()
    expect(q.sql).toContain('"owner_user_id" = $1')
    expect(q.parameters).toEqual(['u9'])
  })

  it('accountsJoinedWithConversations() 也带上过滤条件', () => {
    const scoped = new ScopedDb(db, { kind: 'self', userId: 'u9' })
    const q = scoped.accountsJoinedWithConversations().selectAll().compile()
    expect(q.sql).toContain('inner join "conversations"')
    expect(q.sql).toContain('"owner_user_id" = $1')
  })

  it('manager 的两个入口都按 team 过滤', () => {
    const scoped = new ScopedDb(db, { kind: 'teams', teamIds: ['t1'] })
    expect(scoped.accounts().selectAll().compile().sql).toContain('"team_id" in')
    expect(scoped.accountsJoinedWithConversations().selectAll().compile().sql).toContain('"team_id" in')
  })

  it('没带组的 manager 从任何入口拿到的都是 where false', () => {
    const scoped = new ScopedDb(db, { kind: 'teams', teamIds: [] })
    expect(scoped.accounts().selectAll().compile().sql).toContain('where false')
    expect(scoped.accountsJoinedWithConversations().selectAll().compile().sql).toContain('where false')
  })

  it('owner 不加过滤条件', () => {
    const scoped = new ScopedDb(db, { kind: 'all' })
    expect(scoped.accounts().selectAll().compile().sql).not.toContain('where')
  })

  it('暴露当前 scope 供聚焦仓储复用', () => {
    const scope = { kind: 'all' } as const
    expect(new ScopedDb(db, scope).scope).toEqual(scope)
  })

  it('customerProfiles() 返回闭包当前 scope 的聚焦仓储', () => {
    const scoped = new ScopedDb(db, { kind: 'self', userId: 'u9' })
    expect(scoped.customerProfiles()).toBeInstanceOf(ScopedCustomerProfileRepo)
  })

  it('keywordRules() 返回使用同一私有数据库的规则仓储', () => {
    const scoped = new ScopedDb(db, { kind: 'all' })
    expect(scoped.keywordRules()).toBeInstanceOf(KeywordRuleRepo)
  })
})
