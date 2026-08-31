import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedSecret {
  ciphertext: string
  iv: string
  authTag: string
}

export function decodeSecretMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('WHATSAPP_SECRET_MASTER_KEY 必须是 32 字节 base64')
  return key
}

/** AES-256-GCM；账号与用途作为 AAD，密文挪到另一账号后无法解密。 */
export class SecretCipher {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('secret master key must be 32 bytes')
  }

  encrypt(accountId: string, purpose: string, plaintext: string): EncryptedSecret {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv)
    cipher.setAAD(Buffer.from(`${accountId}:${purpose}`, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    }
  }

  decrypt(accountId: string, purpose: string, encrypted: EncryptedSecret): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.masterKey,
      Buffer.from(encrypted.iv, 'base64'),
    )
    decipher.setAAD(Buffer.from(`${accountId}:${purpose}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}
