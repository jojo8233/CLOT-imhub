import { describe, expect, it, vi } from 'vitest'
import { WsHub } from './ws.js'

const OPEN = 1

function fakeSocket(readyState = OPEN) {
  const closeHandlers: (() => void)[] = []
  return {
    readyState,
    OPEN,
    send: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb)
    }),
    fireClose: () => closeHandlers.forEach((h) => h()),
  }
}

const event = {
  type: 'translation', messageId: 'm1', platformMessageId: 'sender:1', conversationId: 'c1',
  accountId: 'a1', platform: 'signal', targetLang: 'zh', translatedText: '你好',
  provider: 'deepl', revision: 'initial',
} as const

describe('WsHub', () => {
  it('推送给指定用户的连接', () => {
    const hub = new WsHub()
    const s = fakeSocket()
    hub.add('u1', s as never)
    hub.publishTo('u1', event)
    expect(s.send).toHaveBeenCalledWith(JSON.stringify(event))
  })

  it('同一用户的多个连接都收到', () => {
    const hub = new WsHub()
    const a = fakeSocket()
    const b = fakeSocket()
    hub.add('u1', a as never)
    hub.add('u1', b as never)
    hub.publishTo('u1', event)
    expect(a.send).toHaveBeenCalledOnce()
    expect(b.send).toHaveBeenCalledOnce()
  })

  it('不推给别的用户', () => {
    const hub = new WsHub()
    const s = fakeSocket()
    hub.add('u1', s as never)
    hub.publishTo('u2', event)
    expect(s.send).not.toHaveBeenCalled()
  })

  it('推给不存在的用户不抛错', () => {
    expect(() => new WsHub().publishTo('nobody', event)).not.toThrow()
  })

  it('未处于 OPEN 状态的连接跳过', () => {
    const hub = new WsHub()
    const s = fakeSocket(3)
    hub.add('u1', s as never)
    hub.publishTo('u1', event)
    expect(s.send).not.toHaveBeenCalled()
  })

  it('连接关闭时自动摘除，不再收到推送', () => {
    const hub = new WsHub()
    const s = fakeSocket()
    hub.add('u1', s as never)
    s.fireClose()
    hub.publishTo('u1', event)
    expect(s.send).not.toHaveBeenCalled()
  })

  it('最后一个连接关闭后不残留空集合', () => {
    const hub = new WsHub()
    const s = fakeSocket()
    hub.add('u1', s as never)
    s.fireClose()
    expect(hub.userCount()).toBe(0)
  })

  it('一个连接 send 抛异常不影响同用户的其他连接', () => {
    const hub = new WsHub()
    const bad = fakeSocket()
    bad.send = vi.fn(() => {
      throw new Error('socket closed')
    })
    const good = fakeSocket()
    hub.add('u1', bad as never)
    hub.add('u1', good as never)
    expect(() => hub.publishTo('u1', event)).not.toThrow()
    expect(good.send).toHaveBeenCalledOnce()
  })
})
