import { create } from 'zustand'
import type { AuthChallengeKind } from '@im-hub/shared'
import type { AccountRow, ConversationRow, MessageRow } from './api/client.js'
import {
  initialNavigation,
  reconcileNavigation,
  selectAccount,
  selectPlatform,
  type ChatPlatform,
} from './navigation.js'

/** 正在进行的鉴权挑战。payload 是二维码链接或提示语，都不是敏感值 */
export interface AuthChallengeState {
  accountId: string
  kind: AuthChallengeKind
  payload: string
}

export interface AuthDoneState {
  accountId: string
  ok: boolean
  reason: string | null
}

interface State {
  accounts: AccountRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  activeConversationId: string | null
  /** 顶部一级导航。Zoom 延后，不进入当前会话导航。 */
  activePlatform: ChatPlatform
  /** 当前平台的明确账号。平台没有账号时才为 null，不再提供跨账号“全部”。 */
  activeAccountId: string | null
  /** 每个平台分别记住最后一次激活账号，切回来时恢复。 */
  lastActiveAccountByPlatform: Partial<Record<ChatPlatform, string>>
  authChallenge: AuthChallengeState | null
  authDone: AuthDoneState | null
  /** 左侧功能中心是否展开。窗口窄的时候收起来给聊天区让位。 */
  panelOpen: boolean
  setAccounts(a: AccountRow[]): void
  setConversations(c: ConversationRow[]): void
  setMessages(m: MessageRow[]): void
  setActiveConversation(id: string): void
  setActivePlatform(platform: ChatPlatform): void
  setActiveAccount(id: string): void
  setAuthChallenge(c: AuthChallengeState): void
  setAuthDone(d: AuthDoneState): void
  clearAuth(): void
  togglePanel(): void
  applyTranslation(messageId: string, text: string): void
  appendMessage(m: MessageRow): void
  setAccountStatus(accountId: string, status: string): void
  updateConversationTargetLang(id: string, targetLang: string | null): void
  /**
   * 登出 / 401 被踢下线时调用：清空上一个账号的账号列表、会话列表、消息、当前
   * 选中会话——不然换个人登录，上一个人能看到的客户数据会在界面上闪一下,或者
   * 干脆一直留在 store 里直到下一次对应的 set* 调用覆盖它。
   */
  reset(): void
}

export const useStore = create<State>((set) => ({
  accounts: [],
  conversations: [],
  messages: [],
  activeConversationId: null,
  activePlatform: 'telegram',
  activeAccountId: null,
  lastActiveAccountByPlatform: {},
  authChallenge: null,
  authDone: null,
  panelOpen: true,
  setAccounts: (accounts) => set((s) => {
    // 登录后第一次拿到账号列表时直接打开首个实际有账号的平台；之后刷新列表则
    // 尊重用户当前选的平台，只修复被删除或失去权限的账号。
    const firstLoad = s.accounts.length === 0
      && s.activeAccountId === null
      && Object.keys(s.lastActiveAccountByPlatform).length === 0
    const navigation = firstLoad ? initialNavigation(accounts) : reconcileNavigation(accounts, s)
    const accountChanged = navigation.activeAccountId !== s.activeAccountId
    return {
      accounts,
      ...navigation,
      ...(accountChanged ? { activeConversationId: null, messages: [] } : {}),
    }
  }),
  setConversations: (conversations) => set({ conversations }),
  setMessages: (messages) => set({ messages }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  // 换平台或账号时清掉当前会话：上一个账号的客户信息不能留在新平台右栏。
  setActivePlatform: (platform) => set((s) => {
    const navigation = selectPlatform(s.accounts, s, platform)
    if (navigation.activePlatform === s.activePlatform && navigation.activeAccountId === s.activeAccountId) {
      return navigation
    }
    return { ...navigation, activeConversationId: null, messages: [] }
  }),
  setActiveAccount: (accountId) => set((s) => {
    const navigation = selectAccount(s.accounts, s, accountId)
    if (navigation.activeAccountId === s.activeAccountId) return navigation
    return { ...navigation, activeConversationId: null, messages: [] }
  }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setAuthChallenge: (authChallenge) => set({ authChallenge, authDone: null }),
  setAuthDone: (authDone) => set({ authDone, authChallenge: null }),
  clearAuth: () => set({ authChallenge: null, authDone: null }),
  applyTranslation: (messageId, text) => set((s) => ({
    messages: s.messages.map(m => m.id === messageId ? { ...m, translated_text: text } : m),
  })),
  // 去重：同一条消息可能既走 WS 推送又走列表拉取，两边都到时不能显示两遍
  appendMessage: (m) => set((s) =>
    s.messages.some((x) => x.id === m.id) ? {} : { messages: [...s.messages, m] },
  ),
  setAccountStatus: (accountId, status) => set((s) => ({
    accounts: s.accounts.map((a) => a.id === accountId ? { ...a, status } : a),
  })),
  // PATCH 成功后同步进列表缓存，这样切走再切回来锁定状态还在，不用重新拉一次会话列表。
  updateConversationTargetLang: (id, targetLang) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, target_lang: targetLang } : c),
  })),
  reset: () => set({
    accounts: [],
    conversations: [],
    messages: [],
    activeConversationId: null,
    activePlatform: 'telegram',
    activeAccountId: null,
    lastActiveAccountByPlatform: {},
    authChallenge: null,
    authDone: null,
  }),
}))
