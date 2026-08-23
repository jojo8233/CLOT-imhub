import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileMigrationProvider, Migrator } from 'kysely'
import { db } from './client.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(here, 'migrations'),
  }),
})

const { error, results } = await migrator.migrateToLatest()
for (const r of results ?? []) {
  console.log(`${r.status}: ${r.migrationName}`)
}
if (error) {
  console.error(error)
  process.exit(1)
}
await db.destroy()
