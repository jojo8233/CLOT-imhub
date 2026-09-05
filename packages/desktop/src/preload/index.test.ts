import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_INSTALLATION_SYNC_CHANNEL } from '../desktop-installation-ipc.js'

const electron = vi.hoisted(() => ({
  exposed: undefined as unknown,
  invoke: vi.fn().mockResolvedValue({
    readyAccountIds: [], blockedAccountIds: [], manualRequiredAccountIds: [],
  }),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: unknown) => { electron.exposed = value },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))

await import('./index.js')

describe('trusted preload desktop installation bridge', () => {
  it('向可信渲染进程注入开发期 HTTP、WS 与发行渠道', () => {
    const bridge = electron.exposed as {
      serverUrl: string
      wsUrl: string
      release: { channel: string }
    }

    expect(bridge.serverUrl).toBe('http://localhost:4000')
    expect(bridge.wsUrl).toBe('ws://localhost:4000')
    expect(bridge.release).toEqual({ channel: 'development' })
  })

  it('只接受账号 id 列表，不暴露凭证、header、URL、路径或 partition', async () => {
    const bridge = electron.exposed as {
      desktopInstallation: { syncMounts(accountIds: string[]): Promise<unknown> }
    }
    const accountIds = ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']

    await bridge.desktopInstallation.syncMounts(accountIds)

    expect(electron.invoke).toHaveBeenCalledWith(
      DESKTOP_INSTALLATION_SYNC_CHANNEL,
      { accountIds },
    )
    expect(Object.keys(bridge.desktopInstallation)).toEqual(['syncMounts'])
  })
})
