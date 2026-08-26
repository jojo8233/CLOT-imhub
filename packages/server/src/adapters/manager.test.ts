import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage, OutboundContent, Platform } from '@im-hub/shared'
import { AdapterManager } from './manager.js'
import type { PlatformAdapter } from './types.js'

function fakeAdapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('msg-1'),
    onMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onAuthChallenge: vi.fn(),
    onCredentialsUpdated: vi.fn(),
    onPlatformIdentityUpdated: vi.fn(),
    onMessageIdRemapped: vi.fn(),
  submitAuthAnswer: vi.fn(),
  purge: vi.fn(),
  }
}

const account = { id: 'a1', displayName: 'A', credentialsRef: null }

describe('AdapterManager', () => {
  it('按平台把 connect 路由到对应适配器', async () => {
    const tg = fakeAdapter('telegram')
    await new AdapterManager([tg]).connect('telegram', account)
    expect(tg.connect).toHaveBeenCalledWith(account)
  })

  it('记住 accountId 到平台的映射，发送时无需再传平台', async () => {
    const tg = fakeAdapter('telegram')
    const mgr = new AdapterManager([tg])
    await mgr.connect('telegram', account)
    const content: OutboundContent = { body: 'hi' }
    expect(await mgr.send('a1', 'conv-1', content)).toBe('msg-1')
    expect(tg.sendMessage).toHaveBeenCalledWith('a1', 'conv-1', content)
  })

  it('未连接的账号发送时抛出明确错误', async () => {
    const mgr = new AdapterManager([fakeAdapter('telegram')])
    await expect(mgr.send('nope', 'c', { body: 'x' }))
      .rejects.toThrow('account nope is not connected')
  })

  it('连接未注册的平台时抛错', async () => {
    const mgr = new AdapterManager([fakeAdapter('telegram')])
    await expect(mgr.connect('signal', { id: 'a2', displayName: 'B', credentialsRef: null }))
      .rejects.toThrow('no adapter registered for platform signal')
  })

  it('connect 失败时不记录映射，避免后续 send 打到一个没连上的账号', async () => {
    const tg = fakeAdapter('telegram')
    tg.connect = vi.fn().mockRejectedValue(new Error('login failed'))
    const mgr = new AdapterManager([tg])
    await expect(mgr.connect('telegram', account)).rejects.toThrow('login failed')
    await expect(mgr.send('a1', 'c', { body: 'x' })).rejects.toThrow('account a1 is not connected')
  })

  it('把各适配器的消息汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((m: NormalizedMessage) => void)[] = []
    tg.onMessage = vi.fn((h) => { handlers.push(h) })

    const received: NormalizedMessage[] = []
    const mgr = new AdapterManager([tg])
    mgr.onMessage(m => received.push(m))

    const sample = { platform: 'telegram', accountId: 'a1' } as NormalizedMessage
    handlers[0]!(sample)
    expect(received).toEqual([sample])
  })

  it('把各适配器的状态变化汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, s: string) => void)[] = []
    tg.onStatusChange = vi.fn((h) => { handlers.push(h as never) })

    const seen: [string, string][] = []
    const mgr = new AdapterManager([tg])
    mgr.onStatusChange((id, s) => seen.push([id, s]))

    handlers[0]!('a1', 'connected')
    expect(seen).toEqual([['a1', 'connected']])
  })

  it('把鉴权挑战汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, c: unknown) => void)[] = []
    tg.onAuthChallenge = vi.fn((h) => { handlers.push(h as never) })

    const seen: unknown[] = []
    const mgr = new AdapterManager([tg])
    mgr.onAuthChallenge((id, c) => seen.push([id, c]))

    handlers[0]!('a1', { kind: 'qr', payload: 'sgnl://x' })
    expect(seen).toEqual([['a1', { kind: 'qr', payload: 'sgnl://x' }]])
  })

  it('把凭据更新汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, ref: string) => void)[] = []
    tg.onCredentialsUpdated = vi.fn((h) => { handlers.push(h as never) })

    const seen: [string, string][] = []
    const mgr = new AdapterManager([tg])
    mgr.onCredentialsUpdated((id, ref) => seen.push([id, ref]))

    handlers[0]!('a1', 'new-creds')
    expect(seen).toEqual([['a1', 'new-creds']])
  })

  it('把平台登录身份变化汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, externalId: string | null) => void)[] = []
    tg.onPlatformIdentityUpdated = vi.fn((handler) => { handlers.push(handler) })

    const seen: [string, string | null][] = []
    const mgr = new AdapterManager([tg])
    mgr.onPlatformIdentityUpdated((id, externalId) => seen.push([id, externalId]))

    handlers[0]!('a1', '778899')
    handlers[0]!('a1', null)
    expect(seen).toEqual([['a1', '778899'], ['a1', null]])
  })

  it('把消息 id 重映射汇聚到统一回调', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, o: string, n: string) => void)[] = []
    tg.onMessageIdRemapped = vi.fn((h) => { handlers.push(h as never) })

    const seen: [string, string, string][] = []
    const mgr = new AdapterManager([tg])
    mgr.onMessageIdRemapped((id, o, n) => seen.push([id, o, n]))

    handlers[0]!('a1', '3575644161', '3576692736')
    expect(seen).toEqual([['a1', '3575644161', '3576692736']])
  })

  it('disconnect 后账号不再可发送', async () => {
    const mgr = new AdapterManager([fakeAdapter('telegram')])
    await mgr.connect('telegram', account)
    await mgr.disconnect('a1')
    await expect(mgr.send('a1', 'c', { body: 'x' })).rejects.toThrow('account a1 is not connected')
  })

  it('disconnect 一个从未连接的账号不抛错', async () => {
    const mgr = new AdapterManager([fakeAdapter('telegram')])
    await expect(mgr.disconnect('never-connected')).resolves.toBeUndefined()
  })

  it('一个消息处理器抛异常不影响其他处理器', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((m: NormalizedMessage) => void)[] = []
    tg.onMessage = vi.fn((h) => { handlers.push(h) })

    const mgr = new AdapterManager([tg])
    const reached: string[] = []
    mgr.onMessage(() => { throw new Error('入库炸了') })
    mgr.onMessage(() => { reached.push('second') })

    const sample = { platform: 'telegram', accountId: 'a1' } as NormalizedMessage
    expect(() => handlers[0]!(sample)).not.toThrow()
    expect(reached).toEqual(['second'])
  })

  it('一个状态处理器抛异常不影响其他处理器', () => {
    const tg = fakeAdapter('telegram')
    const handlers: ((id: string, s: string) => void)[] = []
    tg.onStatusChange = vi.fn((h) => { handlers.push(h as never) })

    const mgr = new AdapterManager([tg])
    const reached: string[] = []
    mgr.onStatusChange(() => { throw new Error('写库炸了') })
    mgr.onStatusChange(() => { reached.push('second') })

    expect(() => handlers[0]!('a1', 'connected')).not.toThrow()
    expect(reached).toEqual(['second'])
  })

  it('处理器异常不会向上冒泡到适配器，避免污染连接状态', () => {
    const tg = fakeAdapter('telegram')
    const msgHandlers: ((m: NormalizedMessage) => void)[] = []
    tg.onMessage = vi.fn((h) => { msgHandlers.push(h) })

    const mgr = new AdapterManager([tg])
    mgr.onMessage(() => { throw new Error('boom') })

    // 适配器调用 fan-out 时绝不能收到异常——TDLib 会把它转成 error 事件，
    // 导致一个健康的账号被误标成 reconnecting
    const sample = { platform: 'telegram', accountId: 'a1' } as NormalizedMessage
    expect(() => msgHandlers[0]!(sample)).not.toThrow()
  })
})
