import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ADMIN_EDITABLE_ROLES,
  type AdminAccount,
  type LoginResponse,
  type WsServerEvent,
} from './index.js'

describe('organization admin contracts', () => {
  it('普通创建角色不包含 owner', () => {
    expect(ADMIN_EDITABLE_ROLES).toEqual(['auditor', 'manager', 'agent'])
  })

  it('首次改密响应不含普通 session token 字段', () => {
    const response: LoginResponse = {
      kind: 'password_change_required',
      setupToken: 'synthetic-setup-token',
      user: { id: 'u1', role: 'agent', displayName: 'A' },
    }

    expect('token' in response).toBe(false)
  })

  it('账号清理状态包含 Signal 人工处理', () => {
    expectTypeOf<AdminAccount['cleanupState']>()
      .toEqualTypeOf<'not_required' | 'pending' | 'completed' | 'manual_required'>()
  })

  it('撤权事件属于服务端事件联合类型', () => {
    const event: WsServerEvent = { type: 'session_revoked' }

    expect(event.type).toBe('session_revoked')
  })
})
