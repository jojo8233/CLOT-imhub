import { describe, expect, it, vi } from 'vitest'
import { runBootstrapOwnerCli, type BootstrapOwnerCliDeps } from './bootstrap-owner.js'

function createDeps(overrides: Partial<BootstrapOwnerCliDeps> = {}): {
  deps: BootstrapOwnerCliDeps
  output: string[]
  errorOutput: string[]
} {
  const output: string[] = []
  const errorOutput: string[] = []
  return {
    output,
    errorOutput,
    deps: {
      argv: [],
      readIdentity: async () => ({
        email: ' Owner@Example.Test ',
        displayName: ' 管理员 ',
      }),
      readHidden: vi.fn()
        .mockResolvedValueOnce('synthetic-hidden-password')
        .mockResolvedValueOnce('synthetic-hidden-password'),
      bootstrap: vi.fn().mockResolvedValue({ id: 'synthetic-owner-id' }),
      now: () => new Date('2026-09-07T00:00:00.000Z'),
      writeOutput: value => output.push(value),
      writeError: value => errorOutput.push(value),
      ...overrides,
    },
  }
}

describe('runBootstrapOwnerCli', () => {
  it('拒绝所有命令行参数，且不回显参数内容', async () => {
    const readIdentity = vi.fn()
    const bootstrap = vi.fn()
    const sentinel = 'must-not-appear-in-output'
    const { deps, output, errorOutput } = createDeps({
      argv: [sentinel],
      readIdentity,
      bootstrap,
    })

    await expect(runBootstrapOwnerCli(deps)).resolves.toBe(1)
    expect(readIdentity).not.toHaveBeenCalled()
    expect(bootstrap).not.toHaveBeenCalled()
    expect([...output, ...errorOutput].join('')).not.toContain(sentinel)
  })

  it('两次密码不一致时拒绝，且任何输出都不包含密码', async () => {
    const bootstrap = vi.fn()
    const { deps, output, errorOutput } = createDeps({
      readHidden: vi.fn()
        .mockResolvedValueOnce('first-password-sentinel')
        .mockResolvedValueOnce('second-password-sentinel'),
      bootstrap,
    })

    await expect(runBootstrapOwnerCli(deps)).resolves.toBe(1)
    expect(bootstrap).not.toHaveBeenCalled()
    expect([...output, ...errorOutput].join('')).not.toContain('password-sentinel')
  })

  it('仅输出成功状态和规范化后的 owner 邮箱', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ id: 'synthetic-owner-id' })
    const { deps, output, errorOutput } = createDeps({ bootstrap })

    await expect(runBootstrapOwnerCli(deps)).resolves.toBe(0)
    expect(bootstrap).toHaveBeenCalledWith({
      email: ' Owner@Example.Test ',
      displayName: ' 管理员 ',
      password: 'synthetic-hidden-password',
      now: new Date('2026-09-07T00:00:00.000Z'),
    })
    expect(output.join('')).toContain('owner@example.test')
    expect([...output, ...errorOutput].join('')).not.toContain('synthetic-hidden-password')
    expect(errorOutput).toEqual([])
  })
})
