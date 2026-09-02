import { describe, expect, it } from 'vitest'
import { emptyCustomerProfile, type CustomerProfile } from '@im-hub/shared'
import {
  initialCustomerProfileEditorState,
  reduceCustomerProfileEditor,
  type CustomerProfileEditorState,
} from './customer-profile-editor.js'

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

function editingState(name: string): CustomerProfileEditorState {
  const loaded = loadedEditorState({
    ...emptyCustomerProfile('c'),
    name: 'Server',
    revision: 1,
  })
  return reduceCustomerProfileEditor(
    reduceCustomerProfileEditor(loaded, { type: 'edit.started' }),
    { type: 'draft.changed', field: 'name', value: name },
  )
}

describe('customer profile editor reducer', () => {
  it('切会话后忽略旧会话迟到响应', () => {
    let state = initialCustomerProfileEditorState()
    state = reduceCustomerProfileEditor(state, {
      type: 'conversation.changed',
      conversationId: 'a',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'a',
      requestId: 1,
      mode: 'replace',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'conversation.changed',
      conversationId: 'b',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.succeeded',
      conversationId: 'a',
      requestId: 1,
      mode: 'replace',
      profile: { ...emptyCustomerProfile('a'), name: 'Stale' },
    })
    expect(state.conversationId).toBe('b')
    expect(state.snapshot).toBeNull()
  })

  it('取消编辑恢复服务器 snapshot', () => {
    const loaded = loadedEditorState({
      ...emptyCustomerProfile('c'),
      name: 'Server',
      revision: 1,
    })
    const editing = reduceCustomerProfileEditor(
      reduceCustomerProfileEditor(loaded, { type: 'edit.started' }),
      { type: 'draft.changed', field: 'name', value: 'Draft' },
    )
    const cancelled = reduceCustomerProfileEditor(editing, { type: 'edit.cancelled' })
    expect(cancelled.draft.name).toBe('Server')
    expect(cancelled.status).toBe('viewing')
  })

  it('保存网络失败保留草稿', () => {
    const editing = editingState('Draft')
    const failed = reduceCustomerProfileEditor(
      reduceCustomerProfileEditor(editing, { type: 'save.started' }),
      { type: 'save.failed', message: '连不上服务端，请稍后重试' },
    )
    expect(failed.status).toBe('editing')
    expect(failed.draft.name).toBe('Draft')
    expect(failed.error).toBe('连不上服务端，请稍后重试')
  })

  it('冲突刷新更新 snapshot/revision 但保留本地草稿', () => {
    let state = editingState('Local Draft')
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'c',
      requestId: 9,
      mode: 'conflict',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.succeeded',
      conversationId: 'c',
      requestId: 9,
      mode: 'conflict',
      profile: { ...emptyCustomerProfile('c'), name: 'Remote Value', revision: 2 },
    })
    expect(state.snapshot?.revision).toBe(2)
    expect(state.snapshot?.name).toBe('Remote Value')
    expect(state.draft.name).toBe('Local Draft')
    expect(state.status).toBe('editing')
    expect(state.error).toContain('其他人更新')
  })

  it('冲突刷新失败保留草稿并记住重试模式', () => {
    let state = editingState('Local Draft')
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'c',
      requestId: 10,
      mode: 'conflict',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.failed',
      conversationId: 'c',
      requestId: 10,
      mode: 'conflict',
      message: '连不上服务端，请稍后重试',
    })
    expect(state.status).toBe('editing')
    expect(state.draft.name).toBe('Local Draft')
    expect(state.retryLoadMode).toBe('conflict')
  })

  it('首次加载失败可按 replace 模式重试', () => {
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
      message: '客户档案操作失败，请稍后重试',
    })
    expect(state.status).toBe('failed')
    expect(state.retryLoadMode).toBe('replace')
  })

  it('保存成功用服务器响应替换 snapshot 和草稿', () => {
    const saving = reduceCustomerProfileEditor(editingState('Draft'), { type: 'save.started' })
    const savedProfile = {
      ...emptyCustomerProfile('c'),
      name: 'Saved',
      revision: 2,
      updatedAt: '2026-09-02T00:00:00.000Z',
    }
    const saved = reduceCustomerProfileEditor(saving, {
      type: 'save.succeeded',
      profile: savedProfile,
    })
    expect(saved.status).toBe('viewing')
    expect(saved.snapshot).toEqual(savedProfile)
    expect(saved.draft.name).toBe('Saved')
  })

  it('保存中忽略重复 save.started 和 draft.changed', () => {
    const saving = reduceCustomerProfileEditor(editingState('Draft'), { type: 'save.started' })
    const repeated = reduceCustomerProfileEditor(saving, { type: 'save.started' })
    const changed = reduceCustomerProfileEditor(repeated, {
      type: 'draft.changed',
      field: 'name',
      value: 'Unexpected',
    })
    expect(changed.status).toBe('saving')
    expect(changed.draft.name).toBe('Draft')
  })
})
