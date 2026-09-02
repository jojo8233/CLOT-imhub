import { describe, expect, it } from 'vitest'
import { FUNCTION_CENTER_ENTRIES } from './FunctionCenter.js'

describe('FunctionCenter entries', () => {
  it('wires customer profiles and removes misleading translation history', () => {
    expect(FUNCTION_CENTER_ENTRIES).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '客户档案库', view: 'customerProfiles' }),
    ]))
    expect(FUNCTION_CENTER_ENTRIES.some(entry => entry.title === '翻译历史')).toBe(false)
  })
})
