import { Kysely, sql } from 'kysely'

/**
 * 回填 credentials_ref。
 *
 * 从 P1 起，启动时是否自动重连一个账号，判据从 status 改成了 credentials_ref
 * ——它由适配器在 authorizationStateReady 时写入，精确表示「这个账号在这台
 * 机器上鉴权成功过」，比 status 准（员工在手机上解除设备授权后 status 仍是
 * connected），也比看 TDLib 数据目录存不存在准（目录在鉴权完成前就建好了）。
 *
 * 但在这条规则之前登录成功的账号，credentials_ref 是空的。不回填的话它们
 * 下次重启就会被跳过，等于已经在用的账号凭空掉线，还得重新扫一次码。
 *
 * 判据用 status = 'connected'：在本次改动之前，这个值只可能由一次成功的
 * login() 写入，所以它在这个时间点上确实等价于「本机有可用 session」。
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    update accounts
       set credentials_ref = 'tdlib-session'
     where credentials_ref is null
       and status = 'connected'
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    update accounts
       set credentials_ref = null
     where credentials_ref = 'tdlib-session'
  `.execute(db)
}
