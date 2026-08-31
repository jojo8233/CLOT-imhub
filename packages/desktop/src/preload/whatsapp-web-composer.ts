import { normalizeWhatsAppDomText } from './whatsapp-web-utils.js'

export interface WhatsAppComposerWritePort {
  focus(): boolean
  selectContents(): boolean
  insertText(text: string): boolean
  readText(): string
}

export interface WhatsAppComposerFocusPort {
  focus(): void
  hasFocus(): boolean
}

/**
 * 等 composer DOM 与 Lexical 自身的 focus 处理完成后再开始唯一一次编辑事务。
 *
 * 草稿写入不能抢 webview 原生焦点；只等待 activeElement 稳定，并在后续事务中继续
 * 验证完整选区。真正发送仍由主进程单独确认 guest webContents 焦点。
 */
export async function waitForWhatsAppComposerFocus(
  port: WhatsAppComposerFocusPort,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 50)),
  attempts = 4,
): Promise<boolean> {
  port.focus()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (port.hasFocus()) {
      await pause()
      return port.hasFocus()
    }
    await pause()
  }
  return false
}

/**
 * 通过一次浏览器编辑事务替换 WhatsApp 草稿。
 *
 * `execCommand('insertText')` 本身会产生编辑器需要的 input 事件；调用方不能再
 * 人工派发一份携带完整正文的 InputEvent，否则 WhatsApp 会把同一正文插入两次。
 */
export function replaceWhatsAppComposerText(
  port: WhatsAppComposerWritePort,
  text: string,
): boolean {
  if (!port.focus()) return false
  if (!port.selectContents()) return false
  const inserted = port.insertText(text)
  return inserted || port.readText() === normalizeWhatsAppDomText(text)
}
