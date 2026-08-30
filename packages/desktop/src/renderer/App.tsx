import { useCallback, useEffect, useRef, useState } from 'react'
import { functionCenterCompact } from './layout.js'
import {
  api,
  logout as apiLogout,
  NetworkError,
  onUnauthorized,
  restoreSession,
  UnauthorizedError,
  type SessionUser,
} from './api/client.js'
import { useStore } from './store.js'
import { AccountTabs } from './components/AccountTabs.js'
import { AccountsView } from './components/AccountsView.js'
import { AddAccountDialog, RelinkAccountDialog } from './components/AddAccountDialog.js'
import { NativeConversationWorkspace } from './components/NativeConversationWorkspace.js'
import { FunctionCenter, type ViewKey } from './components/FunctionCenter.js'
import { LoginPage } from './components/LoginPage.js'
import type { ChatPlatform } from './navigation.js'
import { theme } from './theme.js'
import { BootstrapRetryController } from './bootstrap-retry.js'
import {
  nativeMessageTranslationBridge,
  nativeMessageTranslationsFromRows,
} from './native-bridge.js'

type AuthState = 'checking' | 'loggedOut' | 'loggedIn'

export function App() {
  const setAccounts = useStore(s => s.setAccounts)
  const setConversations = useStore(s => s.setConversations)
  const setMessages = useStore(s => s.setMessages)
  const applyTranslation = useStore(s => s.applyTranslation)
  const appendMessage = useStore(s => s.appendMessage)
  const updateMessage = useStore(s => s.updateMessage)
  const removeMessage = useStore(s => s.removeMessage)
  const setAccountStatus = useStore(s => s.setAccountStatus)
  const resetStore = useStore(s => s.reset)
  const activeId = useStore(s => s.activeConversationId)
  const activePlatform = useStore(s => s.activePlatform)

  const [view, setView] = useState<ViewKey>('chat')
  const [addOpen, setAddOpen] = useState(false)
  const [addPlatform, setAddPlatform] = useState<ChatPlatform>('telegram')
  const [relinkAccount, setRelinkAccount] = useState<{
    id: string
    platform: ChatPlatform
    displayName: string
  } | null>(null)
  // 整排的宽度。只用来决定功能中心要不要强制收成图标栏——
  // 三栏自己的宽度由 ChatWorkspace 量，两处各管各的，不互相牵连。
  const [rowWidth, setRowWidth] = useState(0)
  const rowObserver = useRef<ResizeObserver | null>(null)

  // 用回调 ref 而不是 useEffect：这个节点只在登录后才挂出来，用 effect 的话
  // 依赖要跟着 authState 走，很容易出现"挂了没观察"或"重复观察"。回调 ref
  // 在节点出现和消失时各调一次，绑定与清理天然成对。
  const attachRow = useCallback((el: HTMLDivElement | null) => {
    rowObserver.current?.disconnect()
    rowObserver.current = null
    if (!el) return
    const ro = new ResizeObserver((entries) => { setRowWidth(entries[0]?.contentRect.width ?? 0) })
    ro.observe(el)
    rowObserver.current = ro
  }, [])

  useEffect(() => () => { rowObserver.current?.disconnect() }, [])

  // 'checking' = 正在等 session:load 返回，还不知道该显示登录页还是主界面——
  // 这段时间故意不渲染登录页，避免 restore 成功时把正在填表的用户顶掉。
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const bootstrapRef = useRef<((user: SessionUser) => Promise<void>) | null>(null)
  const bootRetryRef = useRef<BootstrapRetryController | null>(null)
  bootRetryRef.current ??= new BootstrapRetryController()
  const authGenerationRef = useRef(0)
  const messageMutationRevisionRef = useRef(0)
  const messageLoadGenerationRef = useRef(0)

  // HTTP 列表响应可能比期间收到的 WS 事件更旧。若请求期间有消息
  // 变更，重拉一次；只有一份在途加载有权落入 store，避免旧快照覆盖新增/编辑/删除/译文。
  const refreshMessages = useCallback(async (conversationId: string): Promise<void> => {
    const generation = ++messageLoadGenerationRef.current
    while (generation === messageLoadGenerationRef.current
      && useStore.getState().activeConversationId === conversationId) {
      const before = messageMutationRevisionRef.current
      let result: Awaited<ReturnType<typeof api.listMessages>>
      try {
        result = await api.listMessages(conversationId)
      } catch {
        return
      }
      if (generation !== messageLoadGenerationRef.current
        || useStore.getState().activeConversationId !== conversationId) return
      if (before !== messageMutationRevisionRef.current) continue
      setMessages(result.messages)
      const state = useStore.getState()
      const conversation = state.conversations.find(item => item.id === conversationId)
      const account = state.accounts.find(item => item.id === conversation?.account_id)
      if (conversation && account?.platform === 'signal') {
        void nativeMessageTranslationBridge.sync(
          account.id,
          nativeMessageTranslationsFromRows(result.messages),
        ).catch(() => {})
      }
      return
    }
  }, [setMessages])

  // 退回登录页的统一出口：401 全局兜底和手动登出都走这里，保证两条路径的
  // 清理动作（关 WS、清 store、清 user）完全一致，不会有一条漏做。
  const backToLogin = useCallback(() => {
    authGenerationRef.current += 1
    messageLoadGenerationRef.current += 1
    bootRetryRef.current?.reset()
    wsRef.current?.close()
    wsRef.current = null
    void window.imHub?.nativeControl?.releaseAll().catch(() => {
      console.error('[native-control] 登出时撤销账号控制授权失败；本地能力已随页面卸载')
    })
    void window.imHub?.signalDesktop?.releaseAll().catch(() => {
      console.error('[signal-desktop] 登出时关闭 Signal Desktop 宿主失败')
    })
    resetStore()
    setUser(null)
    setBootError(null)
    setAuthState('loggedOut')
  }, [resetStore])

  // 任何请求收到 401（token 过期/失效）都会触发这个回调，不管是哪个组件发起的——
  // Composer 的翻译/发送、切会话时的拉消息，都不需要各自处理 UnauthorizedError。
  useEffect(() => {
    onUnauthorized(backToLogin)
    return () => onUnauthorized(null)
  }, [backToLogin])

  const bootstrap = useCallback(async (loggedInUser: SessionUser) => {
    bootRetryRef.current?.cancel()
    const generation = ++authGenerationRef.current
    wsRef.current?.close()
    wsRef.current = null
    setUser(loggedInUser)
    try {
      const currentSessionUser = await api.refreshSessionUser()
      if (generation !== authGenerationRef.current) return
      setUser(currentSessionUser)
      const accounts = await api.listAccounts()
      if (generation !== authGenerationRef.current) return
      setAccounts(accounts.accounts)
      const conversations = await api.listConversations()
      if (generation !== authGenerationRef.current) return
      setConversations(conversations.conversations)
      bootRetryRef.current?.reset()
      setBootError(null)
    } catch (e) {
      if (generation !== authGenerationRef.current) return
      if (e instanceof UnauthorizedError) {
        // onUnauthorized 已经把界面切回登录页了，这里不用再做什么，
        // 更不能往下继续把 authState 又设回 loggedIn。
        return
      }
      if (e instanceof NetworkError) {
        setBootError('连不上服务端，正在自动重连')
        bootRetryRef.current?.schedule(() => {
          if (generation !== authGenerationRef.current) return
          void bootstrapRef.current?.(loggedInUser)
        })
      } else {
        console.error('[bootstrap] 拉取账号/会话列表失败', e)
      }
      // 网络错误或其它错误：不是鉴权问题，允许继续进主界面（列表可能是空的），
      // 好过卡死在白屏或"检查登录状态…"上出不去。
    }
    wsRef.current = api.connectWs((event) => {
      if (generation !== authGenerationRef.current) return
      if (event.type === 'translation') {
        if (event.conversationId === useStore.getState().activeConversationId) {
          messageMutationRevisionRef.current += 1
          applyTranslation(event.messageId, event.translatedText, event.revision)
        }
        if (event.platform === 'signal') {
          void nativeMessageTranslationBridge.sync(event.accountId, [{
            platformMessageId: event.platformMessageId,
            translatedText: event.translatedText,
            revision: event.revision,
          }]).catch(() => {})
        }
        return
      }
      if (event.type === 'account_status') {
        setAccountStatus(event.accountId, event.status)
        return
      }
      if (event.type === 'auth_challenge') {
        useStore.getState().setAuthChallenge({
          accountId: event.accountId, kind: event.kind, payload: event.payload,
        })
        return
      }
      if (event.type === 'auth_done') {
        useStore.getState().setAuthDone({
          accountId: event.accountId, ok: event.ok, reason: event.reason,
        })
        // 关联成功的账号此刻才带上最终状态，整表重拉最省事
        void api.listAccounts().then((r) => {
          if (generation === authGenerationRef.current) setAccounts(r.accounts)
        }).catch(() => {})
        return
      }
      if (event.type === 'message') {
        // 会话列表可能因为这条消息新增了会话，或需要重排——整体重拉最省事，
        // 上限 200 行，开销可以忽略。401 会由全局兜底处理，这里只吞掉不重复处理。
        void api.listConversations().then((r) => {
          if (generation === authGenerationRef.current) setConversations(r.conversations)
        }).catch(() => {})
        // 只有正在看的那个会话才需要把消息插进列表
        if (event.conversationId === useStore.getState().activeConversationId) {
          messageMutationRevisionRef.current += 1
          appendMessage({
            id: event.messageId,
            platform_message_id: event.platformMessageId,
            direction: event.direction,
            body: event.body,
            sent_at: event.sentAt,
            edited_at: event.editedAt,
            translated_text: event.translatedBody,
          })
        }
        if (event.platform === 'signal' && event.direction === 'in' && event.translatedBody) {
          void nativeMessageTranslationBridge.sync(event.accountId, [{
            platformMessageId: event.platformMessageId,
            translatedText: event.translatedBody,
            revision: event.editedAt ?? 'initial',
          }]).catch(() => {})
        }
        return
      }
      if (event.type === 'message_updated') {
        if (event.conversationId === useStore.getState().activeConversationId) {
          messageMutationRevisionRef.current += 1
          updateMessage(event.messageId, event.body, event.editedAt, event.translatedBody)
        }
        return
      }
      if (event.type === 'message_deleted') {
        if (event.conversationId === useStore.getState().activeConversationId) {
          messageMutationRevisionRef.current += 1
          removeMessage(event.messageId)
        }
        return
      }
      if (event.type === 'message_merged') {
        if (event.conversationId === useStore.getState().activeConversationId) {
          messageMutationRevisionRef.current += 1
          // temp/final 两行的正文可能不同，不能只在内存里改 id。事务已经提交，
          // 直接重拉规范快照才能覆盖任意 WS 到达顺序。
          void refreshMessages(event.conversationId)
        }
      }
    })
    if (generation === authGenerationRef.current) setAuthState('loggedIn')
  }, [
    setAccounts, setConversations, applyTranslation, setAccountStatus,
    appendMessage, updateMessage, removeMessage, refreshMessages,
  ])
  bootstrapRef.current = bootstrap

  // 启动时先看磁盘上有没有加密存档的登录态：有就跳过登录页直接进主界面，
  // 没有（或 safeStorage 解不出来）就显示登录页。
  useEffect(() => {
    void (async () => {
      const restored = await restoreSession()
      if (restored) {
        await bootstrap(restored)
      } else {
        setAuthState('loggedOut')
      }
    })()
    return () => {
      authGenerationRef.current += 1
      messageLoadGenerationRef.current += 1
      bootRetryRef.current?.reset()
      wsRef.current?.close()
    }
    // 只在挂载时跑一次，bootstrap 走 ref 闭包即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeId) {
      messageLoadGenerationRef.current += 1
      return
    }
    void refreshMessages(activeId)
  }, [activeId, refreshMessages])

  async function handleLogout(): Promise<void> {
    await apiLogout()
    backToLogin()
  }

  if (authState === 'checking') {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: theme.font.sans, fontSize: theme.font.size.base, color: theme.color.textMuted,
      }}>
        正在检查登录状态…
      </div>
    )
  }

  if (authState === 'loggedOut') {
    return <LoginPage onLoginSuccess={(u) => void bootstrap(u)} />
  }

  return (
    <div style={{
      height: '100vh', padding: 14, background: theme.color.page,
      fontFamily: theme.font.sans, color: theme.color.text,
    }}>
      {/* 窗口不是白的：白色内容以一张大圆角卡片浮在灰底上，这是整套视觉的基础 */}
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        background: theme.color.bg, borderRadius: theme.radius.xxl,
        boxShadow: theme.shadow.app, overflow: 'hidden',
      }}>
        <AccountTabs
          currentUserName={user?.displayName ?? null}
          onLogout={() => void handleLogout()}
          onAddAccount={(platform) => {
            setAddPlatform(platform)
            setAddOpen(true)
          }}
        />

        {bootError && (
          <div style={{
            flexShrink: 0, padding: '7px 20px', fontSize: theme.font.size.sm,
            color: theme.color.danger, background: theme.color.dangerSoft,
            borderBottom: `1px solid ${theme.color.border}`,
          }}>
            {bootError}
          </div>
        )}

        <div ref={attachRow} style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <FunctionCenter
            view={view}
            onSelectView={setView}
            onAddAccount={() => {
              setAddPlatform(activePlatform)
              setAddOpen(true)
            }}
            compact={rowWidth > 0 && functionCenterCompact(rowWidth)}
          />

          {/* 三个平台统一进入原生工作区：Telegram/WhatsApp 使用常驻 webview，
              Signal 使用同一物理窗口内的受控 WebContentsView。 */}
          <div style={{
            display: view === 'chat' ? 'flex' : 'none',
            flex: 1,
            minWidth: 0,
            minHeight: 0,
          }}>
            <NativeConversationWorkspace />
          </div>
          {view !== 'chat' && (
            <AccountsView
              onOpenChat={() => setView('chat')}
              onRelink={setRelinkAccount}
              onAddAccount={() => {
                setAddPlatform(activePlatform)
                setAddOpen(true)
              }}
            />
          )}
        </div>
      </div>

      {addOpen && (
        <AddAccountDialog initialPlatform={addPlatform} onClose={() => setAddOpen(false)} />
      )}
      {relinkAccount && (
        <RelinkAccountDialog account={relinkAccount} onClose={() => setRelinkAccount(null)} />
      )}
    </div>
  )
}
