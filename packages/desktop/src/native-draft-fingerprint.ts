const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

/** 正文只以不可逆指纹进入发送 attempt 账本。 */
export async function nativeDraftFingerprint(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
}

export function isNativeDraftFingerprint(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}
