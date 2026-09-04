import { describe, expect, it, vi } from 'vitest'
import type { WsKeywordAlertEvent } from '@im-hub/shared'
import { signSession } from '../auth/session.js'
import { authenticateWsSession, WsHub } from './ws.js'

const OPEN = 1

function fakeSocket(readyState = OPEN) {
  const closeHandlers: (() => void)[] = []
  return {
    readyState,
    OPEN,
    send: vi.fn(),
    close: vi.fn(),
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

  it('关键词告警只发给目标用户并序列化为五字段无敏感正文提示', () => {
    const hub = new WsHub()
    const recipient = fakeSocket()
    const otherUser = fakeSocket()
    const contextSentinels = {
      recipientId: 'RECIPIENT-ID-MUST-NOT-BE-PAYLOAD',
      body: 'BODY-MUST-NOT-LEAK',
      pattern: 'PATTERN-MUST-NOT-LEAK',
      accountId: 'ACCOUNT-ID-MUST-NOT-LEAK',
      conversationId: 'CONVERSATION-ID-MUST-NOT-LEAK',
      messageId: 'MESSAGE-ID-MUST-NOT-LEAK',
      ruleId: 'RULE-ID-MUST-NOT-LEAK',
    }
    const keywordAlertEvent: WsKeywordAlertEvent = {
      type: 'keyword_alert',
      alertId: 'alert-1',
      severity: 'urgent',
      requiresAcknowledgement: true,
      createdAt: '2026-09-03T10:00:00.000Z',
    }
    hub.add(contextSentinels.recipientId, recipient as never)
    hub.add('other-user', otherUser as never)

    hub.publishTo(contextSentinels.recipientId, keywordAlertEvent)

    expect(recipient.send).toHaveBeenCalledOnce()
    expect(otherUser.send).not.toHaveBeenCalled()
    const rawPayload = recipient.send.mock.calls[0]?.[0]
    if (typeof rawPayload !== 'string') throw new Error('expected serialized WebSocket payload')
    const parsedPayload: unknown = JSON.parse(rawPayload)
    if (typeof parsedPayload !== 'object' || parsedPayload === null || Array.isArray(parsedPayload)) {
      throw new Error('expected object WebSocket payload')
    }
    const payload = parsedPayload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'alertId',
      'createdAt',
      'requiresAcknowledgement',
      'severity',
      'type',
    ])
    expect(payload).toEqual(keywordAlertEvent)
    for (const sentinel of Object.values(contextSentinels)) {
      expect(rawPayload).not.toContain(sentinel)
    }
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

  it('撤权先发送固定事件再关闭同一用户的全部连接', () => {
    const hub = new WsHub()
    const first = fakeSocket()
    const second = fakeSocket()
    const other = fakeSocket()
    hub.add('u1', first as never)
    hub.add('u1', second as never)
    hub.add('u2', other as never)

    hub.revokeUser('u1')

    for (const socket of [first, second]) {
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'session_revoked' }))
      expect(socket.close).toHaveBeenCalledWith(4001, 'session revoked')
      expect(socket.send.mock.invocationCallOrder[0])
        .toBeLessThan(socket.close.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER)
    }
    expect(other.send).not.toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
  })

  it('WebSocket 首帧拒绝数据库版本已经变化的旧会话', async () => {
    const token = await signSession({ userId: 'u1', sessionVersion: 1 }, 'ws-auth-secret-at-least-16-chars')
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u1', role: 'agent', disabled_at: null, session_version: 2,
      }),
      findMemberships: vi.fn(),
    }

    await expect(authenticateWsSession(
      token,
      'ws-auth-secret-at-least-16-chars',
      repo,
    )).rejects.toThrow('invalid session actor')
    expect(repo.findMemberships).not.toHaveBeenCalled()
  })
})
