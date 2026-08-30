import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountRow } from './api/client.js'
import { useStore } from './store.js'

function account(id: string, platform: string): AccountRow {
  return {
    id,
    platform,
    owner_user_id: id,
    display_name: id,
    status: 'connected',
    history_available_from: null,
    connection_mode: platform === 'signal'
      ? 'native_desktop'
      : platform === 'whatsapp'
        ? 'web_shell'
        : 'adapter',
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
      id: 'm1', platform_message_id: 'platform-m1', direction: 'in', body: 'hello', sent_at: '2026-08-26T00:00:00Z',
      edited_at: null, translated_text: null,
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

  it('原生会话解析只接受当前 revision，迟到响应不能覆盖新会话', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-old', contactExternalId: 'u-old', contactDisplayName: null,
      contextRevision: 1, conversationId: null,
    })
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-new', contactExternalId: 'u-new', contactDisplayName: null,
      contextRevision: 2, conversationId: null,
    })
    useStore.getState().resolveNativeConversation('tg-1', 1, 'chat-old', 'server-old')
    expect(useStore.getState().nativeBridgeByAccount['tg-1']?.context).toMatchObject({
      platformConversationId: 'chat-new', contextRevision: 2, conversationId: null,
    })
  })

  it('新 guest 复用 revision 时，旧进程响应不能把会话 UUID 串到新会话', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-new', contactExternalId: 'u-new', contactDisplayName: null,
      contextRevision: 1, conversationId: null,
    })
    useStore.getState().resolveNativeConversation('tg-1', 1, 'chat-old', 'server-old')
    expect(useStore.getState().nativeBridgeByAccount['tg-1']?.context).toMatchObject({
      platformConversationId: 'chat-new', contextRevision: 1, conversationId: null,
    })
  })

  it('草稿按账号和服务端会话隔离', () => {
    useStore.getState().updateNativeDraft('tg-1:conv-1', { sourceText: '甲' })
    useStore.getState().updateNativeDraft('tg-1:conv-2', { sourceText: '乙' })
    useStore.getState().updateNativeDraft('tg-2:conv-1', { sourceText: '丙' })
    expect(useStore.getState().nativeDrafts).toMatchObject({
      'tg-1:conv-1': { sourceText: '甲' },
      'tg-1:conv-2': { sourceText: '乙' },
      'tg-2:conv-1': { sourceText: '丙' },
    })
  })

  it('outbox 指标按账号保存且不改变 Composer 控制状态', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    useStore.getState().setNativeOutboxStatus('tg-1', {
      pendingCount: 4,
      deadLetterCount: 1,
      isSending: true,
      lastErrorCode: 'permanent_rejection',
    })
    useStore.getState().setNativeAccountIdentity('tg-1', '123456')
    expect(useStore.getState().nativeBridgeByAccount['tg-1']).toMatchObject({
      connection: 'ready',
      platformAccountExternalId: '123456',
      outbox: { pendingCount: 4, deadLetterCount: 1, isSending: true },
    })
    expect(useStore.getState().nativeBridgeByAccount['tg-2']?.outbox).toBeUndefined()
  })

  it('消息级提示不被身份心跳清除，只在显式成功后恢复', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    useStore.getState().setNativeBridgeNotice('tg-1', '当前媒体尚未支持')
    useStore.getState().setNativeAccountIdentity('tg-1', '123456')
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    expect(useStore.getState().nativeBridgeByAccount['tg-1']?.notice)
      .toBe('当前媒体尚未支持')

    useStore.getState().setNativeBridgeNotice('tg-1', null)
    expect(useStore.getState().nativeBridgeByAccount['tg-1']?.notice).toBeNull()
  })

  it('只接受当前会话 revision 的 composer 状态，并以原生框可发送性为准', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-1', contactExternalId: 'u-1', contactDisplayName: null,
      contextRevision: 3, conversationId: 'conv-1',
    })
    useStore.getState().applyNativeComposerState('tg-1', 2, 'chat-old', '迟到草稿', true)
    expect(useStore.getState().nativeDrafts['tg-1:conv-1']).toBeUndefined()

    useStore.getState().updateNativeDraft('tg-1:conv-1', {
      sourceText: '你好', translatedText: 'hello', status: 'ready',
    })
    useStore.getState().applyNativeComposerState('tg-1', 3, 'chat-1', 'employee edited', true)
    expect(useStore.getState()).toMatchObject({
      nativeBridgeByAccount: { 'tg-1': { composerCanSend: true } },
      nativeDrafts: {
        'tg-1:conv-1': { translatedText: 'hello', status: 'ready' },
      },
    })

    useStore.getState().applyNativeComposerState('tg-1', 3, 'chat-1', '', false)
    expect(useStore.getState()).toMatchObject({
      nativeBridgeByAccount: { 'tg-1': { composerCanSend: false } },
      nativeDrafts: { 'tg-1:conv-1': { translatedText: '', status: 'idle' } },
    })
  })

  it('首次 composer 状态到达时没有本地草稿也不会抛错或伪造 ready', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-1', contactExternalId: 'u-1', contactDisplayName: null,
      contextRevision: 1, conversationId: 'conv-1',
    })

    expect(() => {
      useStore.getState().applyNativeComposerState('tg-1', 1, 'chat-1', 'native draft', true)
    }).not.toThrow()
    expect(useStore.getState().nativeBridgeByAccount['tg-1']?.composerCanSend).toBe(true)
    expect(useStore.getState().nativeDrafts['tg-1:conv-1']).toBeUndefined()
  })

  it('Signal 自动发送启用后按原生 canSend=false 关闭草稿发送门禁', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('sig-1', 'ready')
    useStore.getState().setNativeContext('sig-1', {
      platformConversationId: 'u:peer', contactExternalId: 'peer', contactDisplayName: null,
      contextRevision: 1, conversationId: 'sig-conv-1',
    })
    useStore.getState().updateNativeDraft('sig-1:sig-conv-1', {
      sourceText: '你好', translatedText: 'hello', status: 'ready', error: null,
    })

    useStore.getState().applyNativeComposerState('sig-1', 1, 'u:peer', 'hello', false)

    expect(useStore.getState()).toMatchObject({
      nativeBridgeByAccount: { 'sig-1': { composerCanSend: false } },
      nativeDrafts: {
        'sig-1:sig-conv-1': { status: 'ready', error: '原生输入框当前不可发送' },
      },
    })
  })

  it('Signal 进程重启后恢复原 attemptId、正文指纹与首次 context revision', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('sig-1', 'ready')
    useStore.getState().setNativeContext('sig-1', {
      platformConversationId: 'u:peer', contactExternalId: 'peer', contactDisplayName: null,
      contextRevision: 1, conversationId: 'sig-conv-1',
    })

    useStore.getState().applyNativeComposerState('sig-1', 1, 'u:peer', '', false, {
      attemptId: 'attempt-before-restart',
      contextRevision: 4,
      draftFingerprint: 'a'.repeat(64),
      platformMessageId: 'sender:123',
    })

    expect(useStore.getState().nativeDrafts['sig-1:sig-conv-1']).toMatchObject({
      status: 'failed',
      sendAttemptId: 'attempt-before-restart',
      sendAttemptFingerprint: 'a'.repeat(64),
      sendAttemptContextRevision: 4,
      sendAttemptConfirmed: true,
    })

    useStore.getState().applyNativeComposerState('sig-1', 1, 'u:peer', '', false)

    expect(useStore.getState().nativeDrafts['sig-1:sig-conv-1']).toMatchObject({
      status: 'idle',
      error: null,
      sendAttemptId: null,
      sendAttemptConfirmed: false,
    })
  })

  it('改变回复语言后，原生框旧译文不能自行重建 ready 状态', () => {
    useStore.getState().setAccounts(accounts)
    useStore.getState().setNativeBridgeConnection('tg-1', 'ready')
    useStore.getState().setNativeContext('tg-1', {
      platformConversationId: 'chat-1', contactExternalId: 'u-1', contactDisplayName: null,
      contextRevision: 3, conversationId: 'conv-1',
    })
    useStore.getState().updateNativeDraft('tg-1:conv-1', {
      sourceText: '你好', translatedText: '', status: 'idle',
    })
    useStore.getState().applyNativeComposerState('tg-1', 3, 'chat-1', 'old English', true)
    expect(useStore.getState().nativeDrafts['tg-1:conv-1']).toMatchObject({
      translatedText: '', status: 'idle',
    })
  })

  it('只把译文应用到同一正文 revision', () => {
    useStore.getState().setMessages([{
      id: 'm1', platform_message_id: 'platform-m1', direction: 'in', body: 'edited', sent_at: '2026-08-26T00:00:00Z',
      edited_at: '2026-08-26T01:00:00.000Z', translated_text: null,
    }])
    useStore.getState().applyTranslation('m1', '旧译文', 'initial')
    expect(useStore.getState().messages[0]?.translated_text).toBeNull()
    useStore.getState().applyTranslation('m1', '新译文', '2026-08-26T01:00:00.000Z')
    expect(useStore.getState().messages[0]?.translated_text).toBe('新译文')
  })

  it('编辑更新原子带入已有译文，且迟到旧 revision 不能回退正文', () => {
    useStore.getState().setMessages([{
      id: 'm1', platform_message_id: 'platform-m1', direction: 'in', body: 'v2', sent_at: '2026-08-26T00:00:00Z',
      edited_at: '2026-08-26T02:00:00.000Z', translated_text: '译文 v2',
    }])
    useStore.getState().updateMessage(
      'm1', 'v1', '2026-08-26T01:00:00.000Z', '译文 v1',
    )
    expect(useStore.getState().messages[0]).toMatchObject({
      body: 'v2', translated_text: '译文 v2',
    })
    useStore.getState().updateMessage(
      'm1', 'v3', '2026-08-26T03:00:00.000Z', '译文 v3',
    )
    expect(useStore.getState().messages[0]).toMatchObject({
      body: 'v3', edited_at: '2026-08-26T03:00:00.000Z', translated_text: '译文 v3',
    })
  })

})
