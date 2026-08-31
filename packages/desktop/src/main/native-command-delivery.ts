import type { NativeHostCommand } from '@im-hub/shared'

interface NativeCommandDeliveryTarget {
  focus(): void
  send(channel: string, command: NativeHostCommand): void
}

/** WhatsApp 的受控编辑器只有在 guest webContents 获得原生焦点后才提交编辑事务。 */
export function deliverNativeHostCommand(
  target: NativeCommandDeliveryTarget,
  channel: string,
  command: NativeHostCommand,
  focusComposerCommands: boolean,
): void {
  if (focusComposerCommands
    && (command.type === 'composer.set-draft' || command.type === 'composer.send')) {
    target.focus()
  }
  target.send(channel, command)
}
