import { create } from 'zustand'
import type { AuthChallengeKind } from '@im-hub/shared'
import type { AccountRow, ConversationRow, MessageRow } from './api/client.js'
import type { NativeConversationContext } from '@im-hub/shared'
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

export type NativeBridgeConnection = 'loading' | 'waiting' | 'ready' | 'failed'

export interface NativeConversationState extends NativeConversationContext {
  contextRevision: number
  /** 服务端解析出的 conversations.id；解析完成前为 null。 */
  conversationId: string | null
}

export interface NativeAccountBridgeState {
  connection: NativeBridgeConnection
  error: string | null
  /** 不影响账号授权的消息级提示；身份心跳不得把它提前清除。 */
  notice: string | null
  /** guest 报告的实际平台登录账号；M3 control grant 用它做身份绑定。 */
  platformAccountExternalId: string | null
  context: NativeConversationState | null
  /** 原生客户端对当前 revision 的实时可发送状态。 */
  composerCanSend: boolean
  /** 持久消息 outbox 的非敏感积压与失败指标。 */
  outbox?: {
    pendingCount: number
    deadLetterCount: number
    isSending: boolean
    lastErrorCode: string | null
  }
}

export type NativeDraftStatus = 'idle' | 'configuring' | 'translating' | 'ready' | 'sending' | 'failed'

export interface NativeDraftState {
  sourceText: string
  translatedText: string
  backTranslated: string | null
  targetLang: string | null
  status: NativeDraftStatus
  error: string | null
  /** 结果未知时与最终原生草稿绑定，重试必须沿用同一个逻辑发送标识。 */
  sendAttemptId: string | null
  sendAttemptDraft: string | null
}

const EMPTY_DRAFT: NativeDraftState = {
  sourceText: '', translatedText: '', backTranslated: null,
  targetLang: null, status: 'idle', error: null,
  sendAttemptId: null, sendAttemptDraft: null,
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
  nativeBridgeByAccount: Record<string, NativeAccountBridgeState>
  nativeDrafts: Record<string, NativeDraftState>
  authChallenge: AuthChallengeState | null
  authDone: AuthDoneState | null
  /** 左侧功能中心是否展开。窗口窄的时候收起来给聊天区让位。 */
  panelOpen: boolean
  setAccounts(a: AccountRow[]): void
  setConversations(c: ConversationRow[]): void
  setMessages(m: MessageRow[]): void
  setActiveConversation(id: string | null): void
  setActivePlatform(platform: ChatPlatform): void
  setActiveAccount(id: string): void
  setAuthChallenge(c: AuthChallengeState): void
  setAuthDone(d: AuthDoneState): void
  clearAuth(): void
  togglePanel(): void
  applyTranslation(messageId: string, text: string, revision: string): void
  appendMessage(m: MessageRow): void
  updateMessage(messageId: string, body: string, editedAt: string, translatedBody: string | null): void
  removeMessage(messageId: string): void
  setAccountStatus(accountId: string, status: string): void
  updateConversationTargetLang(id: string, targetLang: string | null): void
  setNativeBridgeConnection(accountId: string, connection: NativeBridgeConnection, error?: string | null): void
  setNativeBridgeNotice(accountId: string, notice: string | null): void
  setNativeOutboxStatus(
    accountId: string,
    status: NonNullable<NativeAccountBridgeState['outbox']>,
  ): void
  setNativeAccountIdentity(accountId: string, platformAccountExternalId: string | null): void
  setNativeContext(accountId: string, context: NativeConversationState | null): void
  resolveNativeConversation(
    accountId: string,
    contextRevision: number,
    platformConversationId: string,
    conversationId: string,
  ): void
  applyNativeComposerState(
    accountId: string,
    contextRevision: number,
    platformConversationId: string,
    draft: string,
    canSend: boolean,
  ): void
  updateNativeDraft(key: string, patch: Partial<NativeDraftState>): void
  clearNativeDraft(key: string): void
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
  nativeBridgeByAccount: {},
  nativeDrafts: {},
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
  applyTranslation: (messageId, text, revision) => set((s) => ({
    messages: s.messages.map(m => m.id === messageId
      && (m.edited_at ?? 'initial') === revision
      ? { ...m, translated_text: text }
      : m),
  })),
  // 去重：同一条消息可能既走 WS 推送又走列表拉取，两边都到时不能显示两遍
  appendMessage: (m) => set((s) =>
    s.messages.some((x) => x.id === m.id) ? {} : { messages: [...s.messages, m] },
  ),
  updateMessage: (messageId, body, editedAt, translatedBody) => set((s) => ({
    messages: s.messages.map(message => message.id === messageId
      && (message.edited_at === null || message.edited_at <= editedAt)
      ? { ...message, body, edited_at: editedAt, translated_text: translatedBody }
      : message),
  })),
  removeMessage: (messageId) => set((s) => ({
    messages: s.messages.filter(message => message.id !== messageId),
  })),
  setAccountStatus: (accountId, status) => set((s) => ({
    accounts: s.accounts.map((a) => a.id === accountId ? { ...a, status } : a),
  })),
  // PATCH 成功后同步进列表缓存，这样切走再切回来锁定状态还在，不用重新拉一次会话列表。
  updateConversationTargetLang: (id, targetLang) => set((s) => ({
    conversations: s.conversations.map((c) => c.id === id ? { ...c, target_lang: targetLang } : c),
  })),
  setNativeBridgeConnection: (accountId, connection, error = null) => set((s) => ({
    nativeBridgeByAccount: {
      ...s.nativeBridgeByAccount,
      [accountId]: {
        connection,
        error,
        notice: s.nativeBridgeByAccount[accountId]?.notice ?? null,
        platformAccountExternalId:
          s.nativeBridgeByAccount[accountId]?.platformAccountExternalId ?? null,
        context: s.nativeBridgeByAccount[accountId]?.context ?? null,
        composerCanSend: connection === 'ready'
          ? s.nativeBridgeByAccount[accountId]?.composerCanSend ?? false
          : false,
        outbox: s.nativeBridgeByAccount[accountId]?.outbox,
      },
    },
  })),
  setNativeBridgeNotice: (accountId, notice) => set((s) => {
    const current = s.nativeBridgeByAccount[accountId]
    if (!current) return {}
    return {
      nativeBridgeByAccount: {
        ...s.nativeBridgeByAccount,
        [accountId]: { ...current, notice },
      },
    }
  }),
  setNativeOutboxStatus: (accountId, status) => set((s) => {
    const current = s.nativeBridgeByAccount[accountId]
    if (!current) return {}
    return {
      nativeBridgeByAccount: {
        ...s.nativeBridgeByAccount,
        [accountId]: { ...current, outbox: status },
      },
    }
  }),
  setNativeAccountIdentity: (accountId, platformAccountExternalId) => set((s) => ({
    nativeBridgeByAccount: {
      ...s.nativeBridgeByAccount,
      [accountId]: {
        connection: s.nativeBridgeByAccount[accountId]?.connection ?? 'waiting',
        error: s.nativeBridgeByAccount[accountId]?.error ?? null,
        notice: s.nativeBridgeByAccount[accountId]?.notice ?? null,
        platformAccountExternalId,
        context: s.nativeBridgeByAccount[accountId]?.context ?? null,
        composerCanSend: s.nativeBridgeByAccount[accountId]?.composerCanSend ?? false,
        outbox: s.nativeBridgeByAccount[accountId]?.outbox,
      },
    },
  })),
  setNativeContext: (accountId, context) => set((s) => ({
    nativeBridgeByAccount: {
      ...s.nativeBridgeByAccount,
      [accountId]: {
        connection: s.nativeBridgeByAccount[accountId]?.connection ?? 'waiting',
        error: s.nativeBridgeByAccount[accountId]?.error ?? null,
        notice: s.nativeBridgeByAccount[accountId]?.notice ?? null,
        platformAccountExternalId:
          s.nativeBridgeByAccount[accountId]?.platformAccountExternalId ?? null,
        context,
        composerCanSend: false,
        outbox: s.nativeBridgeByAccount[accountId]?.outbox,
      },
    },
    ...(s.activeAccountId === accountId ? {
      activeConversationId: context?.conversationId ?? null,
      messages: [],
    } : {}),
  })),
  resolveNativeConversation: (
    accountId,
    contextRevision,
    platformConversationId,
    conversationId,
  ) => set((s) => {
    const current = s.nativeBridgeByAccount[accountId]
    if (!current?.context
      || current.context.contextRevision !== contextRevision
      || current.context.platformConversationId !== platformConversationId) return {}
    return {
      nativeBridgeByAccount: {
        ...s.nativeBridgeByAccount,
        [accountId]: {
          ...current,
          context: { ...current.context, conversationId },
        },
      },
      ...(s.activeAccountId === accountId ? { activeConversationId: conversationId } : {}),
    }
  }),
  applyNativeComposerState: (
    accountId,
    contextRevision,
    platformConversationId,
    draft,
    canSend,
  ) => set((s) => {
    const current = s.nativeBridgeByAccount[accountId]
    if (!current?.context
      || current.context.contextRevision !== contextRevision
      || current.context.platformConversationId !== platformConversationId
      || !current.context.conversationId) return {}

    const key = `${accountId}:${current.context.conversationId}`
    const existing = s.nativeDrafts[key]
    const busy = existing?.status === 'configuring'
      || existing?.status === 'translating'
      || existing?.status === 'sending'
    const hasDraft = draft.trim() !== ''
    const nextDrafts = { ...s.nativeDrafts }
    if (existing && !busy) {
      if (existing.status === 'ready' && !hasDraft) {
        // 原生框在 ready 后被清空，通常表示用户从原生端发送/删除了草稿。
        // 清掉外壳的可发送门禁，避免再点一次发送重复消息。
        nextDrafts[key] = {
          ...existing,
          translatedText: '',
          backTranslated: null,
          status: 'idle',
          error: null,
          sendAttemptId: null,
          sendAttemptDraft: null,
        }
      } else if (existing.status === 'ready') {
        nextDrafts[key] = {
          ...existing,
          error: canSend ? null : '原生输入框当前不可发送',
        }
      }
    }
    return {
      nativeBridgeByAccount: {
        ...s.nativeBridgeByAccount,
        [accountId]: { ...current, composerCanSend: canSend && hasDraft },
      },
      // composer.state 只是原生框事实，不能自行创建“已翻译 ready”。
      // 否则改回复语言后，原生框里的旧语言草稿会重新开启发送。
      nativeDrafts: nextDrafts,
    }
  }),
  updateNativeDraft: (key, patch) => set((s) => ({
    nativeDrafts: {
      ...s.nativeDrafts,
      [key]: { ...(s.nativeDrafts[key] ?? EMPTY_DRAFT), ...patch },
    },
  })),
  clearNativeDraft: (key) => set((s) => {
    const next = { ...s.nativeDrafts }
    delete next[key]
    return { nativeDrafts: next }
  }),
  reset: () => set({
    accounts: [],
    conversations: [],
    messages: [],
    activeConversationId: null,
    activePlatform: 'telegram',
    activeAccountId: null,
    lastActiveAccountByPlatform: {},
    nativeBridgeByAccount: {},
    nativeDrafts: {},
    authChallenge: null,
    authDone: null,
  }),
}))
