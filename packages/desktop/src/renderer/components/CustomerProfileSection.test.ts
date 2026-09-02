import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { emptyCustomerProfile, type CustomerProfile } from '@im-hub/shared'
import {
  initialCustomerProfileEditorState,
  reduceCustomerProfileEditor,
  type CustomerProfileEditorAction,
  type CustomerProfileEditorState,
} from '../customer-profile-editor.js'
import {
  CustomerProfileSectionView,
  completeCustomerProfileSave,
  reserveCustomerProfileSaveAttempt,
  type CustomerProfileSaveAttempt,
} from './CustomerProfileSection.js'

function loadedEditorState(profile: CustomerProfile): CustomerProfileEditorState {
  let state = initialCustomerProfileEditorState()
  state = reduceCustomerProfileEditor(state, {
    type: 'conversation.changed',
    conversationId: profile.conversationId,
  })
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started',
    conversationId: profile.conversationId,
    requestId: 1,
    mode: 'replace',
  })
  return reduceCustomerProfileEditor(state, {
    type: 'load.succeeded',
    conversationId: profile.conversationId,
    requestId: 1,
    mode: 'replace',
    profile,
  })
}

function editingState(localName: string): CustomerProfileEditorState {
  let state = loadedEditorState({
    ...emptyCustomerProfile('c'),
    name: 'Server',
    revision: 1,
  })
  state = reduceCustomerProfileEditor(state, { type: 'edit.started' })
  return reduceCustomerProfileEditor(state, {
    type: 'draft.changed',
    field: 'name',
    value: localName,
  })
}

function conflictEditorState(localName: string, remoteRevision: number): CustomerProfileEditorState {
  let state = editingState(localName)
  state = reduceCustomerProfileEditor(state, {
    type: 'load.started',
    conversationId: 'c',
    requestId: 2,
    mode: 'conflict',
  })
  return reduceCustomerProfileEditor(state, {
    type: 'load.succeeded',
    conversationId: 'c',
    requestId: 2,
    mode: 'conflict',
    profile: {
      ...emptyCustomerProfile('c'),
      name: 'Remote Value',
      revision: remoteRevision,
    },
  })
}

function renderView(
  state: CustomerProfileEditorState,
  readOnly = false,
  conversationId = state.conversationId ?? '',
): string {
  const props = {
    state,
    readOnly,
    conversationId,
    onEdit: () => {},
    onCancel: () => {},
    onSave: () => {},
    onRetry: () => {},
    onFieldChange: () => {},
  }
  return renderToStaticMarkup(createElement(CustomerProfileSectionView, props))
}

describe('CustomerProfileSectionView', () => {
  it('查看态只为可写角色提供一个人工维护入口', () => {
    const html = renderView(loadedEditorState({
      ...emptyCustomerProfile('c'),
      name: 'Synthetic Name',
      revision: 1,
    }))
    expect(html).toContain('Synthetic Name')
    expect(html).toContain('尚未填写')
    expect(html).toMatch(/<button[^>]*>手动补充<\/button>/)
    expect(html.match(/<button\b/g)).toHaveLength(1)
  })

  it('auditor 查看态不渲染编辑入口', () => {
    const html = renderView(loadedEditorState(emptyCustomerProfile('c')), true)
    expect(html).not.toContain('手动补充')
    expect(html).toContain('只读')
  })

  it('编辑态保留冲突草稿并显示最新版本提示', () => {
    const html = renderView(conflictEditorState('Local Draft', 2))
    expect(html).toContain('value="Local Draft"')
    expect(html).toContain('其他人更新')
    expect(html).toContain('服务器最新：Remote Value')
    expect(html).toContain('保存')
  })

  it('首次加载失败显示非敏感错误和重试入口', () => {
    let state = initialCustomerProfileEditorState()
    state = reduceCustomerProfileEditor(state, {
      type: 'conversation.changed',
      conversationId: 'c',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'c',
      requestId: 1,
      mode: 'replace',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.failed',
      conversationId: 'c',
      requestId: 1,
      mode: 'replace',
      message: '连不上服务端，请稍后重试',
    })
    const html = renderView(state)
    expect(html).toContain('连不上服务端，请稍后重试')
    expect(html).toContain('重试加载')
  })

  it('冲突重载失败仍显示本地草稿和重试入口', () => {
    let state = editingState('Local Draft')
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'c',
      requestId: 3,
      mode: 'conflict',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.failed',
      conversationId: 'c',
      requestId: 3,
      mode: 'conflict',
      message: '客户档案操作失败，请稍后重试',
    })
    const html = renderView(state)
    expect(html).toContain('value="Local Draft"')
    expect(html).toContain('重试加载')
  })

  it('保存或冲突重载期间禁用取消和保存', () => {
    const saving = reduceCustomerProfileEditor(editingState('Draft'), {
      type: 'save.started', conversationId: 'c', requestId: 1,
    })
    let conflictLoading = editingState('Draft')
    conflictLoading = reduceCustomerProfileEditor(conflictLoading, {
      type: 'load.started',
      conversationId: 'c',
      requestId: 4,
      mode: 'conflict',
    })
    expect(renderView(saving)).toMatch(/<button[^>]*disabled=""[^>]*>取消<\/button>/)
    expect(renderView(saving)).toMatch(/<button[^>]*disabled=""[^>]*>保存中<\/button>/)
    expect(renderView(conflictLoading)).toMatch(/<button[^>]*disabled=""[^>]*>取消<\/button>/)
    expect(renderView(conflictLoading)).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
  })

  it('prop 已切到新会话时首帧不显示旧会话档案', () => {
    const oldConversation = loadedEditorState({
      ...emptyCustomerProfile('old-conversation'),
      name: 'Old Profile Value',
      revision: 1,
    })
    const html = renderView(oldConversation, false, 'new-conversation')
    expect(html).not.toContain('Old Profile Value')
    expect(html).toContain('正在加载客户档案')
  })
})

describe('reserveCustomerProfileSaveAttempt', () => {
  it('同一渲染闭包连续保存只保留第一个 attempt 且只递增一次序号', () => {
    const state = editingState('Draft')
    const activeSaveRef: { current: CustomerProfileSaveAttempt | null } = { current: null }
    const requestIdRef = { current: 0 }

    const first = reserveCustomerProfileSaveAttempt(
      activeSaveRef,
      requestIdRef,
      state,
      false,
      'c',
    )
    const second = reserveCustomerProfileSaveAttempt(
      activeSaveRef,
      requestIdRef,
      state,
      false,
      'c',
    )

    expect(first).toEqual({ conversationId: 'c', requestId: 1 })
    expect(second).toBeNull()
    expect(activeSaveRef.current).toEqual(first)
    expect(requestIdRef.current).toBe(1)
  })
})

describe('completeCustomerProfileSave', () => {
  it('保存成功时通知档案库刷新对应条目', () => {
    const dispatched: CustomerProfileEditorAction[] = []
    const saved: CustomerProfile[] = []
    const profile = { ...emptyCustomerProfile('c'), name: 'Updated', revision: 2 }

    completeCustomerProfileSave(
      action => { dispatched.push(action) },
      value => { saved.push(value) },
      { type: 'save.succeeded', conversationId: 'c', requestId: 2, profile },
    )

    expect(dispatched).toHaveLength(1)
    expect(saved).toEqual([profile])
  })
})
