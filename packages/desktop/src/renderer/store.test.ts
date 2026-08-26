import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountRow } from './api/client.js'
import { useStore } from './store.js'

function account(id: string, platform: string): AccountRow {
  return {
    id,
    platform,
    display_name: id,
    status: 'connected',
    history_available_from: null,
  }
}

const accounts = [
  account('tg-1', 'telegram'),
  account('tg-2', 'telegram'),
  account('sig-1', 'signal'),
  account('wa-1', 'whatsapp'),
]

describe('platform-scoped Zustand navigation', () => {
  beforeEach(() => useStore.getState().reset())

  it('首次账号列表选择第一个有账号的平台', () => {
    useStore.getState().setAccounts([account('sig-1', 'signal')])
    expect(useStore.getState()).toMatchObject({
      activePlatform: 'signal',
      activeAccountId: 'sig-1',
    })
  })

  it('每个平台分别恢复最后激活账号', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setActiveAccount('tg-2')
    useStore.getState().setActivePlatform('signal')
    useStore.getState().setActivePlatform('telegram')
    expect(useStore.getState().activeAccountId).toBe('tg-2')
  })

  it('列表刷新删除当前账号后退回同平台账号并清理会话数据', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setActiveAccount('tg-2')
    useStore.getState().setMessages([{
      id: 'm1', direction: 'in', body: 'hello', sent_at: '2026-08-26T00:00:00Z', translated_text: null,
    }])

    useStore.getState().setAccounts(accounts.filter(item => item.id !== 'tg-2'))

    expect(useStore.getState()).toMatchObject({
      activePlatform: 'telegram',
      activeAccountId: 'tg-1',
      activeConversationId: null,
      messages: [],
    })
  })

  it('拒绝从当前平台直接选中其他平台账号', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setActiveAccount('sig-1')
    expect(useStore.getState()).toMatchObject({
      activePlatform: 'telegram',
      activeAccountId: 'tg-1',
    })
  })

  it('登出重置平台记忆，防止下一个用户继承账号选择', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setActivePlatform('signal')
    useStore.getState().reset()
    expect(useStore.getState()).toMatchObject({
      activePlatform: 'telegram',
      activeAccountId: null,
      lastActiveAccountByPlatform: {},
    })
  })
})
