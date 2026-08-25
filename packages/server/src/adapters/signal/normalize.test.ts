import { describe, expect, it } from 'vitest'
import { normalizeSignalMessage } from './normalize.js'

const ACCOUNT_ID = 'acc-1'
const SELF = '+15559990000'
const PEER_UUID = '11111111-2222-3333-4444-555555555555'
const PEER_NUMBER = '+15551234567'

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    account: SELF,
    envelope: {
      source: PEER_NUMBER,
      sourceNumber: PEER_NUMBER,
      sourceUuid: PEER_UUID,
      sourceName: 'Alice',
      timestamp: 1_700_000_000_000,
      dataMessage: { timestamp: 1_700_000_000_000, message: 'hello', ...overrides },
    },
  }
}

describe('normalizeSignalMessage：收到的消息', () => {
  it('单聊消息归一化成入站，会话 id 带 u: 前缀', () => {
    const m = normalizeSignalMessage(incoming(), ACCOUNT_ID)
    expect(m).toMatchObject({
      platform: 'signal',
      accountId: ACCOUNT_ID,
      direction: 'in',
      body: 'hello',
      senderDisplayName: 'Alice',
    })
    expect(m?.platformConversationId).toBe(`u:${PEER_UUID}`)
  })

  it('用 UUID 而不是手机号做联系人标识', () => {
    // Signal 允许隐藏手机号，号码可能缺失或变更，UUID 不会
    const m = normalizeSignalMessage(incoming(), ACCOUNT_ID)
    expect(m?.senderExternalId).toBe(PEER_UUID)
  })

  it('没有 UUID 时退回手机号，而不是丢掉这条消息', () => {
    const raw = incoming()
    raw.envelope.sourceUuid = null as never
    const m = normalizeSignalMessage(raw, ACCOUNT_ID)
    expect(m?.senderExternalId).toBe(PEER_NUMBER)
  })

  it('群消息的会话 id 用群 id 且带 g: 前缀', () => {
    const m = normalizeSignalMessage(
      incoming({ groupInfo: { groupId: 'Z3JvdXA=' } }),
      ACCOUNT_ID,
    )
    expect(m?.platformConversationId).toBe('g:Z3JvdXA=')
    // 群里发言人仍然是那个人，不是群
    expect(m?.senderExternalId).toBe(PEER_UUID)
  })

  it('消息 id 是 发送者:timestamp——Signal 没有服务端消息 id', () => {
    const m = normalizeSignalMessage(incoming(), ACCOUNT_ID)
    expect(m?.platformMessageId).toBe(`${PEER_UUID}:1700000000000`)
  })

  it('带附件但没有正文的消息保留下来，不能丢', () => {
    const m = normalizeSignalMessage(
      incoming({ message: null, attachments: [{ id: 'att-1', contentType: 'image/jpeg', filename: 'a.jpg', size: 99 }] }),
      ACCOUNT_ID,
    )
    expect(m?.body).toBe('')
    expect(m?.mediaRefs).toEqual([
      { kind: 'image', remoteId: 'att-1', fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 99 },
    ])
  })

  it('没有 id 的附件跳过——没有 id 就无法回源下载', () => {
    const m = normalizeSignalMessage(
      incoming({ attachments: [{ contentType: 'image/jpeg' }] }),
      ACCOUNT_ID,
    )
    expect(m?.mediaRefs).toEqual([])
  })
})

describe('normalizeSignalMessage：自己在别的设备上发的', () => {
  const sync = {
    account: SELF,
    envelope: {
      source: SELF,
      sourceNumber: SELF,
      sourceUuid: 'self-uuid-aaaa',
      timestamp: 1_700_000_005_000,
      syncMessage: {
        sentMessage: {
          destination: PEER_NUMBER,
          destinationUuid: PEER_UUID,
          timestamp: 1_700_000_005_000,
          message: '你好',
        },
      },
    },
  }

  it('同步过来的消息算出站——这是员工在手机上回复的唯一来源', () => {
    const m = normalizeSignalMessage(sync, ACCOUNT_ID)
    expect(m?.direction).toBe('out')
    expect(m?.body).toBe('你好')
  })

  it('会话按收件人算，不是按发送者', () => {
    const m = normalizeSignalMessage(sync, ACCOUNT_ID)
    expect(m?.platformConversationId).toBe(`u:${PEER_UUID}`)
  })

  it('发送者一律用本账号号码，与 sendMessage 拼出的 id 保持一致', () => {
    // 两条路径算出同一个 id，(account_id, platform_message_id) 去重才认得出是同一条。
    // 若这里取了 envelope.sourceUuid，同一条消息会被存成两行。
    const m = normalizeSignalMessage(sync, ACCOUNT_ID)
    expect(m?.senderExternalId).toBe(SELF)
    expect(m?.platformMessageId).toBe(`${SELF}:1700000005000`)
  })
})

describe('normalizeSignalMessage：应当忽略的通知', () => {
  const cases: [string, unknown][] = [
    ['回执', { account: SELF, envelope: { sourceUuid: PEER_UUID, timestamp: 1, receiptMessage: { isDelivery: true } } }],
    ['输入状态', { account: SELF, envelope: { sourceUuid: PEER_UUID, timestamp: 1, typingMessage: { action: 'STARTED' } } }],
    ['空的 dataMessage（表情回应等）', { account: SELF, envelope: { sourceUuid: PEER_UUID, timestamp: 1, dataMessage: { timestamp: 1, message: null } } }],
    ['没有 sentMessage 的 syncMessage', { account: SELF, envelope: { sourceUuid: PEER_UUID, timestamp: 1, syncMessage: {} } }],
    ['没有发送者', { account: SELF, envelope: { timestamp: 1, dataMessage: { timestamp: 1, message: 'x' } } }],
    ['没有 envelope', { account: SELF }],
    ['不是对象', 'nonsense'],
    ['null', null],
  ]

  for (const [name, input] of cases) {
    it(`${name} 返回 null 而不是抛错`, () => {
      expect(normalizeSignalMessage(input, ACCOUNT_ID)).toBeNull()
    })
  }
})

describe('normalizeSignalMessage：会话名区分群与私聊', () => {
  it('私聊会话名就是对方（发言人）的名字', () => {
    const m = normalizeSignalMessage(incoming(), ACCOUNT_ID)
    expect(m?.conversationDisplayName).toBe('Alice')
  })

  it('群会话名用群名，不是发言人名——这正是"群显示成发言人"的修复点', () => {
    const m = normalizeSignalMessage(
      incoming({ groupInfo: { groupId: 'Z3JvdXA=' } }),
      ACCOUNT_ID,
      (gid) => (gid === 'Z3JvdXA=' ? '客服群' : undefined),
    )
    expect(m?.conversationDisplayName).toBe('客服群')
    // 发言人仍然是那个人
    expect(m?.senderDisplayName).toBe('Alice')
  })

  it('群名还没查到时会话名为 null，由仓储层保持已有值不动', () => {
    const m = normalizeSignalMessage(
      incoming({ groupInfo: { groupId: 'Z3JvdXA=' } }),
      ACCOUNT_ID,
      () => undefined,
    )
    expect(m?.conversationDisplayName).toBeNull()
  })
})
