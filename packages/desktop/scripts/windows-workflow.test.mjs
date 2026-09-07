import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../../.github/workflows/windows-internal-package.yml', import.meta.url),
  'utf8',
)
const packageJson = JSON.parse(readFileSync(
  new URL('../../../package.json', import.meta.url),
  'utf8',
))

describe('Windows internal package workflow', () => {
  it('supports first-PR and later manual builds without fork packaging', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  })

  it('uses the protected environment and seven-day unsigned artifact', () => {
    expect(workflow).toContain('environment: internal-test')
    expect(workflow).toContain('vars.IM_HUB_SERVER_URL')
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
})
