import { describe, expect, it, vi } from 'vitest'
import { WhatsAppWebAdapter } from './adapter.js'

const account = { id: 'wa-1', displayName: 'WA', credentialsRef: null }

describe('WhatsAppWebAdapter', () => {
  it('keeps the account pending until the official web client reports identity', async () => {
    const adapter = new WhatsAppWebAdapter()
    const statuses: string[] = []
    adapter.onStatusChange((_id, status) => statuses.push(status))

    await adapter.connect(account)

    expect(statuses).toEqual(['pending_auth'])
  })

  it('does not pretend the server can send before the M6 bridge exists', async () => {
    await expect(new WhatsAppWebAdapter().sendMessage('wa-1', 'chat-1', { body: 'hello' }))
      .rejects.toThrow('isolated native client')
  })

  it('isolates a failing status subscriber', async () => {
    const adapter = new WhatsAppWebAdapter()
    const reached = vi.fn()
    adapter.onStatusChange(() => { throw new Error('subscriber failed') })
    adapter.onStatusChange(reached)

    await expect(adapter.connect(account)).resolves.toBeUndefined()
    expect(reached).toHaveBeenCalledWith('wa-1', 'pending_auth')
  })
})
