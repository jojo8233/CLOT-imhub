import { db } from './client.js'
import { hashPassword } from '../auth/password.js'

/**
 * 幂等 seed：缺什么补什么，已存在的一律保留原有主键。
 *
 * 为什么不能"先清空再重建"：accounts.id 是 TDLib session 目录名的一部分
 * （data/tdlib/<accountId>/）。重建会生成新 UUID，磁盘上那份仍然有效的
 * 登录凭据就成了孤儿，已登录的 Telegram 账号凭空掉线，必须重新扫码。
 * 这个坑踩过两次，所以现在改成 upsert。
 *
 * 想要真正的干净重来，用 reset-account 脚本（它会连 session 一起清），
 * 或者手工 drop schema 后重跑 migration。
 *
 * 五个账号验证的是 RBAC 的可见范围边界：
 *   owner    看全部
 *   auditor  看全部（只读）
 *   manager  只看自己带队（is_lead）的组内账号
 *   agent    只看自己名下的账号
 *   outsider 和 agent 同角色但不在组里，用来证明 agent 之间互相看不到对方
 */

const hash = await hashPassword('dev-password')

async function upsertUser(
  email: string,
  displayName: string,
  role: 'owner' | 'auditor' | 'manager' | 'agent',
): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ email, display_name: displayName, role, password_hash: hash })
    // 已存在就只更新展示信息，不动 id、不重置密码哈希之外的东西
    .onConflict((oc) => oc.column('email').doUpdateSet({ display_name: displayName, role }))
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function findOrCreateTeam(name: string): Promise<string> {
  const existing = await db.selectFrom('teams').select('id').where('name', '=', name).executeTakeFirst()
  if (existing) return existing.id
  const row = await db.insertInto('teams').values({ name }).returning('id').executeTakeFirstOrThrow()
  return row.id
}

/** 按 display_name 认账号。已存在则原样保留 id——TDLib session 目录靠它对齐。 */
async function findOrCreateAccount(
  displayName: string,
  ownerUserId: string,
  teamId: string | null,
): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .selectFrom('accounts')
    .select('id')
    .where('display_name', '=', displayName)
    .executeTakeFirst()
  if (existing) {
    await db
      .updateTable('accounts')
      .set({ owner_user_id: ownerUserId, team_id: teamId })
      .where('id', '=', existing.id)
      .execute()
    return { id: existing.id, created: false }
  }

  const row = await db
    .insertInto('accounts')
    .values({
      platform: 'telegram',
      owner_user_id: ownerUserId,
      team_id: teamId,
      display_name: displayName,
      status: 'pending_auth',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { id: row.id, created: true }
}

const team = await findOrCreateTeam('默认组')

const owner = await upsertUser('owner@example.com', '老板', 'owner')
const manager = await upsertUser('manager@example.com', '主管', 'manager')
const agent = await upsertUser('agent@example.com', '销售一号', 'agent')
const outsider = await upsertUser('outsider@example.com', '组外销售', 'agent')
const auditor = await upsertUser('auditor@example.com', '风控', 'auditor')

for (const [userId, isLead] of [
  [manager, true],
  [agent, false],
] as const) {
  await db
    .insertInto('team_members')
    .values({ team_id: team, user_id: userId, is_lead: isLead })
    .onConflict((oc) => oc.columns(['user_id', 'team_id']).doUpdateSet({ is_lead: isLead }))
    .execute()
}

const inTeam = await findOrCreateAccount('TG 组内号', agent, team)
const outTeam = await findOrCreateAccount('TG 组外号', outsider, null)

console.log(`seed 完成（密码统一 dev-password）：
  owner@example.com     owner    应看到 2 个账号
  manager@example.com   manager  应看到 1 个（仅组内）
  agent@example.com     agent    应看到 1 个（仅自己的）
  outsider@example.com  agent    应看到 1 个（仅自己的）
  auditor@example.com   auditor  应看到 2 个（全局只读）

平台账号（id 已保留，TDLib 登录状态不受影响）：
  TG 组内号  ${inTeam.id}  ${inTeam.created ? '新建' : '沿用已有'}
  TG 组外号  ${outTeam.id}  ${outTeam.created ? '新建' : '沿用已有'}`)

void auditor
await db.destroy()
