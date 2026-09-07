import { beforeAll, describe, expect, it } from 'vitest'

process.env.DATABASE_URL ??= 'postgres://imhub:imhub_dev@localhost:5432/imhub_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'config-module-test-secret-with-more-than-32-characters'

let parseConfig: typeof import('./config.js').parseConfig

const minimumProductionEnv: NodeJS.ProcessEnv = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://imhub:synthetic-production-password@postgres:5432/imhub',
  REDIS_URL: 'redis://:synthetic-production-password@redis:6379',
  JWT_SECRET: 'synthetic-production-jwt-secret-with-more-than-32-characters',
  PUBLIC_ORIGIN: 'https://imhub.jojo2333.net',
  TRUSTED_PROXY_CIDRS: '172.30.0.2/32',
}

beforeAll(async () => {
  ;({ parseConfig } = await import('./config.js'))
})

describe('parseConfig production boundary', () => {
  it('accepts an exact HTTPS production origin and one trusted Caddy CIDR', () => {
    const parsed = parseConfig(minimumProductionEnv)

    expect(parsed.APP_ENV).toBe('production')
    expect(parsed.PUBLIC_ORIGIN).toBe('https://imhub.jojo2333.net')
    expect(parsed.TRUSTED_PROXY_CIDRS).toEqual(['172.30.0.2/32'])
  })

  it.each([
    '',
    'http://imhub.jojo2333.net',
    'https://user@imhub.jojo2333.net',
    'https://imhub.jojo2333.net/path',
    'https://imhub.jojo2333.net?source=test',
    'https://imhub.jojo2333.net#fragment',
    'https://imhub.jojo2333.net/',
  ])('rejects unsafe production origin %j', (origin) => {
    expect(() => parseConfig({
      ...minimumProductionEnv,
      PUBLIC_ORIGIN: origin,
    })).toThrow('PUBLIC_ORIGIN')
  })

  it.each([
    '',
    '127.0.0.1',
    '172.30.0.2/33',
    '172.30.0.2/32,172.30.0.3/32',
  ])('rejects unsafe production trusted proxy CIDRs %j', (trustedProxyCidrs) => {
    expect(() => parseConfig({
      ...minimumProductionEnv,
      TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
    })).toThrow('TRUSTED_PROXY_CIDRS')
  })

  it('rejects the documented development database password in production', () => {
    expect(() => parseConfig({
      ...minimumProductionEnv,
      DATABASE_URL: 'postgres://imhub:imhub_dev@postgres:5432/imhub',
    })).toThrow('DATABASE_URL')
  })

  it('rejects the documented JWT placeholder', () => {
    expect(() => parseConfig({
      ...minimumProductionEnv,
      JWT_SECRET: 'change-me-in-production',
    })).toThrow('JWT_SECRET')
  })

  it('rejects WhatsApp Cloud even when its legacy configuration is complete', () => {
    expect(() => parseConfig({
      ...minimumProductionEnv,
      WHATSAPP_CLOUD_ENABLED: 'true',
      WHATSAPP_META_APP_ID: 'synthetic-app-id',
      WHATSAPP_META_CONFIG_ID: 'synthetic-config-id',
      WHATSAPP_META_APP_SECRET: 'synthetic-app-secret',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'synthetic-verify-token',
      WHATSAPP_PUBLIC_BASE_URL: 'https://imhub.jojo2333.net',
      WHATSAPP_SECRET_MASTER_KEY: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })).toThrow('WHATSAPP_CLOUD_ENABLED')
  })

  it('keeps complete legacy WhatsApp Cloud configuration valid outside production', () => {
    const parsed = parseConfig({
      ...minimumProductionEnv,
      APP_ENV: 'development',
      PUBLIC_ORIGIN: '',
      TRUSTED_PROXY_CIDRS: '',
      WHATSAPP_CLOUD_ENABLED: 'true',
      WHATSAPP_META_APP_ID: 'synthetic-app-id',
      WHATSAPP_META_CONFIG_ID: 'synthetic-config-id',
      WHATSAPP_META_APP_SECRET: 'synthetic-app-secret',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'synthetic-verify-token',
      WHATSAPP_PUBLIC_BASE_URL: 'https://imhub.example.test',
      WHATSAPP_SECRET_MASTER_KEY: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=',
    })

    expect(parsed.WHATSAPP_CLOUD_ENABLED).toBe(true)
  })
})
