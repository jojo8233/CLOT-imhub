import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Migrator } from 'kysely'
import { db } from './client.js'
import { createMigrationProvider } from './migration-provider.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const migrator = new Migrator({
  db,
  provider: createMigrationProvider(path.join(here, 'migrations')),
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
