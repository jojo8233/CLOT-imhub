export const ROLES = ['owner', 'auditor', 'manager', 'agent'] as const
export type Role = (typeof ROLES)[number]

export interface Actor {
  userId: string
  role: Role
  /** manager 作为组长带的 team id 列表；其他角色为空数组 */
  leadTeamIds: string[]
  /** agent 所属的 team；其他角色可为 null */
  teamId: string | null
}

export type ScopeFilter =
  | { kind: 'all'; requiresAudit: boolean }
  | { kind: 'teams'; teamIds: string[]; requiresAudit: false }
  | { kind: 'self'; userId: string; requiresAudit: false }
