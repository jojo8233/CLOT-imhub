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
      reduceCustomerProfileEditor(editing, {
        type: 'save.started', conversationId: 'c', requestId: 1,
      }),
      {
        type: 'save.failed',
        conversationId: 'c',
        requestId: 1,
        message: '连不上服务端，请稍后重试',
      },
    )
    expect(failed.status).toBe('editing')
    expect(failed.draft.name).toBe('Draft')
    expect(failed.error).toBe('连不上服务端，请稍后重试')
  })

  it('冲突刷新保留本地改动并把未改字段 rebase 到最新 snapshot', () => {
    let state = loadedEditorState({
      ...emptyCustomerProfile('c'),
      name: 'Server',
      occupation: 'Original Occupation',
      revision: 1,
    })
    state = reduceCustomerProfileEditor(state, { type: 'edit.started' })
    state = reduceCustomerProfileEditor(state, {
      type: 'draft.changed',
      field: 'name',
      value: 'Local Draft',
    })
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
      profile: {
        ...emptyCustomerProfile('c'),
        name: 'Remote Value',
        occupation: 'Remote Occupation',
        revision: 2,
      },
    })
    expect(state.snapshot?.revision).toBe(2)
    expect(state.snapshot?.name).toBe('Remote Value')
    expect(state.draft.name).toBe('Local Draft')
    expect(state.draft.occupation).toBe('Remote Occupation')
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
    const saving = reduceCustomerProfileEditor(editingState('Draft'), {
      type: 'save.started', conversationId: 'c', requestId: 1,
    })
    const savedProfile = {
      ...emptyCustomerProfile('c'),
      name: 'Saved',
      revision: 2,
      updatedAt: '2026-09-02T00:00:00.000Z',
    }
    const saved = reduceCustomerProfileEditor(saving, {
      type: 'save.succeeded',
      conversationId: 'c',
      requestId: 1,
      profile: savedProfile,
    })
    expect(saved.status).toBe('viewing')
    expect(saved.snapshot).toEqual(savedProfile)
    expect(saved.draft.name).toBe('Saved')
  })

  it('保存中忽略重复 save.started 和 draft.changed', () => {
    const saving = reduceCustomerProfileEditor(editingState('Draft'), {
      type: 'save.started', conversationId: 'c', requestId: 1,
    })
    const repeated = reduceCustomerProfileEditor(saving, {
      type: 'save.started', conversationId: 'c', requestId: 2,
    })
    const changed = reduceCustomerProfileEditor(repeated, {
      type: 'draft.changed',
      field: 'name',
      value: 'Unexpected',
    })
    expect(changed.status).toBe('saving')
    expect(changed.draft.name).toBe('Draft')
  })

  it('甲乙甲切换后忽略甲的旧保存成功响应', () => {
    let state = loadedEditorState({
      ...emptyCustomerProfile('a'),
      name: 'Initial A',
      revision: 1,
    })
    state = reduceCustomerProfileEditor(state, { type: 'edit.started' })
    state = reduceCustomerProfileEditor(state, {
      type: 'draft.changed',
      field: 'name',
      value: 'First Draft',
    })
    const firstSave = {
      type: 'save.started',
      conversationId: 'a',
      requestId: 1,
    } as const
    state = reduceCustomerProfileEditor(state, firstSave)

    state = reduceCustomerProfileEditor(state, {
      type: 'conversation.changed',
      conversationId: 'b',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'conversation.changed',
      conversationId: 'a',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.started',
      conversationId: 'a',
      requestId: 2,
      mode: 'replace',
    })
    state = reduceCustomerProfileEditor(state, {
      type: 'load.succeeded',
      conversationId: 'a',
      requestId: 2,
      mode: 'replace',
      profile: { ...emptyCustomerProfile('a'), name: 'Current A', revision: 2 },
    })
    state = reduceCustomerProfileEditor(state, { type: 'edit.started' })
    state = reduceCustomerProfileEditor(state, {
      type: 'draft.changed',
      field: 'name',
      value: 'Second Draft',
    })
    const secondSave = {
      type: 'save.started',
      conversationId: 'a',
      requestId: 3,
    } as const
    state = reduceCustomerProfileEditor(state, secondSave)

    const staleSuccess = {
      type: 'save.succeeded',
      conversationId: 'a',
      requestId: 1,
      profile: { ...emptyCustomerProfile('a'), name: 'First Saved', revision: 2 },
    } as const
    state = reduceCustomerProfileEditor(state, staleSuccess)
    expect(state.status).toBe('saving')
    expect(state.draft.name).toBe('Second Draft')

    const currentSuccess = {
      type: 'save.succeeded',
      conversationId: 'a',
      requestId: 3,
      profile: { ...emptyCustomerProfile('a'), name: 'Second Saved', revision: 3 },
    } as const
    state = reduceCustomerProfileEditor(state, currentSuccess)
    expect(state.status).toBe('viewing')
    expect(state.draft.name).toBe('Second Saved')
  })

  it('忽略不匹配当前保存请求的失败响应', () => {
    let state = editingState('Current Draft')
    const started = {
      type: 'save.started',
      conversationId: 'c',
      requestId: 8,
    } as const
    state = reduceCustomerProfileEditor(state, started)
    const staleFailure = {
      type: 'save.failed',
      conversationId: 'c',
      requestId: 7,
      message: '迟到失败',
    } as const
    state = reduceCustomerProfileEditor(state, staleFailure)
    expect(state.status).toBe('saving')
    expect(state.error).toBeNull()
    expect(state.draft.name).toBe('Current Draft')
  })
})
