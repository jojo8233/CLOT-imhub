import { describe, expect, it } from 'vitest'
import {
  browserCompatibleUserAgent,
  createSingleFlight,
  nativeAccountControllable,
  nativeAccountIdsToMount,
  nativeWebviewAlreadyLoaded,
  nativeWebviewAtExpectedOrigin,
  signalDesktopAccountIdsToMount,
  signalInboundErrorIsNonfatal,
  signalOutboxStatusError,
} from './NativeClient.js'

describe('native account ownership gate', () => {
  const account = { owner_user_id: 'user-1' }

  it('只允许当前 owner 且非 auditor 挂载原生 pane', () => {
    expect(nativeAccountControllable(account, { id: 'user-1', role: 'agent' })).toBe(true)
    expect(nativeAccountControllable(account, { id: 'manager-1', role: 'manager' })).toBe(false)
    expect(nativeAccountControllable(account, { id: 'user-1', role: 'auditor' })).toBe(false)
    expect(nativeAccountControllable(null, { id: 'user-1', role: 'agent' })).toBe(false)
  })

  it('宿主启动时预挂载 owner 的全部已支持账号，不依赖先点开 tab', () => {
    const accounts = [
      { id: 'tg-1', platform: 'telegram', owner_user_id: 'user-1' },
      { id: 'tg-2', platform: 'telegram', owner_user_id: 'user-1' },
      { id: 'signal-1', platform: 'signal', owner_user_id: 'user-1' },
      { id: 'wa-1', platform: 'whatsapp', owner_user_id: 'user-1' },
      { id: 'other-tg', platform: 'telegram', owner_user_id: 'user-2' },
    ]

    expect(nativeAccountIdsToMount(accounts, { id: 'user-1', role: 'agent' }, true))
      .toEqual(['tg-1', 'tg-2', 'wa-1'])
    expect(nativeAccountIdsToMount(accounts, { id: 'user-1', role: 'auditor' }, true))
      .toEqual([])
    expect(nativeAccountIdsToMount(accounts, { id: 'user-1', role: 'agent' }, false))
      .toEqual([])
  })

  it('Signal Desktop 只挂载显式登记的原生桌面账号', () => {
    const accounts = [
      { id: 'native', platform: 'signal', owner_user_id: 'user-1', connection_mode: 'native_desktop' as const },
      { id: 'fallback', platform: 'signal', owner_user_id: 'user-1', connection_mode: 'adapter' as const },
      { id: 'other', platform: 'signal', owner_user_id: 'user-2', connection_mode: 'native_desktop' as const },
    ]
    expect(signalDesktopAccountIdsToMount(
      accounts,
      { id: 'user-1', role: 'agent' },
      true,
    )).toEqual(['native'])
    expect(signalDesktopAccountIdsToMount(
      accounts,
      { id: 'user-1', role: 'agent' },
      false,
    )).toEqual([])
  })
})

describe('official web client user agent', () => {
  it('presents the embedded Chromium engine without Electron or app tokens', () => {
    const result = browserCompatibleUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) im-hub/0.0.0 Chrome/128.0.0.0 Electron/33.0.0 Safari/537.36',
    )
    expect(result).toContain('Chrome/128.0.0.0')
    expect(result).not.toContain('Electron')
    expect(result).not.toContain('im-hub')
  })
})

describe('native webview load recovery', () => {
  const probe = (overrides: Partial<{
    url: string
    webContentsId: number
    loading: boolean
  }> = {}) => ({
    getURL: () => overrides.url ?? 'http://localhost:1234/#123',
    getWebContentsId: () => overrides.webContentsId ?? 42,
    isLoading: () => overrides.loading ?? false,
  })

  it('effect 挂载晚于 dom-ready 时识别已完成加载的受信页面', () => {
    expect(nativeWebviewAlreadyLoaded(probe(), 'http://localhost:1234/')).toBe(true)
  })

  it('加载中、未附着或来源不匹配时继续等待正式事件', () => {
    expect(nativeWebviewAlreadyLoaded(probe({ loading: true }), 'http://localhost:1234/')).toBe(false)
    expect(nativeWebviewAlreadyLoaded(probe({ webContentsId: 0 }), 'http://localhost:1234/')).toBe(false)
    expect(nativeWebviewAlreadyLoaded(
      probe({ url: 'https://web.telegram.org/' }),
      'http://localhost:1234/',
    )).toBe(false)
  })

  it('shell-only 官方页面只要已附着且来源匹配就显示自身加载状态', () => {
    expect(nativeWebviewAtExpectedOrigin(
      probe({ url: 'https://web.whatsapp.com/', loading: true }),
      'https://web.whatsapp.com/',
    )).toBe(true)
    expect(nativeWebviewAtExpectedOrigin(
      probe({ url: 'https://web.whatsapp.com.evil.example/', loading: true }),
      'https://web.whatsapp.com/',
    )).toBe(false)
    expect(nativeWebviewAtExpectedOrigin(
      probe({ url: 'https://web.whatsapp.com/', webContentsId: 0, loading: true }),
      'https://web.whatsapp.com/',
    )).toBe(false)
  })
})

describe('Signal persistent outbox status', () => {
  it('只把需要人工关注的非敏感状态转换成页面提示', () => {
    expect(signalOutboxStatusError({
      pendingCount: 0,
      deadLetterCount: 0,
      lastErrorCode: null,
    })).toBeNull()
    expect(signalOutboxStatusError({
      pendingCount: 0,
      deadLetterCount: 0,
      lastErrorCode: 'outbox_storage_failed',
    })).toBe('持久消息队列不可用')
    expect(signalOutboxStatusError({
      pendingCount: 1,
      deadLetterCount: 0,
      lastErrorCode: 'ack_timeout',
    })).toBe('持久消息队列暂时失败，正在重试')
    expect(signalOutboxStatusError({
      pendingCount: 0,
      deadLetterCount: 2,
      lastErrorCode: 'permanent_rejection',
    })).toBe('2 条事件永久失败，等待人工处理')
  })
})

describe('Signal inbound message errors', () => {
  it('单条消息归一化或媒体不支持只提示，不把账号桥接标记为致命故障', () => {
    expect(signalInboundErrorIsNonfatal('invalid_signal_inbound')).toBe(true)
    expect(signalInboundErrorIsNonfatal('invalid_signal_media')).toBe(true)
    expect(signalInboundErrorIsNonfatal('unsupported_signal_media')).toBe(true)
    expect(signalInboundErrorIsNonfatal('invalid_signal_edit')).toBe(true)
    expect(signalInboundErrorIsNonfatal('invalid_signal_delete')).toBe(true)
    expect(signalInboundErrorIsNonfatal('invalid_signal_reaction')).toBe(true)
    expect(signalInboundErrorIsNonfatal('signal_identity_unavailable')).toBe(false)
  })
})

describe('native control grant provisioning', () => {
  it('并发触发只签发一次，完成后才允许下一次刷新', async () => {
    let finish: () => void = () => {
      throw new Error('resolver 尚未就绪')
    }
    let calls = 0
    const provision = createSingleFlight(() => {
      calls += 1
      return new Promise<void>((resolve) => { finish = resolve })
    })

    const first = provision()
    const duplicate = provision()
    expect(duplicate).toBe(first)
    expect(calls).toBe(1)

    finish()
    await first

    void provision()
    expect(calls).toBe(2)
  })
})
