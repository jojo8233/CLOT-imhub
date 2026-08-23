import { useEffect } from 'react'
import { api } from './api/client.js'
import { useStore } from './store.js'
import { AccountList } from './components/AccountList.js'
import { MessageList } from './components/MessageList.js'
import { Composer } from './components/Composer.js'

export function App() {
  const setAccounts = useStore(s => s.setAccounts)
  const setConversations = useStore(s => s.setConversations)
  const setMessages = useStore(s => s.setMessages)
  const setActiveConversation = useStore(s => s.setActiveConversation)
  const applyTranslation = useStore(s => s.applyTranslation)
  const conversations = useStore(s => s.conversations)
  const activeId = useStore(s => s.activeConversationId)

  useEffect(() => {
    void (async () => {
      // TODO(P0): 没有登录页。硬编码一个开发账号直登，跑通"看账号 -> 看会话 ->
      // 看消息 -> 发消息"这条主链路。这两个凭证要跟 Task 15 的 seed 脚本创建的
      // 开发用户保持一致；真正的登录界面（邮箱+密码表单、错误提示、记住登录状态）
      // 留给 P1。login() 必须先于 listAccounts/listConversations/connectWs 完成
      // ——api/client.ts 的 token 是模块级变量，connectWs 的首帧鉴权靠它，顺序不能乱。
      await api.login('agent@example.com', 'dev-password')
      setAccounts((await api.listAccounts()).accounts)
      setConversations((await api.listConversations()).conversations)
      api.connectWs((event) => {
        if (event.type === 'translation') applyTranslation(event.messageId, event.translatedText)
      })
    })()
  }, [])

  useEffect(() => {
    if (!activeId) return
    void api.listMessages(activeId).then(r => setMessages(r.messages))
  }, [activeId])

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui' }}>
      <AccountList />
      <div style={{ width: 260, borderRight: '1px solid #e2e8f0', overflowY: 'auto' }}>
        {conversations.map(c => (
          <div
            key={c.id}
            onClick={() => setActiveConversation(c.id)}
            style={{
              padding: '10px 12px', cursor: 'pointer', fontSize: 13,
              background: c.id === activeId ? '#eff6ff' : undefined,
            }}
          >
            {c.contact_display_name ?? c.contact_external_id}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <MessageList />
        <Composer />
      </div>
    </div>
  )
}
