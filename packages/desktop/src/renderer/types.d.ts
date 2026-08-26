import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { NativeGuestEvent, NativeHostCommand } from '@im-hub/shared'

/**
 * Electron 的 <webview> 不在 React 的 JSX 类型里，用到的属性在这里补齐。
 *
 * 只列我们实际用到的：partition 决定登录态隔离（多开靠它），preload 是注入
 * 翻译的入口，allowpopups 让 Telegram 的外链能开出去而不是白屏。
 */
declare global {
  interface Window {
    imHubNativeBridge?: {
      protocolVersion: number
      emit(event: NativeGuestEvent): void
      onCommand(listener: (command: NativeHostCommand) => void): void
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
