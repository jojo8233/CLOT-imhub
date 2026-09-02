import { describe, expect, it, vi } from 'vitest'
import type { NativeMessageTranslation } from '@im-hub/shared'
import { SignalDesktopTranslationStore } from './signal-desktop-translation.js'

const sender = '11111111-2222-3333-aaaa-555555555555'
const sentAtMs = 1_700_000_000_000
const platformMessageId = `${sender}:${sentAtMs}`

function model(overrides: Record<string, unknown> = {}) {
  const attributes = {
    id: 'local-message-id',
    type: 'incoming',
    sourceServiceId: sender,
    sent_at: sentAtMs,
    ...overrides,
  }
  return { attributes, get: (key: string) => attributes[key as keyof typeof attributes] }
}

function translation(overrides: Partial<NativeMessageTranslation> = {}): NativeMessageTranslation {
  return {
    platformMessageId,
    translatedText: '你好，你在做什么？',
    revision: 'initial',
    ...overrides,
  }
}

describe('SignalDesktopTranslationStore', () => {
  it('用规范 Signal 消息键解析本地模型并通知 React 快照', async () => {
    const resolved = model()
    const signalWindow = {
      __imHubSignalResolveMessageForTranslation: vi.fn().mockResolvedValue(resolved),
    }
    const store = new SignalDesktopTranslationStore(signalWindow)
    const listener = vi.fn()
    store.renderApi.subscribe(listener)

    await store.applyBatch([translation()])

    expect(signalWindow.__imHubSignalResolveMessageForTranslation)
      .toHaveBeenCalledWith(sender, sentAtMs)
    expect(store.renderApi.get('local-message-id')).toBe('你好，你在做什么？')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('拒绝 sender 或 sent_at 与规范键不一致的解析结果', async () => {
    const signalWindow = {
      __imHubSignalResolveMessageForTranslation: vi.fn()
        .mockResolvedValue(model({ sourceServiceId: 'different-sender' })),
    }
    const store = new SignalDesktopTranslationStore(signalWindow)

    await store.applyBatch([translation()])

    expect(store.renderApi.get('local-message-id')).toBeNull()
  })

  it('出站消息只接受与 Signal self conversation ACI 相同的规范 sender', async () => {
    const resolved = model({ type: 'outgoing', sourceServiceId: undefined })
    const signalWindow = {
      ConversationController: {
        getOurConversationOrThrow: () => ({ getAci: () => sender.toUpperCase() }),
      },
      __imHubSignalResolveMessageForTranslation: vi.fn().mockResolvedValue(resolved),
    }
    const store = new SignalDesktopTranslationStore(signalWindow)

    await store.applyBatch([translation()])

    expect(store.renderApi.get('local-message-id')).toBe('你好，你在做什么？')
  })

  it('编辑 revision 不一致时拒绝迟到译文', async () => {
    const signalWindow = {
      __imHubSignalResolveMessageForTranslation: vi.fn().mockResolvedValue(model({
        editMessageTimestamp: 1_700_000_001_000,
      })),
    }
    const store = new SignalDesktopTranslationStore(signalWindow)

    await store.applyBatch([translation()])

    expect(store.renderApi.get('local-message-id')).toBeNull()
  })

  it('非法日期范围的编辑时间不会让整个批次抛错', async () => {
    const signalWindow = {
      __imHubSignalResolveMessageForTranslation: vi.fn().mockResolvedValue(model({
        editMessageTimestamp: Number.MAX_SAFE_INTEGER,
      })),
    }
    const store = new SignalDesktopTranslationStore(signalWindow)

    await expect(store.applyBatch([translation()])).resolves.toBeUndefined()
    expect(store.renderApi.get('local-message-id')).toBeNull()
  })

  it('编辑或删除钩子按本地模型清掉旧译文并触发重绘', async () => {
    const resolved = model()
    const store = new SignalDesktopTranslationStore({
      __imHubSignalResolveMessageForTranslation: vi.fn().mockResolvedValue(resolved),
    })
    const listener = vi.fn()
    store.renderApi.subscribe(listener)
    await store.applyBatch([translation()])

    store.clear(resolved)

    expect(store.renderApi.get('local-message-id')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
