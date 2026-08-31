/**
 * WhatsApp Web 页面本地状态中的当前用户标识。
 *
 * 这是补丁网页客户端的兼容边界，不是 Meta 对外承诺的 Cloud API 身份协议。
 * 设备后缀会被移除，`s.whatsapp.net` 统一成网页常用的 `c.us`，避免同一账号
 * 因页面内部表示不同而无法通过 control grant 身份复核。
 */
export function normalizeWhatsAppWebUserId(value: string): string {
  const match = /^([0-9]{5,20})(?::[0-9]{1,5})?@(c\.us|s\.whatsapp\.net|lid)$/i.exec(value.trim())
  if (!match?.[1] || !match[2]) throw new Error('invalid WhatsApp Web user id')
  const domain = match[2].toLowerCase() === 's.whatsapp.net' ? 'c.us' : match[2].toLowerCase()
  return `${match[1]}@${domain}`
}
