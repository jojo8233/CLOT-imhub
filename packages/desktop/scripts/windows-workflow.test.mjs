import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../../.github/workflows/windows-internal-package.yml', import.meta.url),
  'utf8',
)

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
})
