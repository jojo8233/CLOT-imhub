import {
  CUSTOMER_PROFILE_FIELDS,
  type CustomerProfile,
  type CustomerProfileField,
  type CustomerProfileValues,
} from '@im-hub/shared'

export type CustomerProfileEditorStatus =
  | 'idle'
  | 'loading'
  | 'viewing'
  | 'editing'
  | 'saving'
  | 'failed'

type CustomerProfileLoadMode = 'replace' | 'conflict'

interface ActiveProfileLoad {
  conversationId: string
  requestId: number
  mode: CustomerProfileLoadMode
}

interface ActiveProfileSave {
  conversationId: string
  requestId: number
}

export interface CustomerProfileEditorState {
  conversationId: string | null
  activeLoad: ActiveProfileLoad | null
  activeSave: ActiveProfileSave | null
  retryLoadMode: CustomerProfileLoadMode | null
  snapshot: CustomerProfile | null
  draft: CustomerProfileValues
  hasConflict: boolean
  status: CustomerProfileEditorStatus
  error: string | null
}

export type CustomerProfileEditorAction =
  | { type: 'conversation.changed'; conversationId: string | null }
  | {
    type: 'load.started'
    conversationId: string
    requestId: number
    mode: CustomerProfileLoadMode
  }
  | {
    type: 'load.succeeded'
    conversationId: string
    requestId: number
    mode: CustomerProfileLoadMode
    profile: CustomerProfile
  }
  | {
    type: 'load.failed'
    conversationId: string
    requestId: number
    mode: CustomerProfileLoadMode
    message: string
  }
  | { type: 'edit.started' }
  | { type: 'draft.changed'; field: CustomerProfileField; value: string }
  | { type: 'edit.cancelled' }
  | { type: 'save.started'; conversationId: string; requestId: number }
  | {
    type: 'save.succeeded'
    conversationId: string
    requestId: number
    profile: CustomerProfile
  }
  | {
    type: 'save.failed'
    conversationId: string
    requestId: number
    message: string
  }

function emptyValues(): CustomerProfileValues {
  return {
    name: null,
    ageLocation: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
  }
}

function profileValues(profile: CustomerProfile): CustomerProfileValues {
  return {
    name: profile.name,
    ageLocation: profile.ageLocation,
    occupation: profile.occupation,
    family: profile.family,
    interests: profile.interests,
    other: profile.other,
  }
}

function rebaseUnchangedDraftFields(
  baseline: CustomerProfile,
  draft: CustomerProfileValues,
  latest: CustomerProfile,
): CustomerProfileValues {
  return {
    name: draft.name === baseline.name ? latest.name : draft.name,
    ageLocation: draft.ageLocation === baseline.ageLocation
      ? latest.ageLocation
      : draft.ageLocation,
    occupation: draft.occupation === baseline.occupation
      ? latest.occupation
      : draft.occupation,
    family: draft.family === baseline.family ? latest.family : draft.family,
    interests: draft.interests === baseline.interests ? latest.interests : draft.interests,
    other: draft.other === baseline.other ? latest.other : draft.other,
  }
}

export function initialCustomerProfileEditorState(): CustomerProfileEditorState {
  return {
    conversationId: null,
    activeLoad: null,
    activeSave: null,
    retryLoadMode: null,
    snapshot: null,
    draft: emptyValues(),
    hasConflict: false,
    status: 'idle',
    error: null,
  }
}

function matchesActiveLoad(
  state: CustomerProfileEditorState,
  action: {
    conversationId: string
    requestId: number
    mode: CustomerProfileLoadMode
  },
): boolean {
  return state.activeLoad?.conversationId === action.conversationId
    && state.activeLoad.requestId === action.requestId
    && state.activeLoad.mode === action.mode
}

function matchesActiveSave(
  state: CustomerProfileEditorState,
  action: { conversationId: string; requestId: number },
): boolean {
  return state.activeSave?.conversationId === action.conversationId
    && state.activeSave.requestId === action.requestId
}

export function reduceCustomerProfileEditor(
  state: CustomerProfileEditorState,
  action: CustomerProfileEditorAction,
): CustomerProfileEditorState {
  switch (action.type) {
    case 'conversation.changed':
      return {
        conversationId: action.conversationId,
        activeLoad: null,
        activeSave: null,
        retryLoadMode: null,
        snapshot: null,
        draft: emptyValues(),
        hasConflict: false,
        status: action.conversationId === null ? 'idle' : 'loading',
        error: null,
      }
    case 'load.started':
      if (state.conversationId !== action.conversationId) return state
      return {
        ...state,
        activeLoad: {
          conversationId: action.conversationId,
          requestId: action.requestId,
          mode: action.mode,
        },
        activeSave: action.mode === 'conflict' ? null : state.activeSave,
        retryLoadMode: null,
        status: action.mode === 'replace' ? 'loading' : 'editing',
        error: action.mode === 'conflict'
          ? '档案已被其他人更新，正在读取最新版本'
          : null,
      }
    case 'load.succeeded':
      if (!matchesActiveLoad(state, action)) return state
      if (action.mode === 'conflict') {
        return {
          ...state,
          activeLoad: null,
          retryLoadMode: null,
          snapshot: action.profile,
          draft: state.snapshot
            ? rebaseUnchangedDraftFields(state.snapshot, state.draft, action.profile)
            : state.draft,
          hasConflict: true,
          status: 'editing',
          error: '档案已被其他人更新，请对照最新版本后再保存',
        }
      }
      return {
        ...state,
        activeLoad: null,
        retryLoadMode: null,
        snapshot: action.profile,
        draft: profileValues(action.profile),
        hasConflict: false,
        status: 'viewing',
        error: null,
      }
    case 'load.failed':
      if (!matchesActiveLoad(state, action)) return state
      return {
        ...state,
        activeLoad: null,
        retryLoadMode: action.mode,
        status: action.mode === 'replace' ? 'failed' : 'editing',
        error: action.message,
      }
    case 'edit.started':
      if (state.status !== 'viewing' || !state.snapshot) return state
      return {
        ...state,
        draft: profileValues(state.snapshot),
        hasConflict: false,
        status: 'editing',
        error: null,
      }
    case 'draft.changed':
      if (state.status !== 'editing' || !CUSTOMER_PROFILE_FIELDS.includes(action.field)) {
        return state
      }
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
      }
    case 'edit.cancelled':
      if (state.status !== 'editing' || !state.snapshot || state.activeLoad) return state
      return {
        ...state,
        retryLoadMode: null,
        draft: profileValues(state.snapshot),
        hasConflict: false,
        status: 'viewing',
        error: null,
      }
    case 'save.started':
      if (state.status !== 'editing'
        || state.conversationId !== action.conversationId
        || !state.snapshot
        || state.activeLoad) return state
      return {
        ...state,
        activeSave: {
          conversationId: action.conversationId,
          requestId: action.requestId,
        },
        status: 'saving',
        error: null,
      }
    case 'save.succeeded':
      if (state.status !== 'saving'
        || !matchesActiveSave(state, action)
        || action.profile.conversationId !== state.conversationId) {
        return state
      }
      return {
        ...state,
        activeSave: null,
        snapshot: action.profile,
        draft: profileValues(action.profile),
        hasConflict: false,
        status: 'viewing',
        error: null,
      }
    case 'save.failed':
      if (state.status !== 'saving' || !matchesActiveSave(state, action)) return state
      return { ...state, activeSave: null, status: 'editing', error: action.message }
  }
}
