import { describe, expect, it } from 'vitest'

describe('Vitest database isolation', () => {
  it('normalizes the runner database to the isolated test database before tests load', () => {
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '')

    expect(databaseUrl.pathname).toBe('/imhub_test')
  })
})
