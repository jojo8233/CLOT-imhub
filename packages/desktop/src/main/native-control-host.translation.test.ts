import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CONTROL_CONFIGURE_CHANNEL,
  NATIVE_GUEST_EVENT_CHANNEL,
  NATIVE_TRANSLATE_BATCH_CHANNEL,
} from '../native-control-ipc.js'

type Sender = { id: number }
type Handler = (event: { sender: Sender }, value: unknown) => unknown
type Listener = (event: { sender: Sender }, value: unknown) => void

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Listener>(),
  hostSend: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => electron.handlers.set(channel, handler),
    on: (channel: string, listener: Listener) => electron.listeners.set(channel, listener),
  },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: () => ({ send: electron.hostSend }) },
}))

import { NativeControlHost } from './native-control-host.js'

const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const GRANT = 'synthetic-native-grant'
const EXTERNAL_ID = '778899'

function contents(id: number) {
  return {
    id,
    once: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false,
    close: vi.fn(),
  }
}

async function configuredHost() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/native/control-grant/verify')) {
      return new Response(JSON.stringify({
        accountId: ACCOUNT_ID,
        platform: 'telegram',
        expectedPlatformAccountExternalId: EXTERNAL_ID,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/translate/batch')) {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const host = new NativeControlHost('https://imhub.example.test')
  const hostContents = contents(7)
  const guestContents = contents(11)
  host.install()
  host.attachHost(hostContents as never)
  host.registerGuest(guestContents as never, ACCOUNT_ID, hostContents.id)

  const configure = electron.handlers.get(NATIVE_CONTROL_CONFIGURE_CHANNEL)
  const guestEvent = electron.listeners.get(NATIVE_GUEST_EVENT_CHANNEL)
  if (!configure || !guestEvent) throw new Error('expected native IPC handlers')
  await configure(
    { sender: hostContents },
    { accountId: ACCOUNT_ID, guestWebContentsId: guestContents.id, grant: GRANT },
  )
  guestEvent({ sender: guestContents }, {
    protocolVersion: 3,
    type: 'account.identity',
    platformAccountExternalId: EXTERNAL_ID,
  })

  return { fetchMock, guestContents }
}

beforeEach(() => {
  electron.handlers.clear()
  electron.listeners.clear()
  electron.hostSend.mockClear()
  vi.unstubAllGlobals()
})

describe('NativeControlHost translation boundary', () => {
  it('只转发共享联合类型中的 provider', async () => {
    const { fetchMock, guestContents } = await configuredHost()
    const translate = electron.handlers.get(NATIVE_TRANSLATE_BATCH_CHANNEL)
    if (!translate) throw new Error('expected translate handler')

    await translate({ sender: guestContents }, {
      texts: ['hello'], targetLang: 'zh', sourceLang: 'en', provider: 'claude',
    })

    const translationCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/translate/batch'))
    expect(translationCall).toBeDefined()
    expect(JSON.parse(String(translationCall?.[1]?.body))).toEqual({
      texts: ['hello'], targetLang: 'zh', sourceLang: 'en', provider: 'claude',
    })
  })

  it('拒绝未知 provider 和身份夹带字段', async () => {
    const { fetchMock, guestContents } = await configuredHost()
    const translate = electron.handlers.get(NATIVE_TRANSLATE_BATCH_CHANNEL)
    if (!translate) throw new Error('expected translate handler')

    await expect(translate({ sender: guestContents }, {
      texts: ['hello'], targetLang: 'zh', provider: 'unknown',
    })).rejects.toThrow('批量翻译参数无效')
    await expect(translate({ sender: guestContents }, {
      texts: ['hello'], targetLang: 'zh', userId: 'someone-else',
    })).rejects.toThrow('批量翻译参数无效')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
