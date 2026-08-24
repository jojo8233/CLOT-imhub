import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PLATFORMS } from '@im-hub/shared'
import { db } from '../../db/client.js'
import type { AdapterManager } from '../../adapters/manager.js'

/** 已经有可用适配器实现的平台。没实现的平台建了也连不上，直接挡在门口 */
const IMPLEMENTED = new Set(['telegram', 'signal'])

const createBody = z.object({
  platform: z.enum(PLATFORMS),
  displayName: z.string().trim().min(1, '账号名称不能为空').max(60, '账号名称最长 60 个字'),
})

const answerBody = z.object({
  /**
   * 验证码或二次验证密码。
   *
   * 这个值全程只在内存里流动：不落库、不写日志、不进任何错误信息。
   * 加长度上限是为了挡住把整个文件当密码贴进来这类误用。
   */
  value: z.string().min(1).max(256),
})

const idParam = z.object({ id: z.string().uuid() })

export interface AccountRouteDeps {
  adapters: AdapterManager
}

export async function accountRoutes(app: FastifyInstance, deps: AccountRouteDeps): Promise<void> {
  app.get('/api/accounts', async (req) => {
    // 注意：这里没有 import db，也没有调 applyAccountScope。
    // req.scoped 已经把当前 actor 的可见范围闭包进去了，漏过滤在结构上不可能发生。
    const accounts = await req.scoped.accounts().select([
      'id', 'platform', 'display_name', 'status',
      'owner_user_id', 'team_id', 'history_available_from',
    ]).execute()
    return { accounts }
  })

  /**
   * 新建一个平台账号并立即开始鉴权。
   *
   * owner_user_id 强制取自 token，不接受请求体指定——否则任何登录用户都能把
   * 账号挂到别人名下，或者反过来把别人的账号"认领"过来。
   */
  app.post('/api/accounts', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的，不能创建平台账号' })
    }

    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
    }
    const { platform, displayName } = parsed.data

    if (!IMPLEMENTED.has(platform)) {
      return reply.code(400).send({ error: `${platform} 的适配器还没接入，暂时建不了` })
    }

    // 账号归属跟着创建者走：他在哪个组，账号就属于哪个组，管理员才看得见。
    // 不在任何组的人建的账号 team_id 为 null，只有他自己和 owner/auditor 看得到。
    const membership = await db.selectFrom('team_members')
      .select('team_id')
      .where('user_id', '=', req.actor.userId)
      .orderBy('is_lead', 'desc')
      .executeTakeFirst()

    const account = await db.insertInto('accounts')
      .values({
        platform,
        owner_user_id: req.actor.userId,
        team_id: membership?.team_id ?? null,
        display_name: displayName,
        status: 'pending_auth',
      })
      .returning(['id', 'platform', 'display_name', 'status', 'owner_user_id', 'team_id', 'history_available_from'])
      .executeTakeFirstOrThrow()

    // 不 await：鉴权要等人扫码，可能挂几分钟。接口立刻返回，二维码随后经
    // WebSocket 推过来。connect() 本身也已经改成建完 client 就返回了。
    void deps.adapters.connect(platform, {
      id: account.id,
      displayName: account.display_name,
      credentialsRef: null,
    }).catch((err: unknown) => {
      console.error(`[accounts] 账号 ${account.id} 启动鉴权失败:`, err)
    })

    return reply.code(201).send({ account })
  })

  /**
   * 重新发起关联。二维码过期后关掉了弹窗、或者上一轮扫到一半放弃了，走这里重来。
   *
   * 只对没连上的账号开放：已经在线的账号断开重连会让正在进行的会话掉线，
   * 而这个接口的语义是"重新扫码"，不是"重启连接"。
   */
  app.post('/api/accounts/:id/relink', async (req, reply) => {
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '账号 id 不合法' })

    const account = await requireOwnedAccount(req.actor.userId, params.data.id)
    if (!account) return reply.code(404).send({ error: '账号不存在或不属于你' })
    if (account.status === 'connected') {
      return reply.code(409).send({ error: '账号已经在线，不需要重新关联' })
    }

    // 先断开再连，才能让 TDLib 重新走一遍鉴权、下发新的二维码
    await deps.adapters.disconnect(account.id).catch(() => { /* 本来就没连上 */ })
    void deps.adapters.connect(account.platform, {
      id: account.id,
      displayName: account.display_name,
      credentialsRef: account.credentials_ref,
    }).catch((err: unknown) => {
      console.error(`[accounts] 账号 ${account.id} 重新关联失败:`, err)
    })

    return { ok: true }
  })

  /**
   * 提交验证码或二次验证密码。
   *
   * 严格限定 owner 本人：管理员能看见下属的账号，但不该代替下属输入他的
   * 二次验证密码——那等于管理员可以拿走一个他能看见的任意账号。
   */
  app.post('/api/accounts/:id/auth-answer', async (req, reply) => {
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '账号 id 不合法' })

    const parsed = answerBody.safeParse(req.body)
    if (!parsed.success) {
      // 刻意不回显 issue 里的内容：zod 的报错会把收到的值带出来
      return reply.code(400).send({ error: '内容不合法' })
    }

    const account = await requireOwnedAccount(req.actor.userId, params.data.id)
    if (!account) return reply.code(404).send({ error: '账号不存在或不属于你' })

    try {
      await deps.adapters.submitAuthAnswer(account.id, parsed.data.value)
    } catch (err) {
      // err 来自适配器，不含用户输入；但仍然只回一句概括，不把内部细节抛给前端
      console.error(`[accounts] 账号 ${account.id} 提交鉴权输入失败:`, err)
      return reply.code(409).send({ error: '当前没有在等待输入，请重新发起关联' })
    }
    return { ok: true }
  })
}

/**
 * 按 owner 而不是按可见范围取账号。
 *
 * 这里刻意不走 req.scoped：scoped 的语义是"能看见"，而关联操作要求的是
 * "是本人的"。用 scoped 会让 owner/manager 能对下属账号发起关联和提交密码。
 */
async function requireOwnedAccount(userId: string, accountId: string) {
  const row = await db.selectFrom('accounts')
    .select(['id', 'platform', 'display_name', 'status', 'credentials_ref'])
    .where('id', '=', accountId)
    .where('owner_user_id', '=', userId)
    .executeTakeFirst()
  return row ?? null
}
