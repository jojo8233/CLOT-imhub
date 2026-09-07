import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSecurityCriticalRedis } from './redis-client.js'

describe('security-critical Redis client', () => {
  let blackhole: Server | null = null
  const sockets = new Set<Socket>()

  afterEach(async () => {
    const server = blackhole
    blackhole = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('uses a three-second command deadline by default', () => {
    const redis = createSecurityCriticalRedis('redis://127.0.0.1:6379', { lazyConnect: true })
    try {
      expect(redis.options.commandTimeout).toBe(3000)
      expect(redis.options.connectTimeout).toBe(3000)
      expect(redis.options.maxRetriesPerRequest).toBe(1)
    } finally {
      redis.disconnect()
    }
  })

  it('rejects a command when Redis accepts TCP but never responds', async () => {
    blackhole = createServer((socket) => {
      // 模拟已建立 TCP、但不再响应任何 Redis 命令的连接。
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      blackhole?.once('error', reject)
      blackhole?.listen(0, '127.0.0.1', resolve)
    })
    const address = blackhole.address()
    if (!address || typeof address === 'string') throw new Error('blackhole server unavailable')
    const redis = createSecurityCriticalRedis(`redis://127.0.0.1:${address.port}`, {
      commandTimeoutMs: 25,
    })
    const startedAt = Date.now()

    try {
      await expect(redis.ping()).rejects.toThrow()
      expect(Date.now() - startedAt).toBeLessThan(500)
    } finally {
      redis.disconnect()
    }
  })
})
