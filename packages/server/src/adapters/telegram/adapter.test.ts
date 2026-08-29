import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (value: unknown) => void

const tdlMock = vi.hoisted(() => ({
  configure: vi.fn(),
  createClient: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  off: vi.fn(),
  listeners: new Map<string, Listener[]>(),
}))

vi.mock('tdl', () => ({
  configure: tdlMock.configure,
  createClient: tdlMock.createClient,
}))

vi.mock('prebuilt-tdlib', () => ({
  getTdjson: vi.fn(() => '/tmp/libtdjson.dylib'),
}))

import { TelegramAdapter } from './adapter.js'

describe('TelegramAdapter authorization startup', () => {
  beforeEach(() => {
    tdlMock.createClient.mockReset()
    tdlMock.invoke.mockReset()
    tdlMock.close.mockReset().mockResolvedValue(undefined)
    tdlMock.off.mockReset()
    tdlMock.listeners.clear()

    const client: {
      on(event: string, listener: Listener): typeof client
      off: typeof tdlMock.off
      invoke: typeof tdlMock.invoke
      close: typeof tdlMock.close
    } = {
      on(event, listener) {
        const listeners = tdlMock.listeners.get(event) ?? []
        listeners.push(listener)
        tdlMock.listeners.set(event, listeners)
        return client
      },
      off: tdlMock.off,
      invoke: tdlMock.invoke,
      close: tdlMock.close,
    }
    tdlMock.createClient.mockReturnValue(client)

    tdlMock.invoke.mockImplementation(async (request: { _: string }) => {
      if (request._ === 'getAuthorizationState') {
        // 模拟 createClient 已收到并缓存初始状态，但业务 update listener
        // 挂载后再也没有新的 authorization update。
        return { _: 'authorizationStateWaitPhoneNumber' }
      }
      if (request._ === 'requestQrCodeAuthentication') {
        const update = {
          _: 'updateAuthorizationState',
          authorization_state: {
            _: 'authorizationStateWaitOtherDeviceConfirmation',
            link: 'tg://login?token=test-only',
          },
        }
        for (const listener of tdlMock.listeners.get('update') ?? []) listener(update)
        return { _: 'ok' }
      }
      if (request._ === 'getMessage') {
        return {
          _: 'message',
          id: 3502 * 2 ** 20,
          sender_id: { _: 'messageSenderUser', user_id: 8972860767 },
          chat_id: 6639331234,
          is_outgoing: false,
          date: 1787960000,
          edit_date: 1787960060,
          content: {
            _: 'messageText',
            text: { _: 'formattedText', text: 'S4 edited', entities: [] },
          },
        }
      }
      throw new Error(`unexpected TDLib request: ${request._}`)
    })
  })

  it('恢复监听器挂载前已经缓存的鉴权状态并下发二维码', async () => {
    const adapter = new TelegramAdapter({
      apiId: 1,
      apiHash: 'test-hash',
      dataDir: '/tmp/im-hub-tdlib-test',
    })
    const challenges: Array<{ accountId: string; kind: string; payload: string }> = []
    adapter.onAuthChallenge((accountId, challenge) => {
      challenges.push({ accountId, kind: challenge.kind, payload: challenge.payload })
    })

    await adapter.connect({ id: 'account-1', displayName: 'Account 1', credentialsRef: null })

    await vi.waitFor(() => {
      expect(challenges).toEqual([{
        accountId: 'account-1',
        kind: 'qr',
        payload: 'tg://login?token=test-only',
      }])
    })
    expect(tdlMock.invoke).toHaveBeenCalledWith({ _: 'getAuthorizationState' })
  })

  it('把服务端删除更新转换成账号级规范键并忽略纯缓存清理', async () => {
    const tdlibMessageId = (serverMessageId: number): number => serverMessageId * 2 ** 20
    const adapter = new TelegramAdapter({
      apiId: 1,
      apiHash: 'test-hash',
      dataDir: '/tmp/im-hub-tdlib-test',
    })
    const deleted: Array<{ accountId: string; platformMessageId: string }> = []
    adapter.onMessageDeleted((accountId, platformMessageId) => {
      deleted.push({ accountId, platformMessageId })
    })
    await adapter.connect({ id: 'account-1', displayName: 'Account 1', credentialsRef: null })

    for (const listener of tdlMock.listeners.get('update') ?? []) {
      listener({
        _: 'updateDeleteMessages',
        chat_id: 6639331234,
        message_ids: [tdlibMessageId(3497), tdlibMessageId(3498), tdlibMessageId(3498)],
        from_cache: false,
        is_permanent: true,
      })
      listener({
        _: 'updateDeleteMessages',
        chat_id: 6639331234,
        message_ids: [tdlibMessageId(3499)],
        from_cache: true,
        is_permanent: false,
      })
    }

    expect(deleted).toEqual([
      { accountId: 'account-1', platformMessageId: '6639331234:3497' },
      { accountId: 'account-1', platformMessageId: '6639331234:3498' },
    ])
  })

  it('在正文变更 update 后读取完整消息并发出可比较的编辑快照', async () => {
    const adapter = new TelegramAdapter({
      apiId: 1,
      apiHash: 'test-hash',
      dataDir: '/tmp/im-hub-tdlib-test',
    })
    const messages: Array<{
      platformMessageId: string
      body: string
      editedAt: Date | null | undefined
      editVersion: number | null | undefined
    }> = []
    adapter.onMessage(message => {
      messages.push({
        platformMessageId: message.platformMessageId,
        body: message.body,
        editedAt: message.editedAt,
        editVersion: message.editVersion,
      })
    })
    await adapter.connect({ id: 'account-1', displayName: 'Account 1', credentialsRef: null })

    for (const listener of tdlMock.listeners.get('update') ?? []) {
      listener({
        _: 'updateMessageEdited',
        chat_id: 6639331234,
        message_id: 3502 * 2 ** 20,
        edit_date: 1787960060,
      })
    }
    expect(messages).toEqual([])

    for (const listener of tdlMock.listeners.get('update') ?? []) {
      listener({
        _: 'updateMessageContent',
        chat_id: 6639331234,
        message_id: 3502 * 2 ** 20,
        new_content: {
          _: 'messageText',
          text: { _: 'formattedText', text: 'S4 edited', entities: [] },
        },
      })
    }

    await vi.waitFor(() => {
      expect(messages).toEqual([{
        platformMessageId: '6639331234:3502',
        body: 'S4 edited',
        editedAt: new Date(1787960060 * 1000),
        editVersion: null,
      }])
    })
    expect(tdlMock.invoke).toHaveBeenCalledWith({
      _: 'getMessage', chat_id: 6639331234, message_id: 3502 * 2 ** 20,
    })
  })
})
