import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object')
  }
  return value as JsonObject
}

function loadComposeWithExampleEnv(): JsonObject {
  const rendered = execFileSync('docker', [
    'compose',
    '-f',
    'deploy/compose.prod.yml',
    '--env-file',
    'deploy/env/compose.env.example',
    '--profile',
    'tools',
    'config',
    '--format',
    'json',
  ], { encoding: 'utf8' })
  return object(JSON.parse(rendered) as unknown)
}

describe('production container runtime', () => {
  it('passes the non-disclosing runtime validator', () => {
    expect(() => execFileSync(process.execPath, [
      'deploy/scripts/validate-runtime.mjs',
      '--examples',
    ], { stdio: 'pipe' })).not.toThrow()
  })

  it('publishes only Caddy and retains every production volume', () => {
    const runtime = loadComposeWithExampleEnv()
    const services = object(runtime.services)

    expect(object(services.caddy).ports).toHaveLength(2)
    expect(object(services.app).ports).toBeUndefined()
    expect(object(services.postgres).ports).toBeUndefined()
    expect(object(services.redis).ports).toBeUndefined()
    expect(Object.keys(object(runtime.volumes))).toEqual(expect.arrayContaining([
      'postgres_data',
      'redis_data',
      'tdlib_data',
      'signal_data',
      'caddy_data',
      'caddy_config',
      'caddy_logs',
    ]))
  })

  it('isolates edge and data services and fixes the direct proxy trust boundary', () => {
    const runtime = loadComposeWithExampleEnv()
    const services = object(runtime.services)
    const app = object(services.app)

    expect(Object.keys(object(app.networks))).toEqual(['data', 'edge'])
    expect(Object.keys(object(object(services.caddy).networks))).toEqual(['edge'])
    expect(Object.keys(object(object(services.postgres).networks))).toEqual(['data'])
    expect(Object.keys(object(object(services.redis).networks))).toEqual(['data'])
    expect(object(app.environment).TRUSTED_PROXY_CIDRS).toBe('172.30.0.2/32')
  })

  it('enables authenticated Redis AOF and keeps WhatsApp Cloud disabled', () => {
    const runtime = loadComposeWithExampleEnv()
    const services = object(runtime.services)
    const redisCommand = object(services.redis).command
    const rendered = JSON.stringify(runtime)

    const commandText = JSON.stringify(redisCommand)
    expect(commandText).toContain('redis-server')
    expect(commandText).toContain('--appendonly yes')
    expect(commandText).toContain('--requirepass')
    expect(object(object(services.app).environment).WHATSAPP_CLOUD_ENABLED).toBe('false')
    expect(rendered).not.toContain('imhub_dev')
    expect(rendered).not.toContain('change-me-in-production')
  })

  it('pins every production service to the reviewed x86_64 target', () => {
    const runtime = loadComposeWithExampleEnv()
    const services = object(runtime.services)

    for (const service of ['app', 'migrate', 'caddy', 'postgres', 'redis']) {
      expect(object(services[service]).platform).toBe('linux/amd64')
    }
  })
})
