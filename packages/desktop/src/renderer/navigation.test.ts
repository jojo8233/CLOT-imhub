import { describe, expect, it } from 'vitest'
import {
  CHAT_PLATFORMS,
  accountsForPlatform,
  initialNavigation,
  reconcileNavigation,
  selectAccount,
  selectPlatform,
  type AccountNavigation,
  type NavigationAccount,
} from './navigation.js'

const accounts: NavigationAccount[] = [
  { id: 'tg-1', platform: 'telegram' },
  { id: 'tg-2', platform: 'telegram' },
  { id: 'sig-1', platform: 'signal' },
  { id: 'wa-1', platform: 'whatsapp' },
  { id: 'zoom-1', platform: 'zoom' },
]

describe('initialNavigation', () => {
  it('首次加载选择首个有账号的平台及其第一个账号', () => {
    expect(initialNavigation(accounts)).toEqual({
      activePlatform: 'telegram',
      activeAccountId: 'tg-1',
      lastActiveAccountByPlatform: { telegram: 'tg-1' },
    })
  })

  it('没有 Telegram 时直接打开首个实际有账号的平台', () => {
    expect(initialNavigation(accounts.filter(account => account.platform !== 'telegram'))).toMatchObject({
      activePlatform: 'signal',
      activeAccountId: 'sig-1',
    })
  })

  it('Zoom 不进入首期会话导航', () => {
    expect(CHAT_PLATFORMS).toEqual(['telegram', 'signal', 'whatsapp'])
    expect(initialNavigation([{ id: 'zoom-1', platform: 'zoom' }])).toMatchObject({
      activePlatform: 'telegram',
      activeAccountId: null,
    })
  })
})

describe('platform-scoped account navigation', () => {
  const start: AccountNavigation = {
    activePlatform: 'telegram',
    activeAccountId: 'tg-2',
    lastActiveAccountByPlatform: { telegram: 'tg-2', signal: 'sig-1' },
  }

  it('账号列表只返回当前平台账号', () => {
    expect(accountsForPlatform(accounts, 'telegram').map(account => account.id)).toEqual(['tg-1', 'tg-2'])
    expect(accountsForPlatform(accounts, 'signal').map(account => account.id)).toEqual(['sig-1'])
  })

  it('切平台恢复该平台最后使用的账号', () => {
    const signal = selectPlatform(accounts, start, 'signal')
    expect(signal.activeAccountId).toBe('sig-1')
    expect(selectPlatform(accounts, signal, 'telegram').activeAccountId).toBe('tg-2')
  })

  it('不能选择其他平台的账号，避免平台和账号组合不一致', () => {
    expect(selectAccount(accounts, start, 'sig-1')).toEqual(start)
  })

  it('删除当前账号后退回同平台第一个可用账号并清理旧记忆', () => {
    const left = accounts.filter(account => account.id !== 'tg-2')
    expect(reconcileNavigation(left, start)).toEqual({
      activePlatform: 'telegram',
      activeAccountId: 'tg-1',
      lastActiveAccountByPlatform: { telegram: 'tg-1', signal: 'sig-1' },
    })
  })

  it('当前平台没有账号时保持平台选择并把账号设为空', () => {
    const withoutWhatsApp = accounts.filter(account => account.platform !== 'whatsapp')
    expect(selectPlatform(withoutWhatsApp, start, 'whatsapp')).toMatchObject({
      activePlatform: 'whatsapp',
      activeAccountId: null,
    })
  })
})
