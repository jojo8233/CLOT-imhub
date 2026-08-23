import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { config } from '../config.js'
import type { Database } from './types.js'

export function createDb(connectionString = config.DATABASE_URL): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 10 }),
    }),
  })
}

/**
 * 组合根专用的单例。业务逻辑模块请通过构造函数接收 Kysely<Database>，
 * 不要直接 import 它——否则单元测试会因为缺 DATABASE_URL 在模块加载期就崩。
 */
export const db = createDb()
