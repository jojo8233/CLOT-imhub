import { create } from 'zustand'
import type { AccountRow, ConversationRow, MessageRow } from './api/client.js'

interface State {
  accounts: AccountRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  activeConversationId: string | null
  setAccounts(a: AccountRow[]): void
  setConversations(c: ConversationRow[]): void
  setMessages(m: MessageRow[]): void
  setActiveConversation(id: string): void
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
  setAccounts: (accounts) => set({ accounts }),
  setConversations: (conversations) => set({ conversations }),
  setMessages: (messages) => set({ messages }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
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
  }),
}))
