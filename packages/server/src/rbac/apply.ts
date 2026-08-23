import { sql, type SelectQueryBuilder } from 'kysely'
import type { ScopeFilter } from '@im-hub/shared'
import type { Database } from '../db/types.js'

/**
 * 把 ScopeFilter 施加到任何含 accounts 表的查询上——包括 join 了别的表的查询，
 * 所以泛型不能锁死成 'accounts'，否则 Task 13 里 accounts innerJoin conversations 的调用编译不过。
 *
 * teamIds 为空数组时返回 where false —— 空 IN 列表在部分数据库里会被优化掉，
 * 那会让没带组的 manager 意外看到全量数据。
 */
export function applyAccountScope<DB extends Database, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  scope: ScopeFilter,
): SelectQueryBuilder<DB, TB, O> {
  switch (scope.kind) {
    case 'all':
      return qb
    case 'self':
      return qb.where('accounts.owner_user_id' as never, '=', scope.userId as never)
    case 'teams':
      if (scope.teamIds.length === 0) return qb.where(sql<boolean>`false`)
      return qb.where('accounts.team_id' as never, 'in', scope.teamIds as never)
  }
}
