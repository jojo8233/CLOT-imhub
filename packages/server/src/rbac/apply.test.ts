import { describe, expect, it } from 'vitest'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import type { Database } from '../db/types.js'
import { applyAccountScope } from './apply.js'

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

const base = db.selectFrom('accounts').selectAll()

describe('applyAccountScope', () => {
  it('all 不加任何过滤条件', () => {
    const { sql } = applyAccountScope(base, { kind: 'all', requiresAudit: false }).compile()
    expect(sql).not.toContain('where')
  })

  it('self 按 owner_user_id 过滤', () => {
    const q = applyAccountScope(base, { kind: 'self', userId: 'u9', requiresAudit: false }).compile()
    expect(q.sql).toContain('"owner_user_id" = $1')
    expect(q.parameters).toEqual(['u9'])
  })

  it('teams 按 team_id in 过滤', () => {
    const q = applyAccountScope(base, { kind: 'teams', teamIds: ['t1', 't2'], requiresAudit: false }).compile()
    expect(q.sql).toContain('"team_id" in')
    expect(q.parameters).toEqual(['t1', 't2'])
  })

  it('teams 为空时必须查不出任何数据，而不是退化成全量', () => {
    const q = applyAccountScope(base, { kind: 'teams', teamIds: [], requiresAudit: false }).compile()
    expect(q.sql).toContain('where false')
  })
})
