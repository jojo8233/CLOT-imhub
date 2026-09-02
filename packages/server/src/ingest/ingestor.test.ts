import { describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '@im-hub/shared'
import { MessageIngestor } from './ingestor.js'

function sample(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    platform: 'telegram',
    accountId: 'acc-1',
    platformConversationId: '-100123',
    platformMessageId: '555',
    direction: 'in',
    senderExternalId: '777000',
    senderDisplayName: 'Jane',
    conversationDisplayName: null,
    body: 'hello',
    mediaRefs: [],
    sentAt: new Date('2026-08-24T00:00:00Z'),
    raw: {},
    ...overrides,
  }
}

function fakeRepo() {
  return {
    upsertConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
    insertMessage: vi.fn().mockResolvedValue({ id: 'msg-1', isNew: true, contentChanged: false }),
    touchConversation: vi.fn().mockResolvedValue(undefined),
  }
}

function fakeQueue() {
  return { enqueueTranslate: vi.fn().mockResolvedValue(undefined) }
}

describe('MessageIngestor', () => {
  it('先 upsert 会话再插消息', async () => {
    const repo = fakeRepo()
    const id = await new MessageIngestor(repo as never, fakeQueue() as never).ingest(sample())

    expect(repo.upsertConversation).toHaveBeenCalledWith({
      accountId: 'acc-1',
      platformConversationId: '-100123',
      contactExternalId: '777000',
      contactDisplayName: 'Jane',
    })
    expect(repo.insertMessage).toHaveBeenCalledOnce()
    expect(id).toBe('msg-1')
  })

  it('入库后把消息推进翻译队列', async () => {
    const repo = fakeRepo()
    const queue = fakeQueue()
    await new MessageIngestor(repo as never, queue as never).ingest(sample())
    expect(queue.enqueueTranslate).toHaveBeenCalledWith({
      messageId: 'msg-1', conversationId: 'conv-1', revision: 'initial',
    })
  })

  it('先通知消息已存储，再让翻译任务进入可消费队列', async () => {
    const order: string[] = []
    const queue = {
      enqueueTranslate: vi.fn(async () => { order.push('queue') }),
    }
    await new MessageIngestor(fakeRepo() as never, queue as never)
      .ingestDetailed(sample(), () => { order.push('stored') })
    expect(order).toEqual(['stored', 'queue'])
  })

  it('重复消息返回 null，但仍派发翻译任务以补偿此前可能丢失的派发', async () => {
    const repo = fakeRepo()
    repo.insertMessage.mockResolvedValue({ id: 'msg-1', isNew: false, contentChanged: false })
    const queue = fakeQueue()
    const id = await new MessageIngestor(repo as never, queue as never).ingest(sample())
    expect(id).toBeNull()
    expect(queue.enqueueTranslate).toHaveBeenCalledWith({
      messageId: 'msg-1', conversationId: 'conv-1', revision: 'initial',
    })
  })

  it('重复消息仍补偿 touch，会话时间由 repo 保证只前进', async () => {
    const repo = fakeRepo()
    repo.insertMessage.mockResolvedValue({ id: 'msg-1', isNew: false, contentChanged: false })
    await new MessageIngestor(repo as never, fakeQueue() as never).ingest(sample())
    expect(repo.touchConversation).toHaveBeenCalledWith('conv-1', sample().sentAt)
  })

  it('Telegram 出向消息也入库但不扩张既有翻译边界', async () => {
    const repo = fakeRepo()
    const queue = fakeQueue()
    await new MessageIngestor(repo as never, queue as never).ingest(sample({ direction: 'out' }))
    expect(repo.insertMessage.mock.calls[0]![0]).toMatchObject({ direction: 'out' })
    expect(queue.enqueueTranslate).not.toHaveBeenCalled()
  })

  it('Signal 纯文字出向消息入库后进入双语翻译队列', async () => {
    const queue = fakeQueue()
    await new MessageIngestor(fakeRepo() as never, queue as never).ingest(sample({
      platform: 'signal', direction: 'out',
      platformConversationId: 'u:peer', platformMessageId: 'self:123',
    }))
    expect(queue.enqueueTranslate).toHaveBeenCalledWith({
      messageId: 'msg-1', conversationId: 'conv-1', revision: 'initial',
    })
  })

  it('入库成功后更新会话的 last_message_at', async () => {
    const repo = fakeRepo()
    const at = new Date('2026-08-24T12:00:00Z')
    await new MessageIngestor(repo as never, fakeQueue() as never).ingest(sample({ sentAt: at }))
    expect(repo.touchConversation).toHaveBeenCalledWith('conv-1', at)
  })

  it('把归一化消息的全部字段原样传给 insertMessage', async () => {
    const repo = fakeRepo()
    const msg = sample({ mediaRefs: [{ kind: 'image', remoteId: 'f1' }], raw: { _: 'x' } })
    await new MessageIngestor(repo as never, fakeQueue() as never).ingest(msg)
    expect(repo.insertMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      accountId: 'acc-1',
      platform: 'telegram',
      platformMessageId: '555',
      direction: 'in',
      senderExternalId: '777000',
      body: 'hello',
      mediaRefs: [{ kind: 'image', remoteId: 'f1' }],
      replyToPlatformMessageId: null,
      editedAt: null,
      editVersion: null,
      sentAt: msg.sentAt,
      raw: { _: 'x' },
    })
  })

  it('只在明确指定 shadow 来源时生成不含正文的 Telegram 观测', async () => {
    const repo = fakeRepo()
    await new MessageIngestor(repo as never, fakeQueue() as never)
      .ingestDetailed(sample(), undefined, 'tdlib')

    expect(repo.insertMessage.mock.calls[0]![0]).toMatchObject({
      shadowObservation: {
        accountId: 'acc-1', source: 'tdlib', eventType: 'upsert',
        factKey: 'upsert:555:base', semanticHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
  })

  it('单调 editVersion 进入翻译 revision，避免同秒连续编辑共用任务', async () => {
    const queue = fakeQueue()
    await new MessageIngestor(fakeRepo() as never, queue as never).ingest(sample({
      editedAt: new Date('2026-08-26T01:00:00Z'), editVersion: 42,
    }))
    expect(queue.enqueueTranslate).toHaveBeenCalledWith({
      messageId: 'msg-1', conversationId: 'conv-1', revision: 'version:42',
    })
  })

  it('队列派发失败不回滚已落库的消息，但要把异常抛给调用方', async () => {
    const repo = fakeRepo()
    const queue = { enqueueTranslate: vi.fn().mockRejectedValue(new Error('redis down')) }
    await expect(new MessageIngestor(repo as never, queue as never).ingest(sample()))
      .rejects.toThrow('redis down')
    // 消息本身已经入库，不应因为队列故障而丢失
    expect(repo.insertMessage).toHaveBeenCalledOnce()
  })

  it('纯媒体消息正常落库但不派发空正文翻译任务', async () => {
    const repo = fakeRepo()
    const queue = fakeQueue()
    await new MessageIngestor(repo as never, queue as never).ingest(sample({
      body: '', mediaRefs: [{ kind: 'sticker', remoteId: 'sticker-1' }],
    }))
    expect(repo.insertMessage).toHaveBeenCalledOnce()
    expect(queue.enqueueTranslate).not.toHaveBeenCalled()
  })

  it('出向消息不传联系人字段，避免把会话对方覆盖成我方账号', async () => {
    const repo = fakeRepo()
    await new MessageIngestor(repo as never, fakeQueue() as never).ingest(sample({ direction: 'out' }))
    expect(repo.upsertConversation).toHaveBeenCalledWith({
      accountId: 'acc-1',
      platformConversationId: '-100123',
      contactExternalId: null,
      contactDisplayName: null,
    })
  })

  it('入向消息用发送者填充联系人字段', async () => {
    const repo = fakeRepo()
    await new MessageIngestor(repo as never, fakeQueue() as never).ingest(sample({ direction: 'in' }))
    expect(repo.upsertConversation).toHaveBeenCalledWith({
      accountId: 'acc-1',
      platformConversationId: '-100123',
      contactExternalId: '777000',
      contactDisplayName: 'Jane',
    })
  })
})
