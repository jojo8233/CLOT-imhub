import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password', () => {
  it('正确密码校验通过', async () => {
    const hash = await hashPassword('correct-horse')
    expect(await verifyPassword(hash, 'correct-horse')).toBe(true)
  })

  it('错误密码校验失败', async () => {
    const hash = await hashPassword('correct-horse')
    expect(await verifyPassword(hash, 'wrong-horse')).toBe(false)
  })

  it('相同明文两次哈希结果不同（加盐）', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('哈希串损坏时返回 false 而不是抛错', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false)
  })

  it('哈希使用 argon2id 而非库默认算法', async () => {
    expect(await hashPassword('x')).toMatch(/^\$argon2id\$/)
  })
})
