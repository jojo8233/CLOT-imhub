import { createHmac, timingSafeEqual } from 'node:crypto'

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/** Meta 对 POST 原始字节做 HMAC；JSON parse/stringify 后再算会破坏签名。 */
export function verifyWhatsAppWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || appSecret === '') return false
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  return constantTimeEqual(signatureHeader, expected)
}

export function verifyWhatsAppChallengeToken(received: string, expected: string): boolean {
  return received !== '' && expected !== '' && constantTimeEqual(received, expected)
}
