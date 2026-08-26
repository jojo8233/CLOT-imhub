import { describe, expect, it } from 'vitest'
import { nativeAccountControllable } from './NativeClient.js'

describe('native account ownership gate', () => {
  const account = { owner_user_id: 'user-1' }

  it('只允许当前 owner 且非 auditor 挂载原生 pane', () => {
    expect(nativeAccountControllable(account, { id: 'user-1', role: 'agent' })).toBe(true)
    expect(nativeAccountControllable(account, { id: 'manager-1', role: 'manager' })).toBe(false)
    expect(nativeAccountControllable(account, { id: 'user-1', role: 'auditor' })).toBe(false)
    expect(nativeAccountControllable(null, { id: 'user-1', role: 'agent' })).toBe(false)
  })
})
