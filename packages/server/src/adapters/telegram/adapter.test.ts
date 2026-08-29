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
})
