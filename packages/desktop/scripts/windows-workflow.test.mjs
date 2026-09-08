import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../../.github/workflows/windows-internal-package.yml', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(readFileSync(
  new URL('../../../package.json', import.meta.url),
  'utf8',
))

function testFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return testFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('Windows internal package workflow', () => {
  it('supports first-PR and later manual builds without fork packaging', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })

  it('uses the protected environment and seven-day unsigned artifact', () => {
    expect(workflow).toContain('environment: internal-test')
    expect(workflow).toContain('vars.IM_HUB_SERVER_URL')
    expect(workflow).toContain('pnpm smoke:artifact')
    expect(workflow).toContain('package:internal:win')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('internal-unsigned')
    expect(workflow).toContain('third-party-licenses')
  })

  it('uses the exact packageManager pnpm version without a conflicting action input', () => {
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
    expect(workflow.match(/uses: pnpm\/action-setup@v4/g)).toHaveLength(2)
    expect(workflow).not.toMatch(/pnpm\/action-setup@v4\n\s+with:\s*\{\s*version:/)
  })

  it('preserves a database connection supplied by the CI runner', () => {
    const serverSource = fileURLToPath(new URL('../../server/src/', import.meta.url))
    const overrides = testFilesUnder(serverSource).filter(path => (
      /process\.env\.DATABASE_URL\s*=(?!=)/.test(readFileSync(path, 'utf8'))
    ))

    expect(overrides).toEqual([])
  })

  it('creates and migrates the isolated test database before running tests', () => {
    const databaseUrl = workflow.match(/DATABASE_URL:\s*(\S+)/)?.[1]
    expect(databaseUrl).toBeDefined()
    expect(new URL(databaseUrl).pathname).toBe('/imhub_test')

    const createDatabase = workflow.indexOf('CREATE DATABASE imhub_test')
    const migrateDatabase = workflow.indexOf('- run: pnpm db:migrate')
    const runTests = workflow.indexOf('- run: pnpm test')
    expect(createDatabase).toBeGreaterThan(-1)
    expect(migrateDatabase).toBeGreaterThan(createDatabase)
    expect(runTests).toBeGreaterThan(migrateDatabase)
  })

  it('runs artifact smoke before producing the unsigned installer', () => {
    const smoke = workflow.indexOf('- run: pnpm smoke:artifact')
    const packageBuild = workflow.indexOf('- run: pnpm --filter @im-hub/desktop package:internal:win')
    expect(smoke).toBeGreaterThan(-1)
    expect(packageBuild).toBeGreaterThan(smoke)
  })
})
