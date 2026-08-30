import { describe, expect, it, vi } from 'vitest'
import {
  readSignalDesktopComposerSnapshot,
  SignalDesktopComposerError,
  writeSignalDesktopDraft,
  type SignalDesktopComposerWindowLike,
} from './signal-desktop-composer.js'
import type { SignalDesktopModelLike } from './signal-desktop-message.js'

function directModel(attributes: Record<string, unknown>): SignalDesktopModelLike {
  return {
    attributes,
    get: key => attributes[key],
    getAci: () => attributes.serviceId,
    getTitle: () => 'Alice',
  }
}

function state(selectedId: string | null, sendCounter = 0): unknown {
  return {
    nav: {
      selectedLocation: {
        tab: 'Chats',
        details: selectedId ? { conversationId: selectedId } : {},
      },
    },
    composer: {
      conversations: selectedId ? { [selectedId]: { sendCounter } } : {},
    },
  }
}

function signalWindow(
  attributes: Record<string, unknown>,
  selectedId = 'local-conversation-id',
): SignalDesktopComposerWindowLike {
  const conversation = directModel(attributes)
  return {
    ConversationController: { get: id => id === selectedId ? conversation : undefined },
    reduxStore: {
      getState: () => state(selectedId, 3),
      subscribe: () => () => {},
    },
  }
}

describe('Signal Desktop composer bridge', () => {
  it('从 Redux 选中态解析规范直接会话，不把本地 conversation id 当平台身份', () => {
    const snapshot = readSignalDesktopComposerSnapshot(signalWindow({
      serviceId: '99999999-2222-3333-AAAA-555555555555',
      draft: 'existing draft',
    }))

    expect(snapshot).toEqual({
      localConversationId: 'local-conversation-id',
      context: {
        platformConversationId: 'u:99999999-2222-3333-aaaa-555555555555',
        contactExternalId: '99999999-2222-3333-aaaa-555555555555',
        contactDisplayName: 'Alice',
      },
      draft: 'existing draft',
      persistedDraft: 'existing draft',
      sendCounter: 3,
    })
    expect(JSON.stringify(snapshot?.context)).not.toContain('local-conversation-id')
  })

  it('群会话使用规范 group id 作为会话和联系人边界', () => {
    const attributes = { groupId: 'Z3JvdXA=', draft: '' }
    const conversation: SignalDesktopModelLike = {
      attributes,
      get: key => attributes[key as keyof typeof attributes],
      getTitle: () => '客服群',
    }
    const snapshot = readSignalDesktopComposerSnapshot({
      ConversationController: { get: () => conversation },
      reduxStore: {
        getState: () => state('local-group-id', 1),
        subscribe: () => () => {},
      },
    })

    expect(snapshot?.context).toEqual({
      platformConversationId: 'g:Z3JvdXA=',
      contactExternalId: 'g:Z3JvdXA=',
      contactDisplayName: '客服群',
    })
  })

  it('没有选中会话时不伪造上下文', () => {
    expect(readSignalDesktopComposerSnapshot({
      ConversationController: { get: () => undefined },
      reduxStore: {
        getState: () => state(null),
        subscribe: () => () => {},
      },
    })).toBeNull()
  })

  it('离开 Chats 标签后不沿用旧会话上下文', () => {
    const previous = state('local-conversation-id', 1) as {
      nav: { selectedLocation: { tab: string } }
    }
    previous.nav.selectedLocation.tab = 'Settings'
    expect(readSignalDesktopComposerSnapshot({
      ConversationController: { get: () => directModel({ serviceId: 'peer' }) },
      reduxStore: {
        getState: () => previous,
        subscribe: () => () => {},
      },
    })).toBeNull()
  })

  it('通过 Signal 可见 CompositionInput 写入草稿并确认持久模型', async () => {
    const attributes: Record<string, unknown> = {
      serviceId: '99999999-2222-3333-aaaa-555555555555', draft: '',
    }
    const windowLike = signalWindow(attributes)
    const setComposerFocus = vi.fn()
    let visibleDraft = ''
    const setDraft = vi.fn((text: string) => {
      visibleDraft = text
      attributes.draft = text
      return true
    })
    windowLike.reduxActions = { composer: { setComposerFocus } }
    windowLike.__imHubSignalComposerEditor = {
      conversationId: 'local-conversation-id',
      readDraft: () => visibleDraft,
      setDraft,
    }
    const before = readSignalDesktopComposerSnapshot(windowLike)
    if (!before) throw new Error('expected composer snapshot')

    const updated = await writeSignalDesktopDraft(windowLike, before, 'translated text')

    expect(setComposerFocus).toHaveBeenCalledWith('local-conversation-id')
    expect(setDraft).toHaveBeenCalledWith('translated text')
    expect(updated.draft).toBe('translated text')
    expect(updated.persistedDraft).toBe('translated text')
  })

  it('模型变化但可见编辑器未变化时不再报告写入成功', async () => {
    vi.useFakeTimers()
    try {
      const attributes: Record<string, unknown> = {
        serviceId: '99999999-2222-3333-aaaa-555555555555', draft: '',
      }
      const windowLike = signalWindow(attributes)
      windowLike.reduxActions = { composer: { setComposerFocus: vi.fn() } }
      windowLike.__imHubSignalComposerEditor = {
        conversationId: 'local-conversation-id',
        readDraft: () => '',
        setDraft: (text) => {
          attributes.draft = text
          return true
        },
      }
      const before = readSignalDesktopComposerSnapshot(windowLike)
      if (!before) throw new Error('expected composer snapshot')

      const result = expect(writeSignalDesktopDraft(windowLike, before, 'model only'))
        .rejects.toEqual(expect.objectContaining<Partial<SignalDesktopComposerError>>({
          code: 'signal_draft_write_failed',
        }))
      await vi.advanceTimersByTimeAsync(600)
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('聚焦期间切换会话会拒绝旧草稿命令', async () => {
    const attributes: Record<string, unknown> = {
      serviceId: '99999999-2222-3333-aaaa-555555555555', draft: '',
    }
    let selectedId = 'local-conversation-id'
    const conversation = directModel(attributes)
    const windowLike: SignalDesktopComposerWindowLike = {
      ConversationController: { get: id => id === selectedId ? conversation : undefined },
      reduxStore: {
        getState: () => state(selectedId, 2),
        subscribe: () => () => {},
      },
      reduxActions: {
        composer: {
          setComposerFocus: () => { selectedId = 'another-local-id' },
        },
      },
      __imHubSignalComposerEditor: {
        conversationId: 'local-conversation-id',
        readDraft: () => '',
        setDraft: vi.fn(),
      },
    }
    const before = readSignalDesktopComposerSnapshot(windowLike)
    if (!before) throw new Error('expected composer snapshot')

    await expect(writeSignalDesktopDraft(windowLike, before, 'must not cross'))
      .rejects.toEqual(expect.objectContaining<Partial<SignalDesktopComposerError>>({
        code: 'signal_composer_unavailable',
      }))
    expect(windowLike.__imHubSignalComposerEditor?.setDraft).not.toHaveBeenCalled()
  })
})
