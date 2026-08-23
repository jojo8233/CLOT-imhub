import type { FastifyInstance } from 'fastify'

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts', async (req) => {
    // 注意：这里没有 import db，也没有调 applyAccountScope。
    // req.scoped 已经把当前 actor 的可见范围闭包进去了，漏过滤在结构上不可能发生。
    const accounts = await req.scoped.accounts().select([
      'id', 'platform', 'display_name', 'status',
      'owner_user_id', 'team_id', 'history_available_from',
    ]).execute()
    return { accounts }
  })
}
