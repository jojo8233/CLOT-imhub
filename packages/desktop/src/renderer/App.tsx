import { useCallback, useEffect, useRef, useState } from 'react'
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
import { AccountList } from './components/AccountList.js'
import { MessageList } from './components/MessageList.js'
import { Composer } from './components/Composer.js'
import { LoginPage } from './components/LoginPage.js'
import { theme } from './theme.js'

type AuthState = 'checking' | 'loggedOut' | 'loggedIn'

export function App() {
  const setAccounts = useStore(s => s.setAccounts)
  const setConversations = useStore(s => s.setConversations)
  const setMessages = useStore(s => s.setMessages)
  const setActiveConversation = useStore(s => s.setActiveConversation)
  const applyTranslation = useStore(s => s.applyTranslation)
  const appendMessage = useStore(s => s.appendMessage)
  const setAccountStatus = useStore(s => s.setAccountStatus)
  const resetStore = useStore(s => s.reset)
  const conversations = useStore(s => s.conversations)
  const activeId = useStore(s => s.activeConversationId)

  // 'checking' = 正在等 session:load 返回，还不知道该显示登录页还是主界面——
  // 这段时间故意不渲染登录页，避免 restore 成功时把正在填表的用户顶掉。
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // 退回登录页的统一出口：401 全局兜底和手动登出都走这里，保证两条路径的
  // 清理动作（关 WS、清 store、清 user）完全一致，不会有一条漏做。
  const backToLogin = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
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
    setUser(loggedInUser)
    setBootError(null)
    try {
      setAccounts((await api.listAccounts()).accounts)
      setConversations((await api.listConversations()).conversations)
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        // onUnauthorized 已经把界面切回登录页了，这里不用再做什么，
        // 更不能往下继续把 authState 又设回 loggedIn。
        return
      }
      if (e instanceof NetworkError) {
        setBootError('连不上服务端，检查它是否在运行')
      } else {
        console.error('[bootstrap] 拉取账号/会话列表失败', e)
      }
      // 网络错误或其它错误：不是鉴权问题，允许继续进主界面（列表可能是空的），
      // 好过卡死在白屏或"检查登录状态…"上出不去。
    }
    wsRef.current?.close()
    wsRef.current = api.connectWs((event) => {
      if (event.type === 'translation') {
        applyTranslation(event.messageId, event.translatedText)
        return
      }
      if (event.type === 'account_status') {
        setAccountStatus(event.accountId, event.status)
        return
      }
      if (event.type === 'message') {
        // 会话列表可能因为这条消息新增了会话，或需要重排——整体重拉最省事，
        // 上限 200 行，开销可以忽略。401 会由全局兜底处理，这里只吞掉不重复处理。
        void api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {})
        // 只有正在看的那个会话才需要把消息插进列表
        if (event.conversationId === useStore.getState().activeConversationId) {
          appendMessage({
            id: event.messageId,
            direction: event.direction,
            body: event.body,
            sent_at: event.sentAt,
            translated_text: event.translatedBody,
          })
        }
      }
    })
    setAuthState('loggedIn')
  }, [setAccounts, setConversations, applyTranslation, setAccountStatus, appendMessage])

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
    return () => { wsRef.current?.close() }
    // 只在挂载时跑一次，bootstrap 走 ref 闭包即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeId) return
    // 401 交给全局兜底处理，这里只需要不让 rejection 变成 unhandled
    void api.listMessages(activeId).then(r => setMessages(r.messages)).catch(() => {})
  }, [activeId])

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
      display: 'flex', flexDirection: 'column', height: '100vh',
      fontFamily: theme.font.sans, background: theme.color.bg, color: theme.color.text,
    }}>
      {bootError && (
        <div style={{
          padding: '6px 12px', fontSize: theme.font.size.sm, color: theme.color.danger,
          background: theme.color.dangerSoft, borderBottom: `1px solid ${theme.color.border}`,
        }}>
          {bootError}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <AccountList currentUserName={user?.displayName ?? null} onLogout={() => void handleLogout()} />
        <div style={{
          width: 260, borderRight: `1px solid ${theme.color.border}`, overflowY: 'auto',
          background: theme.color.bg,
        }}>
          {conversations.map(c => (
            <div
              key={c.id}
              onClick={() => setActiveConversation(c.id)}
              style={{
                padding: '10px 12px', cursor: 'pointer', fontSize: theme.font.size.base,
                background: c.id === activeId ? theme.color.accentSoft : theme.color.bg,
                color: theme.color.text,
              }}
            >
              {c.contact_display_name ?? c.contact_external_id}
            </div>
          ))}
        </div>
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: theme.color.bg,
        }}>
          <MessageList />
          <Composer />
        </div>
      </div>
    </div>
  )
}
