/**
 * 测试专用数据库连接。
 *
 * 测试必须跑在独立的库上：repo.test.ts 的 beforeEach 会 truncate 所有表来保证
 * 每个用例从干净状态开始，如果它连的是开发库，跑一次测试就会清空开发数据
 * ——包括已登录账号的记录，导致 TDLib 的磁盘 session 变成孤儿。
 *
 * 库名固定为 <开发库名>_test，不从环境变量读，避免有人不小心把它指回开发库。
 */
export function testDatabaseUrl(): string {
  const dev = process.env.DATABASE_URL ?? 'postgres://imhub:imhub_dev@localhost:5432/imhub'
  const url = new URL(dev)
  const name = url.pathname.replace(/^\//, '')
  if (name.endsWith('_test')) return dev
  url.pathname = `/${name}_test`
  return url.toString()
}
