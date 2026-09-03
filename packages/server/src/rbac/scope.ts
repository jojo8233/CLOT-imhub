import type { Actor, ScopeFilter } from '@im-hub/shared'

/**
 * 把角色翻译成数据可见范围。这是整个系统的安全边界，
 * 任何读取业务数据的查询都必须经过它。
 */
export function resolveScope(actor: Actor): ScopeFilter {
  switch (actor.role) {
    case 'owner':
      return { kind: 'all' }
    case 'auditor':
      return { kind: 'all' }
    case 'manager':
      return { kind: 'teams', teamIds: actor.leadTeamIds }
    case 'agent':
      return { kind: 'self', userId: actor.userId }
  }
}
