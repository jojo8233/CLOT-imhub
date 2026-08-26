import { describe, expect, it } from 'vitest'
import { translateJobId } from './queue.js'

describe('translateJobId', () => {
  it('同一正文 revision 幂等，编辑后变化且不包含 BullMQ 禁止的冒号', () => {
    const initial = translateJobId({ messageId: 'm-1', conversationId: 'c-1', revision: 'initial' })
    const initialAgain = translateJobId({ messageId: 'm-1', conversationId: 'c-1', revision: 'initial' })
    const edited = translateJobId({
      messageId: 'm-1', conversationId: 'c-1', revision: '2026-08-26T01:02:03.000Z',
    })
    expect(initialAgain).toBe(initial)
    expect(edited).not.toBe(initial)
    expect(edited).not.toContain(':')
  })
})
