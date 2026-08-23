import argon2 from 'argon2'

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id })
}

export async function verifyPassword(storedHash: string, candidatePassword: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, candidatePassword)
  } catch {
    return false
  }
}
