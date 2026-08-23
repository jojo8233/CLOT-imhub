import type { Kysely } from 'kysely'
import type { ScopeFilter } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { applyAccountScope } from './apply.js'

/**
 * 每请求构造一次，把当前 actor 的可见范围闭包进去。
 *
 * 路由层只允许通过它取查询，不允许直接 import db —— 因为 applyAccountScope 在
 * owner/auditor 下是恒等变换，"忘记调用"和"正常调用"产生的 SQL 无法区分，
 * 漏调一次就是静默的全量数据泄露。把过滤前置到这里，忘记就变成不可能。
 */
export class ScopedDb {
  constructor(
    private readonly db: Kysely<Database>,
    /** 供需要写审计日志的调用方判断 requiresAudit（P2 接入） */
    readonly scope: ScopeFilter,
  ) {}

  /** 当前 actor 可见的账号。 */
  accounts() {
    return applyAccountScope(this.db.selectFrom('accounts'), this.scope)
  }

  /**
   * 会话必须先经 accounts 收敛可见范围，所以从 accounts 起手 join，
   * 而不是直接 selectFrom('conversations') —— 后者没有 accounts 表可供过滤。
   */
  accountsJoinedWithConversations() {
    return applyAccountScope(
      this.db.selectFrom('accounts').innerJoin('conversations', 'conversations.account_id', 'accounts.id'),
      this.scope,
    )
  }
}
