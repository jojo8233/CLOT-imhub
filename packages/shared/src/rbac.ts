export const ROLES = ['owner', 'auditor', 'manager', 'agent'] as const
export type Role = (typeof ROLES)[number]

export interface Actor {
  userId: string
  role: Role
  /**
   * manager 作为组长带的 team id 列表；其他角色恒为空数组。
   * 这是 manager 可见范围的唯一依据，见 resolveScope。
   */
  leadTeamIds: string[]
}

export type ScopeFilter =
  | { kind: 'all'; requiresAudit: boolean }
  | { kind: 'teams'; teamIds: string[]; requiresAudit: false }
  | { kind: 'self'; userId: string; requiresAudit: false }
