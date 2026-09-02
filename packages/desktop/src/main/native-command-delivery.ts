import type { NativeHostCommand } from '@im-hub/shared'

interface NativeCommandDeliveryTarget {
  focus(): void
  isFocused(): boolean
  send(channel: string, command: NativeHostCommand): void
}

type NativeFocusWaiter = (target: NativeCommandDeliveryTarget) => Promise<boolean>

export async function waitForNativeGuestFocus(
  target: Pick<NativeCommandDeliveryTarget, 'isFocused'>,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 10)),
  attempts = 20,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (target.isFocused()) {
      // WebContents 原生焦点先变化，renderer 的 document.hasFocus() 随后才更新。
      await pause()
      return target.isFocused()
    }
    await pause()
  }
  return target.isFocused()
}

/** WhatsApp 真正发送前确认 guest webContents 原生焦点；草稿写入留在非抢焦 DOM 事务。 */
export async function deliverNativeHostCommand(
  target: NativeCommandDeliveryTarget,
  channel: string,
  command: NativeHostCommand,
  focusComposerCommands: boolean,
  waitForFocus: NativeFocusWaiter = waitForNativeGuestFocus,
): Promise<void> {
  if (focusComposerCommands && command.type === 'composer.send') {
    target.focus()
    if (!await waitForFocus(target)) throw new Error('原生客户端输入焦点不可用')
  }
  target.send(channel, command)
}
