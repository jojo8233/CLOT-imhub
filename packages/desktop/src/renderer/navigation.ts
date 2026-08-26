import type { Platform } from '@im-hub/shared'

export const CHAT_PLATFORMS = ['telegram', 'signal', 'whatsapp'] as const satisfies readonly Platform[]
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number]

export interface NavigationAccount {
  id: string
  platform: string
}

export interface AccountNavigation {
  activePlatform: ChatPlatform
  activeAccountId: string | null
  lastActiveAccountByPlatform: Partial<Record<ChatPlatform, string>>
}

export function isChatPlatform(platform: string): platform is ChatPlatform {
  return (CHAT_PLATFORMS as readonly string[]).includes(platform)
}

export function accountsForPlatform<T extends NavigationAccount>(
  accounts: readonly T[],
  platform: ChatPlatform,
): T[] {
  return accounts.filter(account => account.platform === platform)
}

function accountBelongsToPlatform(
  accounts: readonly NavigationAccount[],
  accountId: string | null | undefined,
  platform: ChatPlatform,
): accountId is string {
  if (!accountId) return false
  return accounts.some(account => account.id === accountId && account.platform === platform)
}

function cleanRememberedAccounts(
  accounts: readonly NavigationAccount[],
  remembered: AccountNavigation['lastActiveAccountByPlatform'],
): AccountNavigation['lastActiveAccountByPlatform'] {
  const cleaned: AccountNavigation['lastActiveAccountByPlatform'] = {}
  for (const platform of CHAT_PLATFORMS) {
    const accountId = remembered[platform]
    if (accountBelongsToPlatform(accounts, accountId, platform)) cleaned[platform] = accountId
  }
  return cleaned
}

/** 首次拿到账号列表时，优先打开第一个实际有账号的平台。 */
export function initialNavigation(accounts: readonly NavigationAccount[]): AccountNavigation {
  const activePlatform = CHAT_PLATFORMS.find(
    platform => accounts.some(account => account.platform === platform),
  ) ?? 'telegram'
  const activeAccountId = accountsForPlatform(accounts, activePlatform)[0]?.id ?? null
  return {
    activePlatform,
    activeAccountId,
    lastActiveAccountByPlatform: activeAccountId ? { [activePlatform]: activeAccountId } : {},
  }
}

/**
 * 账号列表刷新、账号删除或权限变化后，把导航状态收敛到一个合法组合。
 * 当前账号失效时先尝试该平台记住的账号，再退回该平台第一个账号。
 */
export function reconcileNavigation(
  accounts: readonly NavigationAccount[],
  navigation: AccountNavigation,
): AccountNavigation {
  const remembered = cleanRememberedAccounts(accounts, navigation.lastActiveAccountByPlatform)
  const activeAccountId = accountBelongsToPlatform(
    accounts,
    navigation.activeAccountId,
    navigation.activePlatform,
  )
    ? navigation.activeAccountId
    : accountBelongsToPlatform(accounts, remembered[navigation.activePlatform], navigation.activePlatform)
      ? remembered[navigation.activePlatform]!
      : accountsForPlatform(accounts, navigation.activePlatform)[0]?.id ?? null

  if (activeAccountId) remembered[navigation.activePlatform] = activeAccountId

  return {
    activePlatform: navigation.activePlatform,
    activeAccountId,
    lastActiveAccountByPlatform: remembered,
  }
}

export function selectPlatform(
  accounts: readonly NavigationAccount[],
  navigation: AccountNavigation,
  activePlatform: ChatPlatform,
): AccountNavigation {
  return reconcileNavigation(accounts, {
    ...navigation,
    activePlatform,
    activeAccountId: null,
  })
}

export function selectAccount(
  accounts: readonly NavigationAccount[],
  navigation: AccountNavigation,
  activeAccountId: string,
): AccountNavigation {
  if (!accountBelongsToPlatform(accounts, activeAccountId, navigation.activePlatform)) {
    return reconcileNavigation(accounts, navigation)
  }
  return reconcileNavigation(accounts, {
    ...navigation,
    activeAccountId,
    lastActiveAccountByPlatform: {
      ...navigation.lastActiveAccountByPlatform,
      [navigation.activePlatform]: activeAccountId,
    },
  })
}
