import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { FileMigrationProvider, type MigrationProvider } from 'kysely'

const migrationTestFilePattern = /\.test\./

export function createMigrationProvider(migrationFolder: string): MigrationProvider {
  return new FileMigrationProvider({
    fs: {
      readdir: async directory => (await fs.readdir(directory))
        .filter(fileName => !migrationTestFilePattern.test(fileName)),
    },
    path,
    migrationFolder,
  })
}
