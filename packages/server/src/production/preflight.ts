import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Redis from 'ioredis'
import { Migrator, sql, type Kysely } from 'kysely'
import { createMigrationProvider } from '../db/migration-provider.js'
import type { Database } from '../db/types.js'

export type ProductionPreflightStatus = 'ok' | 'missing'

export interface ProductionPreflightConfig {
  APP_ENV: 'development' | 'test' | 'production'
  DEEPL_API_KEY: string
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  TELEGRAM_API_ID: number
  TELEGRAM_API_HASH: string
  WHATSAPP_CLOUD_ENABLED: boolean
  ORGANIZATION_ADMIN_WRITES_ENABLED: boolean
}

export interface ProductionPreflightDependencies {
  database(): Promise<unknown>
  redis(): Promise<unknown>
  migrations(): Promise<boolean>
}

export interface ProductionPreflightResult {
  productionMode: ProductionPreflightStatus
  database: ProductionPreflightStatus
  redis: ProductionPreflightStatus
  migrations: ProductionPreflightStatus
  deepl: ProductionPreflightStatus
  claude: ProductionPreflightStatus
  openai: ProductionPreflightStatus
  telegram: ProductionPreflightStatus
  whatsappCloudDisabled: ProductionPreflightStatus
  organizationAdminWrites: ProductionPreflightStatus
}

const CHECK_NAMES: ReadonlyArray<keyof ProductionPreflightResult> = [
  'productionMode',
  'database',
  'redis',
  'migrations',
  'deepl',
  'claude',
  'openai',
  'telegram',
  'whatsappCloudDisabled',
  'organizationAdminWrites',
]

function configured(value: string): ProductionPreflightStatus {
  return value.trim() === '' ? 'missing' : 'ok'
}

async function dependencyStatus(
  check: () => Promise<unknown>,
): Promise<ProductionPreflightStatus> {
  try {
    await check()
    return 'ok'
  } catch {
    return 'missing'
  }
}

async function migrationStatus(
  check: () => Promise<boolean>,
): Promise<ProductionPreflightStatus> {
  try {
    return await check() ? 'ok' : 'missing'
  } catch {
    return 'missing'
  }
}

export async function runProductionPreflight(
  config: ProductionPreflightConfig,
  dependencies: ProductionPreflightDependencies,
): Promise<ProductionPreflightResult> {
  const [database, redis, migrations] = await Promise.all([
    dependencyStatus(dependencies.database),
    dependencyStatus(dependencies.redis),
    migrationStatus(dependencies.migrations),
  ])

  return {
    productionMode: config.APP_ENV === 'production' ? 'ok' : 'missing',
    database,
    redis,
    migrations,
    deepl: configured(config.DEEPL_API_KEY),
    claude: configured(config.ANTHROPIC_API_KEY),
    openai: configured(config.OPENAI_API_KEY),
    telegram: Number.isInteger(config.TELEGRAM_API_ID)
      && config.TELEGRAM_API_ID > 0
      && config.TELEGRAM_API_HASH.trim() !== ''
      ? 'ok'
      : 'missing',
    whatsappCloudDisabled: config.WHATSAPP_CLOUD_ENABLED ? 'missing' : 'ok',
    organizationAdminWrites: config.ORGANIZATION_ADMIN_WRITES_ENABLED ? 'ok' : 'missing',
  }
}

export function isProductionPreflightReady(result: ProductionPreflightResult): boolean {
  return CHECK_NAMES.every(name => result[name] === 'ok')
}

export function formatProductionPreflight(result: ProductionPreflightResult): string {
  return `${CHECK_NAMES.map(name => `${name}=${result[name]}`).join('\n')}\n`
}

export interface RedisPingClient {
  ping(): Promise<string>
}

export function createProductionPreflightDependencies(
  db: Kysely<Database>,
  redis: RedisPingClient,
): ProductionPreflightDependencies {
  const migrationFolder = fileURLToPath(new URL('../db/migrations/', import.meta.url))
  const migrator = new Migrator({
    db,
    provider: createMigrationProvider(migrationFolder),
  })
  return {
    database: async () => {
      await sql`select 1`.execute(db)
    },
    redis: async () => {
      if (await redis.ping() !== 'PONG') throw new Error('redis ping failed')
    },
    migrations: async () => {
      const migrations = await migrator.getMigrations()
      return migrations.length > 0
        && migrations.every(migration => migration.executedAt !== undefined)
    },
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write('production preflight 不接受命令行参数。\n')
    process.exitCode = 1
    return
  }

  const [{ config }, { db }] = await Promise.all([
    import('../config.js'),
    import('../db/client.js'),
  ])
  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  })
  try {
    const result = await runProductionPreflight(
      config,
      createProductionPreflightDependencies(db, redis),
    )
    process.stdout.write(formatProductionPreflight(result))
    process.exitCode = isProductionPreflightReady(result) ? 0 : 1
  } finally {
    redis.disconnect()
    await db.destroy()
  }
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch(() => {
    process.stderr.write('production preflight 无法执行。\n')
    process.exitCode = 1
  })
}
