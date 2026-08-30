import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type {
  NativeControlGrantResponse,
  NativeControlStateUpdate,
  NativeConversationContext,
  NativeGuestEvent,
  NativeHostCommand,
  NativeTranslationBatchInput,
  NativeTranslationBatchResult,
} from '@im-hub/shared'
import type {
  SignalDesktopRect,
  SignalDesktopStateUpdate,
} from '../signal-desktop-ipc.js'

interface NativeControlTarget {
  accountId: string
  guestWebContentsId: number
}

interface NativeControlBridge {
  configure(target: NativeControlTarget, grant: NativeControlGrantResponse): Promise<NativeControlStateUpdate>
  release(target: NativeControlTarget): Promise<void>
  releaseAll(): Promise<void>
  removeAccount(accountId: string): Promise<void>
  sendCommand(target: NativeControlTarget, command: NativeHostCommand): Promise<void>
  syncContext(target: NativeControlTarget, context: NativeConversationContext): Promise<{ conversationId: string }>
  reportEvent(target: NativeControlTarget, event: NativeGuestEvent): Promise<{ accepted: boolean; duplicate?: boolean }>
  onEvent(listener: (value: { accountId: string; event: NativeGuestEvent }) => void): () => void
  onState(listener: (value: NativeControlStateUpdate) => void): () => void
}

interface SignalDesktopBridge {
  sync(accountId: string, rect: SignalDesktopRect, visible: boolean): Promise<SignalDesktopStateUpdate>
  release(accountId: string): Promise<void>
  releaseAll(): Promise<void>
  onState(listener: (value: SignalDesktopStateUpdate) => void): () => void
}

/**
 * Electron 的 <webview> 不在 React 的 JSX 类型里，用到的属性在这里补齐。
 *
 * 只列我们实际用到的：partition 决定登录态隔离（多开靠它），preload 是注入
 * 翻译的入口，allowpopups 让 Telegram 的外链能开出去而不是白屏。
 */
declare global {
  interface Window {
    imHub?: {
      platform?: string
      serverUrl?: string
      nativeBridgePreload?: string
      nativeControl?: NativeControlBridge
      signalDesktop?: SignalDesktopBridge
    }
    imHubNativeBridge?: {
      protocolVersion: number
      emit(event: NativeGuestEvent): void
      onCommand(listener: (command: NativeHostCommand) => void): void
      translateBatch(input: NativeTranslationBatchInput): Promise<NativeTranslationBatchResult[] | undefined>
      detectLanguage(text: string): Promise<string | undefined>
    }
  }
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        preload?: string
        allowpopups?: boolean
        useragent?: string
      }
    }
  }
}

export {}
