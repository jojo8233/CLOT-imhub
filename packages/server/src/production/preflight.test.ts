import { describe, expect, it, vi } from 'vitest'
import {
  createProductionPreflightRedis,
  formatProductionPreflight,
  isProductionPreflightReady,
  migrationStateIsCurrent,
  runProductionPreflight,
  type ProductionPreflightConfig,
  type ProductionPreflightDependencies,
} from './preflight.js'

const secretSentinels = {
  jwt: 'synthetic-jwt-secret-must-not-appear',
  database: 'synthetic-database-error-must-not-appear',
  redis: 'synthetic-redis-error-must-not-appear',
  migration: 'synthetic-migration-error-must-not-appear',
}

const readyConfig: ProductionPreflightConfig & { JWT_SECRET: string } = {
  APP_ENV: 'production',
  DEEPL_API_KEY: 'synthetic-deepl-key',
  ANTHROPIC_API_KEY: 'synthetic-claude-key',
  OPENAI_API_KEY: 'synthetic-openai-key',
  TELEGRAM_API_ID: 12345,
  TELEGRAM_API_HASH: 'synthetic-telegram-hash',
  WHATSAPP_CLOUD_ENABLED: false,
  ORGANIZATION_ADMIN_WRITES_ENABLED: true,
  JWT_SECRET: secretSentinels.jwt,
}

const readyDependencies: ProductionPreflightDependencies = {
  database: async () => undefined,
  redis: async () => undefined,
  migrations: async () => true,
}

describe('runProductionPreflight', () => {
  it('只返回固定检查名和 ok 状态，不携带配置值', async () => {
    const result = await runProductionPreflight(readyConfig, readyDependencies)

    expect(result).toEqual({
      productionMode: 'ok',
      database: 'ok',
      redis: 'ok',
      migrations: 'ok',
      deepl: 'ok',
      claude: 'ok',
      openai: 'ok',
      telegram: 'ok',
      whatsappCloudDisabled: 'ok',
      organizationAdminWrites: 'ok',
    })
    expect(isProductionPreflightReady(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(secretSentinels.jwt)
  })

  it.each([
    ['productionMode', { APP_ENV: 'development' }],
    ['deepl', { DEEPL_API_KEY: ' ' }],
    ['claude', { ANTHROPIC_API_KEY: '' }],
    ['openai', { OPENAI_API_KEY: '' }],
    ['telegram', { TELEGRAM_API_ID: 0 }],
    ['telegram', { TELEGRAM_API_HASH: '' }],
    ['whatsappCloudDisabled', { WHATSAPP_CLOUD_ENABLED: true }],
    ['organizationAdminWrites', { ORGANIZATION_ADMIN_WRITES_ENABLED: false }],
  ] as const)('配置不满足时把 %s 标成 missing', async (name, override) => {
    const result = await runProductionPreflight({ ...readyConfig, ...override }, readyDependencies)

    expect(result[name]).toBe('missing')
    expect(isProductionPreflightReady(result)).toBe(false)
  })

  it('把依赖错误和未执行 migration 收敛为 missing，不泄露错误正文', async () => {
    const result = await runProductionPreflight(readyConfig, {
      database: async () => { throw new Error(secretSentinels.database) },
      redis: async () => { throw new Error(secretSentinels.redis) },
      migrations: async () => { throw new Error(secretSentinels.migration) },
    })
    const output = `${JSON.stringify(result)}${formatProductionPreflight(result)}`

    expect(result).toMatchObject({
      database: 'missing',
      redis: 'missing',
      migrations: 'missing',
    })
    expect(isProductionPreflightReady(result)).toBe(false)
    for (const sentinel of Object.values(secretSentinels)) {
      expect(output).not.toContain(sentinel)
    }
    expect(formatProductionPreflight(result)).toMatch(
      /^productionMode=(ok|missing)(\n[^=]+=(ok|missing))+\n$/,
    )
  })

  it('未执行完所有 migration 时报告 missing', async () => {
    const result = await runProductionPreflight(readyConfig, {
      ...readyDependencies,
      migrations: async () => false,
    })

    expect(result.migrations).toBe('missing')
  })

  it('数据库包含当前代码未知的未来 migration 时拒绝旧镜像启动', () => {
    const current = new Date('2026-09-07T00:00:00.000Z')

    expect(migrationStateIsCurrent([
      { name: '001_current', executedAt: current },
    ], ['001_current'])).toBe(true)
    expect(migrationStateIsCurrent([
      { name: '001_current', executedAt: current },
    ], ['001_current', '002_future'])).toBe(false)
    expect(migrationStateIsCurrent([
      { name: '001_current' },
    ], ['001_current'])).toBe(false)
  })

  it('Redis error 事件不向控制台输出依赖错误正文', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const redis = createProductionPreflightRedis('redis://localhost:6379')
    const sentinel = 'synthetic-preflight-redis-error-must-not-leak'
    try {
      redis.emit('error', new Error(sentinel))

      expect(redis.listenerCount('error')).toBeGreaterThan(0)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      redis.disconnect()
      consoleError.mockRestore()
    }
  })
})
