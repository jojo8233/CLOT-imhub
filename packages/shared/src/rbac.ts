export const ROLES = ['owner', 'auditor', 'manager', 'agent'] as const
export type Role = (typeof ROLES)[number]

export interface Actor {
  userId: string
  role: Role
  /**
   * manager 作为组长带的 team id 列表；其他角色恒为空数组。
   * 这是 manager 可见范围的唯一依据，见 resolveScope。
   *
   * 必须每请求从 team_members 实时查出。不要缓存进 JWT——
   * 那样被解除组长身份的人在 token 过期前仍能看到该组的会话。
   */
  leadTeamIds: string[]
}

export type ScopeFilter =
  | { kind: 'all' }
  | { kind: 'teams'; teamIds: string[] }
  | { kind: 'self'; userId: string }
