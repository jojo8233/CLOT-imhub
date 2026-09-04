import type { Kysely } from 'kysely'
import type { ScopeFilter } from '@im-hub/shared'
import type { Database } from '../db/types.js'
import { applyAccountScope } from './apply.js'
import { ScopedCustomerProfileRepo } from '../customer-profile/repo.js'
import { KeywordRuleRepo } from '../keyword-alert/rule-repo.js'
import { KyselyKeywordAlertScanRepo } from '../keyword-alert/scan-repo.js'
import { ScopedKeywordAlertRepo } from '../keyword-alert/scoped-repo.js'

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
    readonly scope: ScopeFilter,
    private readonly actorUserId: string,
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

  customerProfiles(): ScopedCustomerProfileRepo {
    return new ScopedCustomerProfileRepo(this.db, this.scope)
  }

  keywordRules(): KeywordRuleRepo {
    return new KeywordRuleRepo(this.db, new KyselyKeywordAlertScanRepo(this.db))
  }

  keywordAlerts(): ScopedKeywordAlertRepo {
    return new ScopedKeywordAlertRepo(this.db, this.scope, this.actorUserId)
  }

  /**
   * 更新会话的目标语言锁。Kysely 的 UPDATE 不支持像 SELECT 一样 join 后过滤，
   * 所以这里先用 accountsJoinedWithConversations() 确认会话在当前可见范围内，
   * 再对已确认的 id 执行不带 join 的 UPDATE——db 本身仍是私有字段，不会被路由层拿到。
   *
   * 返回 false 表示会话不存在或不在可见范围内，路由据此回 404。
   */
  async updateConversationTargetLang(conversationId: string, targetLang: string | null): Promise<boolean> {
    const visible = await this.accountsJoinedWithConversations()
      .select('conversations.id as id')
      .where('conversations.id', '=', conversationId)
      .executeTakeFirst()
    if (!visible) return false

    await this.db.updateTable('conversations')
      .set({ target_lang: targetLang })
      .where('id', '=', conversationId)
      .execute()
    return true
  }
}
