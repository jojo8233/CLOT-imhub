import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { BootstrapOwnerError, bootstrapOwner, type BootstrapOwnerInput } from './bootstrap-owner-service.js'
import { HiddenInputError, readHiddenLine } from './hidden-input.js'

export interface BootstrapOwnerCliDeps {
  argv: string[]
  readIdentity(): Promise<{ email: string; displayName: string }>
  readHidden(prompt: string): Promise<string>
  bootstrap(input: BootstrapOwnerInput): Promise<{ id: string }>
  now(): Date
  writeOutput(value: string): void
  writeError(value: string): void
}

export async function runBootstrapOwnerCli(deps: BootstrapOwnerCliDeps): Promise<number> {
  if (deps.argv.length !== 0) {
    deps.writeError('owner 初始化不接受命令行参数，请按交互提示输入。\n')
    return 1
  }

  try {
    const identity = await deps.readIdentity()
    const password = await deps.readHidden('临时密码：')
    const confirmation = await deps.readHidden('再次输入：')
    if (password !== confirmation) {
      deps.writeError('owner 初始化失败：两次密码不一致。\n')
      return 1
    }

    await deps.bootstrap({
      ...identity,
      password,
      now: deps.now(),
    })
    deps.writeOutput(`owner 初始化成功：${identity.email.trim().toLowerCase()}\n`)
    return 0
  } catch (error) {
    if (error instanceof BootstrapOwnerError || error instanceof HiddenInputError) {
      deps.writeError(`owner 初始化失败：${error.message}\n`)
    } else {
      deps.writeError('owner 初始化失败；请检查数据库连接和 migration 状态。\n')
    }
    return 1
  }
}

async function readIdentityFromTerminal(): Promise<{ email: string; displayName: string }> {
  if (process.stdin.isTTY !== true) throw new HiddenInputError('TTY_REQUIRED')
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  try {
    return {
      email: await prompt.question('owner 邮箱：'),
      displayName: await prompt.question('显示名称：'),
    }
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length !== 0) {
    process.stderr.write('owner 初始化不接受命令行参数，请按交互提示输入。\n')
    process.exitCode = 1
    return
  }

  const { db } = await import('./client.js')
  try {
    process.exitCode = await runBootstrapOwnerCli({
      argv,
      readIdentity: readIdentityFromTerminal,
      readHidden: readHiddenLine,
      bootstrap: input => bootstrapOwner(db, input),
      now: () => new Date(),
      writeOutput: value => process.stdout.write(value),
      writeError: value => process.stderr.write(value),
    })
  } finally {
    await db.destroy()
  }
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch(() => {
    process.stderr.write('owner 初始化失败；请检查生产配置和数据库连接。\n')
    process.exitCode = 1
  })
}
