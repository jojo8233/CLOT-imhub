import type { WebSocket } from 'ws'
import type { WsServerEvent } from '@im-hub/shared'

/** 按 userId 维护连接。P0 只推给消息所属账号的 owner，管理员订阅在 P2 补。 */
export class WsHub {
  private readonly sockets = new Map<string, Set<WebSocket>>()

  add(userId: string, socket: WebSocket): void {
    let set = this.sockets.get(userId)
    if (!set) {
      set = new Set()
      this.sockets.set(userId, set)
    }
    set.add(socket)
    socket.on('close', () => this.remove(userId, socket))
  }

  remove(userId: string, socket: WebSocket): void {
    const set = this.sockets.get(userId)
    if (!set) return
    set.delete(socket)
    // 空集合要删掉，否则每个登录过的用户都会永久占一个 Map 槽位
    if (set.size === 0) this.sockets.delete(userId)
  }

  publishTo(userId: string, event: WsServerEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.sockets.get(userId) ?? []) {
      if (socket.readyState !== socket.OPEN) continue
      try {
        socket.send(payload)
      } catch (err) {
        // 一个连接发不出去不该连累同用户的其他连接
        console.warn('[ws-hub] 推送失败:', err instanceof Error ? err.message : err)
      }
    }
  }

  /** 当前有连接的用户数，供测试与运维观测 */
  userCount(): number {
    return this.sockets.size
  }
}
