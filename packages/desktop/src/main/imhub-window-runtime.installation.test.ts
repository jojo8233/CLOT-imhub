import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_INSTALLATION_SYNC_CHANNEL } from '../desktop-installation-ipc.js'

const state = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  handlers: new Map<string, (event: { sender: { id: number } }, value?: unknown) => unknown>(),
  purgeAccount: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => state.files.has(path),
  mkdirSync: vi.fn(),
  readFileSync: (path: string) => {
    const value = state.files.get(path)
    if (!value) throw new Error('missing file')
    return Buffer.from(value)
  },
  rmSync: (path: string) => { state.files.delete(path) },
  writeFileSync: (path: string, value: Buffer) => { state.files.set(path, Buffer.from(value)) },
}))

vi.mock('node:crypto', () => ({
  randomBytes: () => Buffer.alloc(32, 0x4a),
  randomUUID: () => '11111111-2222-4333-8444-555555555555',
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: {
    getPath: () => '/synthetic-user-data',
    getVersion: () => '1.2.3',
    on: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: { id: number } }, value?: unknown) => unknown) => {
      state.handlers.set(channel, handler)
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5)),
    decryptString: (value: Buffer) => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)).toString('utf8'),
  },
  shell: { openExternal: vi.fn() },
}))

vi.mock('./native-control-host.js', () => ({
  NativeControlHost: class {
    install() {}
    attachHost() {}
    registerGuest() {}
    purgeAccount = state.purgeAccount
  },
}))

const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function windowFixture(id = 7) {
  return {
    webContents: {
      id,
      once: vi.fn(),
      on: vi.fn(),
    },
  }
}

function handler(channel: string) {
  const value = state.handlers.get(channel)
  if (!value) throw new Error(`missing handler ${channel}`)
  return value
}

function installFetcher() {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/register')) return json({ registered: true })
    if (url.endsWith('/claim')) return json({ tasks: [] })
    const accountIds = JSON.parse(String(init?.body)).accountIds as string[]
    return json({ readyAccountIds: accountIds, blockedAccountIds: [], manualRequiredAccountIds: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

beforeEach(() => {
  vi.resetModules()
  state.files.clear()
  state.handlers.clear()
  state.purgeAccount.mockClear()
  vi.unstubAllGlobals()
})

describe('im-hub window runtime installation boundary', () => {
  it('保存会话后只由可信宿主使用主进程 Bearer，同步参数拒绝附加能力', async () => {
    const fetcher = installFetcher()
    const { attachImHubWindowRuntime } = await import('./imhub-window-runtime.js')
    attachImHubWindowRuntime(windowFixture() as never, { nativeBridgePreload: '/preload.mjs' })
    const event = { sender: { id: 7 } }

    await handler('session:save')(event, {
      token: 'main-only-token',
      user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
    })
    await expect(handler(DESKTOP_INSTALLATION_SYNC_CHANNEL)(event, {
      accountIds: [ACCOUNT_ID],
    })).resolves.toEqual({
      readyAccountIds: [ACCOUNT_ID], blockedAccountIds: [], manualRequiredAccountIds: [],
    })
    expect(fetcher).toHaveBeenCalled()
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer main-only-token' })
    }

    await expect(handler(DESKTOP_INSTALLATION_SYNC_CHANNEL)(event, {
      accountIds: [ACCOUNT_ID],
      serverUrl: 'https://attacker.invalid',
    })).rejects.toThrow('同步参数无效')
    await expect(handler(DESKTOP_INSTALLATION_SYNC_CHANNEL)(
      { sender: { id: 99 } },
      { accountIds: [ACCOUNT_ID] },
    )).rejects.toThrow('未授权')
  })

  it('成功恢复会话会启用同步，清除会话后立即停止使用旧 token', async () => {
    const session = JSON.stringify({
      token: 'restored-main-token',
      user: { id: 'user-1', role: 'agent', displayName: 'Agent' },
    })
    state.files.set(
      '/synthetic-user-data/session.bin',
      Buffer.from(Buffer.from(session, 'utf8').map(byte => byte ^ 0xa5)),
    )
    const fetcher = installFetcher()
    const { attachImHubWindowRuntime } = await import('./imhub-window-runtime.js')
    attachImHubWindowRuntime(windowFixture() as never, { nativeBridgePreload: '/preload.mjs' })
    const event = { sender: { id: 7 } }

    expect(handler('session:load')(event)).toMatchObject({ token: 'restored-main-token' })
    await handler(DESKTOP_INSTALLATION_SYNC_CHANNEL)(event, { accountIds: [ACCOUNT_ID] })
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer restored-main-token',
    })

    await handler('session:clear')(event)
    await expect(handler(DESKTOP_INSTALLATION_SYNC_CHANNEL)(event, {
      accountIds: [ACCOUNT_ID],
    })).rejects.toThrow('登录会话不可用')
  })
})
