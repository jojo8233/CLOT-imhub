import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeSecretMasterKey, SecretCipher } from './secret-cipher.js'

describe('WhatsApp token secret cipher', () => {
  it('只允许同账号同用途解密', () => {
    const cipher = new SecretCipher(randomBytes(32))
    const encrypted = cipher.encrypt('account-a', 'whatsapp_access_token', 'opaque-token')
    expect(cipher.decrypt('account-a', 'whatsapp_access_token', encrypted)).toBe('opaque-token')
    expect(() => cipher.decrypt('account-b', 'whatsapp_access_token', encrypted)).toThrow()
  })

  it('主密钥必须恰好 32 字节', () => {
    expect(decodeSecretMasterKey(randomBytes(32).toString('base64'))).toHaveLength(32)
    expect(() => decodeSecretMasterKey(randomBytes(16).toString('base64'))).toThrow()
  })
})
