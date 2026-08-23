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

export const db = createDb()
