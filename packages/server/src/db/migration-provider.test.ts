import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createMigrationProvider } from './migration-provider.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('createMigrationProvider', () => {
  it('发现迁移模块但不会导入同目录会抛错的测试模块', async () => {
    const migrationFolder = await mkdtemp(path.join(tmpdir(), 'im-hub-migrations-'))
    temporaryDirectories.push(migrationFolder)
    await writeFile(path.join(migrationFolder, '0001_valid.mjs'), 'export async function up() {}\n')
    await writeFile(
      path.join(migrationFolder, '0001_throws.test.mjs'),
      "throw new Error('test module must not be imported')\n",
    )

    const migrations = await createMigrationProvider(migrationFolder).getMigrations()

    expect(Object.keys(migrations)).toEqual(['0001_valid'])
    expect(migrations['0001_valid']?.up).toBeTypeOf('function')
  })
})
