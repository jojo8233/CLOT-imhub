import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL } from '../native-control-ipc.js'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: { id: number } }, value: unknown) => unknown>(),
  order: [] as string[],
  partition: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: { id: number } }, value: unknown) => unknown) => {
      electron.handlers.set(channel, handler)
    },
    on: vi.fn(),
  },
  session: {
    fromPartition: (partition: string) => {
      electron.partition(partition)
      return {
        clearStorageData: async () => { electron.order.push('clear-storage') },
        clearCache: async () => { electron.order.push('clear-cache') },
      }
    },
  },
  webContents: { fromId: vi.fn() },
}))

import { NativeControlHost } from './native-control-host.js'

const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555'

function guest(id: number) {
  return {
    id,
    once: vi.fn(),
    isDestroyed: () => false,
    close: vi.fn(() => { electron.order.push(`close:${id}`) }),
    send: vi.fn(),
  }
}

beforeEach(() => {
  electron.handlers.clear()
  electron.order.length = 0
  electron.partition.mockClear()
  vi.restoreAllMocks()
})

describe('NativeControlHost account cleanup', () => {
  it('只关闭目标账号 guest，再依次清空其固定 partition 存储和缓存', async () => {
    const host = new NativeControlHost('http://localhost:4000')
    const target = guest(11)
    const other = guest(22)
    host.registerGuest(target as never, ACCOUNT_ID, 1)
    host.registerGuest(other as never, OTHER_ACCOUNT_ID, 1)

    await host.purgeAccount(ACCOUNT_ID)

    expect(target.close).toHaveBeenCalledOnce()
    expect(other.close).not.toHaveBeenCalled()
    expect(electron.partition).toHaveBeenCalledWith(`persist:native-${ACCOUNT_ID}`)
    expect(electron.order).toEqual(['close:11', 'clear-storage', 'clear-cache'])
  })

  it('既有 remove-account IPC 经过同一个 purgeAccount 边界', async () => {
    const host = new NativeControlHost('http://localhost:4000')
    host.install()
    host.attachHost({ id: 7, once: vi.fn() } as never)
    const purge = vi.spyOn(host, 'purgeAccount').mockResolvedValue(undefined)
    const handler = electron.handlers.get(NATIVE_CONTROL_REMOVE_ACCOUNT_CHANNEL)
    if (!handler) throw new Error('expected remove-account handler')

    await handler({ sender: { id: 7 } }, { accountId: ACCOUNT_ID })

    expect(purge).toHaveBeenCalledWith(ACCOUNT_ID)
  })
})
