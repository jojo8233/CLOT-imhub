import { normalizeWhatsAppDomText } from './whatsapp-web-utils.js'

export interface WhatsAppComposerWritePort {
  focus(): boolean
  selectContents(): boolean
  insertText(text: string): boolean
  readText(): string
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
