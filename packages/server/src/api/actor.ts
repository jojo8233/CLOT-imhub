import type { Actor, Role } from '@im-hub/shared'

export interface ActorRepo {
  findUser(userId: string): Promise<{ id: string; role: Role; disabled_at: Date | null } | null>
  findMemberships(userId: string): Promise<{ team_id: string; is_lead: boolean }[]>
}

/**
 * 把 JWT 里的 userId 还原成带完整组关系的 Actor。
 *
 * 角色每请求从数据库重读，绝不信 token 里的副本——管理员改了权限之后，
 * 旧 token 里的角色会继续有效到过期，那是提权漏洞。
 *
 * leadTeamIds 只对 manager 生效：其他角色即使在 team_members 里被误标了
 * is_lead 也不给，免得一行脏数据把 agent 提权成组长。
 */
export async function loadActor(userId: string, repo: ActorRepo): Promise<Actor> {
  const user = await repo.findUser(userId)
  if (!user) throw new Error('user not found')
  if (user.disabled_at) throw new Error('user is disabled')

  const leadTeamIds =
    user.role === 'manager'
      ? (await repo.findMemberships(userId)).filter((m) => m.is_lead).map((m) => m.team_id)
      : []

  return { userId: user.id, role: user.role, leadTeamIds }
}
