import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ACCOUNT_CONNECTION_MODES,
  PLATFORMS,
  type AccountCreationContext,
  type Actor,
} from '@im-hub/shared'
import { db } from '../../db/client.js'
import type { AdapterManager } from '../../adapters/manager.js'

/** 已有可用适配器或受控原生壳的平台；没实现的平台建了也连不上，直接挡在门口。 */
const IMPLEMENTED = new Set(['telegram', 'signal', 'whatsapp'])

const createBody = z.object({
  platform: z.enum(PLATFORMS),
  displayName: z.string().trim().min(1, '账号名称不能为空').max(60, '账号名称最长 60 个字'),
  connectionMode: z.enum(ACCOUNT_CONNECTION_MODES).optional(),
  teamId: z.string().uuid().nullable().optional(),
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

const renameBody = z.object({
  displayName: z.string().trim().min(1, '账号名称不能为空').max(60, '账号名称最长 60 个字'),
})

const deleteBody = z.object({
  /**
   * 必须原样重打一遍账号名才放行。
   *
   * 删账号会级联删掉它下面所有会话和消息——可能是几千条真实的客户聊天记录，
   * 而且没有回收站。一个"确定吗"的弹窗挡不住手滑，让人把名字打一遍能。
   */
  confirmName: z.string(),
})

export interface AccountRouteDeps {
  adapters: AdapterManager
}

export async function accountRoutes(app: FastifyInstance, deps: AccountRouteDeps): Promise<void> {
  app.get('/api/accounts', async (req) => {
    // 注意：这里没有 import db，也没有调 applyAccountScope。
    // req.scoped 已经把当前 actor 的可见范围闭包进去了，漏过滤在结构上不可能发生。
    const accounts = await req.scoped.accounts().select([
      'id', 'platform', 'display_name', 'status',
      'owner_user_id', 'team_id', 'history_available_from', 'connection_mode',
    ]).execute()
    return { accounts }
  })

  app.get('/api/account-creation-context', async (req, reply) => {
    const context = await accountCreationContext(req.actor)
    if (!context) return reply.code(403).send({ error: '风控账号是只读的，不能创建平台账号' })
    return context
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
    const connectionMode = parsed.data.connectionMode
      ?? (platform === 'whatsapp' ? 'web_shell' : 'adapter')

    if (!IMPLEMENTED.has(platform)) {
      return reply.code(400).send({ error: `${platform} 的适配器还没接入，暂时建不了` })
    }
    if (connectionMode === 'cloud_api') {
      return reply.code(400).send({
        error: 'WhatsApp Business Platform 尚未配置，当前不能创建 Cloud API 账号',
      })
    }
    const validConnectionMode = (platform === 'telegram' && connectionMode === 'adapter')
      || (platform === 'signal'
        && (connectionMode === 'adapter' || connectionMode === 'native_desktop'))
      || (platform === 'whatsapp'
        && (connectionMode === 'adapter' || connectionMode === 'web_shell'))
    if (!validConnectionMode) {
      return reply.code(400).send({ error: `${platform} 不支持 ${connectionMode} 账号模式` })
    }

    const team = await resolveCreationTeam(req.actor, parsed.data.teamId)
    if (team.kind === 'invalid') return reply.code(400).send({ error: team.error })

    const account = await db.insertInto('accounts')
      .values({
        platform,
        owner_user_id: req.actor.userId,
        team_id: team.teamId,
        display_name: displayName,
        status: 'pending_auth',
        connection_mode: connectionMode,
      })
      .returning([
        'id', 'platform', 'display_name', 'status', 'owner_user_id', 'team_id',
        'history_available_from', 'connection_mode',
      ])
      .executeTakeFirstOrThrow()

    if (connectionMode === 'adapter') {
      // 不 await：鉴权要等人扫码，可能挂几分钟。接口立刻返回，二维码随后经
      // WebSocket 推过来。connect() 本身也已经改成建完 client 就返回了。
      void deps.adapters.connect(platform, {
        id: account.id,
        displayName: account.display_name,
        credentialsRef: null,
      }).catch((err: unknown) => {
        console.error(`[accounts] 账号 ${account.id} 启动鉴权失败:`, err)
      })
    }

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
    if (account.connection_mode === 'native_desktop') {
      return reply.code(409).send({ error: 'Signal 原生账号请直接在 Signal Desktop 中重新关联' })
    }
    if (account.connection_mode === 'web_shell') {
      return reply.code(409).send({ error: 'WhatsApp Web 账号请直接在官方页面中重新关联' })
    }
    if (account.connection_mode === 'cloud_api') {
      return reply.code(409).send({ error: 'WhatsApp Cloud API 账号请通过官方重新授权流程关联' })
    }
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
  /**
   * 改名。纯展示字段，不影响任何平台侧状态，所以放宽到"看得见就能改"：
   * 管理员帮下属把一个建错名字的账号改过来是合理的。
   */
  app.patch('/api/accounts/:id', async (req, reply) => {
    if (req.actor.role === 'auditor') {
      return reply.code(403).send({ error: '风控账号是只读的' })
    }
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '账号 id 不合法' })

    const parsed = renameBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数不合法' })
    }

    // 经 scoped 确认可见，再按 id 更新——看不见的账号连存在与否都不该暴露
    const visible = await req.scoped.accounts().select('id').where('accounts.id', '=', params.data.id).executeTakeFirst()
    if (!visible) return reply.code(404).send({ error: '账号不存在或你看不到它' })

    const row = await db.updateTable('accounts')
      .set({ display_name: parsed.data.displayName })
      .where('id', '=', params.data.id)
      .returning([
        'id', 'platform', 'display_name', 'status', 'owner_user_id', 'team_id',
        'history_available_from', 'connection_mode',
      ])
      .executeTakeFirstOrThrow()
    return { account: row }
  })

  /**
   * 删除账号。
   *
   * 三件事必须一起做完，缺一件都会留下烂摊子：
   *   1. 清掉平台侧在本机的数据（session / 本地账号数据）
   *   2. 删数据库行（会话与消息随外键级联消失）
   *   3. 把"平台上可能还留着一个已关联设备"这件事告诉用户
   *
   * 只做 2 的话，平台侧还连着但库里没有对应账号，消息收进来无处安放只能丢弃
   * ——这个坑刚踩过一次，表现是「扫码明明成功了却一条消息都没有」。
   */
  app.delete('/api/accounts/:id', async (req, reply) => {
    const params = idParam.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: '账号 id 不合法' })

    const parsed = deleteBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

    // 删除限 owner 本人：这是不可逆操作，且会带走该账号下全部客户消息
    const account = await requireOwnedAccount(req.actor.userId, params.data.id)
    if (!account) return reply.code(404).send({ error: '账号不存在或不属于你' })

    if (parsed.data.confirmName !== account.display_name) {
      return reply.code(400).send({ error: '账号名称不匹配，请原样输入以确认删除' })
    }

    const counts = await db.selectFrom('messages')
      .select(db.fn.countAll<string>().as('n'))
      .where('account_id', '=', account.id)
      .executeTakeFirstOrThrow()

    if (account.connection_mode === 'adapter') {
      // 先清适配器数据。这一步失败就中止——宁可什么都没删，也不要删一半。
      // native_desktop 的 profile 与 web_shell 的 partition 归桌面主进程管理，
      // 服务端不能误删平台本地数据。cloud_api 未来必须走单独的授权撤销流程。
      try {
        await deps.adapters.purge(account.platform, account.id)
      } catch (err) {
        console.error(`[accounts] 账号 ${account.id} 清除平台数据失败，已中止删除:`, err)
        return reply.code(500).send({ error: '清除平台数据失败，账号未删除。请查看服务端日志' })
      }
    }

    await db.deleteFrom('accounts').where('id', '=', account.id).execute()

    return {
      ok: true,
      deletedMessages: Number(counts.n),
      /** 平台侧可能仍留着一个已关联设备，需要用户自己去移除 */
      manualCleanup: account.platform === 'signal'
        ? '请到手机 Signal 的「设置 → 已关联设备」里移除这台设备'
        : account.platform === 'whatsapp'
          ? account.connection_mode === 'cloud_api'
            ? '请在 Meta Business 中确认该 WhatsApp Business Platform 授权已经撤销'
            : '请到手机 WhatsApp 的「设置 → 已关联设备」里移除这个浏览器会话'
          : null,
    }
  })

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
    if (account.connection_mode !== 'adapter') {
      return reply.code(409).send({ error: '该账号模式不接受服务端验证码或密码' })
    }

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

type CreationTeamResult =
  | { kind: 'selected'; teamId: string | null }
  | { kind: 'invalid'; error: string }

async function accountCreationContext(actor: Actor): Promise<AccountCreationContext | null> {
  switch (actor.role) {
    case 'owner':
      return {
        selectableTeams: await enabledTeams(),
        requiresTeamSelection: false,
        allowsUngrouped: true,
      }
    case 'manager':
      return {
        selectableTeams: await enabledTeams(actor.leadTeamIds),
        requiresTeamSelection: true,
        allowsUngrouped: false,
      }
    case 'agent': {
      const teams = await activeAgentTeams(actor.userId)
      return {
        selectableTeams: teams,
        requiresTeamSelection: false,
        allowsUngrouped: teams.length === 0,
      }
    }
    case 'auditor':
      return null
  }
}

async function resolveCreationTeam(
  actor: Actor,
  requestedTeamId: string | null | undefined,
): Promise<CreationTeamResult> {
  switch (actor.role) {
    case 'owner': {
      if (requestedTeamId === null || requestedTeamId === undefined) {
        return { kind: 'selected', teamId: null }
      }
      const teams = await enabledTeams([requestedTeamId])
      return teams.length === 1
        ? { kind: 'selected', teamId: requestedTeamId }
        : { kind: 'invalid', error: '所选团队不存在或已归档' }
    }
    case 'manager': {
      if (!requestedTeamId) {
        return { kind: 'invalid', error: '组长创建账号时必须选择自己负责的团队' }
      }
      if (!actor.leadTeamIds.includes(requestedTeamId)) {
        return { kind: 'invalid', error: '只能选择自己负责的团队' }
      }
      const teams = await enabledTeams([requestedTeamId])
      return teams.length === 1
        ? { kind: 'selected', teamId: requestedTeamId }
        : { kind: 'invalid', error: '所选团队不存在或已归档' }
    }
    case 'agent': {
      const teams = await activeAgentTeams(actor.userId)
      if (teams.length > 1) {
        return { kind: 'invalid', error: '员工同时属于多个启用团队，请先联系管理员修复组织关系' }
      }
      return { kind: 'selected', teamId: teams[0]?.id ?? null }
    }
    case 'auditor':
      return { kind: 'invalid', error: '风控账号是只读的，不能创建平台账号' }
  }
}

async function enabledTeams(teamIds?: string[]): Promise<Array<{ id: string; name: string }>> {
  if (teamIds?.length === 0) return []

  let query = db.selectFrom('teams')
    .select(['id', 'name'])
    .where('disabled_at', 'is', null)
  if (teamIds) query = query.where('id', 'in', teamIds)
  return query.orderBy('name').orderBy('id').execute()
}

async function activeAgentTeams(userId: string): Promise<Array<{ id: string; name: string }>> {
  return db.selectFrom('team_members as member')
    .innerJoin('teams as team', 'team.id', 'member.team_id')
    .select(['team.id as id', 'team.name as name'])
    .where('member.user_id', '=', userId)
    .where('member.is_lead', '=', false)
    .where('team.disabled_at', 'is', null)
    .orderBy('team.name')
    .orderBy('team.id')
    .execute()
}

/**
 * 按 owner 而不是按可见范围取账号。
 *
 * 这里刻意不走 req.scoped：scoped 的语义是"能看见"，而关联操作要求的是
 * "是本人的"。用 scoped 会让 owner/manager 能对下属账号发起关联和提交密码。
 */
async function requireOwnedAccount(userId: string, accountId: string) {
  const row = await db.selectFrom('accounts')
    .select(['id', 'platform', 'display_name', 'status', 'credentials_ref', 'connection_mode'])
    .where('id', '=', accountId)
    .where('owner_user_id', '=', userId)
    .executeTakeFirst()
  return row ?? null
}
