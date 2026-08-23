import { db } from './client.js'
import { hashPassword } from '../auth/password.js'

/**
 * 幂等 seed：每次运行先清空本脚本管辖的表（按外键依赖倒序删除），
 * 再重新插入固定的演示数据。可以放心重复执行——不会因为唯一约束
 * 报错，也不会因为库里有残留的测试数据（例如 server.test.ts 写入的
 * repo-test@example.com）而失败，因为这些表会被整体清空重建。
 *
 * 五个账号验证的是 RBAC 的可见范围边界：
 *   owner    看全部
 *   auditor  看全部（只读，requiresAudit 语义见 rbac/scope.ts）
 *   manager  只看自己带队（is_lead）的组内账号
 *   agent    只看自己名下的账号
 *   outsider 和 agent 同角色但不在组里，用来证明 agent 之间互相看不到对方
 */

const hash = await hashPassword('dev-password')

// 幂等：先清掉本脚本管辖的数据（按外键依赖倒序）
await db.deleteFrom('message_translations').execute()
await db.deleteFrom('messages').execute()
await db.deleteFrom('conversations').execute()
await db.deleteFrom('accounts').execute()
await db.deleteFrom('team_members').execute()
await db.deleteFrom('users').execute()
await db.deleteFrom('teams').execute()

const team = await db.insertInto('teams')
  .values({ name: '默认组' }).returning('id').executeTakeFirstOrThrow()

const owner = await db.insertInto('users').values({
  email: 'owner@example.com', display_name: '老板', role: 'owner', password_hash: hash,
}).returning('id').executeTakeFirstOrThrow()

const manager = await db.insertInto('users').values({
  email: 'manager@example.com', display_name: '主管', role: 'manager', password_hash: hash,
}).returning('id').executeTakeFirstOrThrow()

const agent = await db.insertInto('users').values({
  email: 'agent@example.com', display_name: '销售一号', role: 'agent', password_hash: hash,
}).returning('id').executeTakeFirstOrThrow()

// 第二个 agent，不属于任何组——用来验证 manager 看不到组外的人
const outsider = await db.insertInto('users').values({
  email: 'outsider@example.com', display_name: '组外销售', role: 'agent', password_hash: hash,
}).returning('id').executeTakeFirstOrThrow()

const auditor = await db.insertInto('users').values({
  email: 'auditor@example.com', display_name: '风控', role: 'auditor', password_hash: hash,
}).returning('id').executeTakeFirstOrThrow()

await db.insertInto('team_members').values([
  { team_id: team.id, user_id: manager.id, is_lead: true },
  { team_id: team.id, user_id: agent.id, is_lead: false },
]).execute()

await db.insertInto('accounts').values([
  { platform: 'telegram', owner_user_id: agent.id, team_id: team.id, display_name: 'TG 组内号', status: 'pending_auth' },
  { platform: 'telegram', owner_user_id: outsider.id, team_id: null, display_name: 'TG 组外号', status: 'pending_auth' },
]).execute()

console.log(`已初始化（密码统一 dev-password）：
  owner@example.com     owner    应看到 2 个账号
  manager@example.com   manager  应看到 1 个（仅组内）
  agent@example.com     agent    应看到 1 个（仅自己的）
  outsider@example.com  agent    应看到 1 个（仅自己的）
  auditor@example.com   auditor  应看到 2 个（全局只读）`)

await db.destroy()
