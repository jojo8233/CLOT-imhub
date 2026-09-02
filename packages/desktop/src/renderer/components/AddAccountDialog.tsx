import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api, NetworkError, type WhatsAppOnboardingStatus } from '../api/client.js'
import type { ChatPlatform } from '../navigation.js'
import { useStore } from '../store.js'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Chip, PlatformIcon } from './ui.js'

/** 各平台目前的接入程度。写在这里而不是散在文案里，将来接完一个改一行。 */
const PLATFORMS: { key: ChatPlatform; blurb: string; ready: boolean }[] = [
  { key: 'telegram', blurb: '扫码登录、消息收发、发送前译文校对', ready: true },
  { key: 'signal', blurb: '使用 Signal Desktop 关联，图片和贴纸保持原生能力', ready: true },
  { key: 'whatsapp', blurb: 'Web 补丁双语；Cloud API 统一会话', ready: true },
]

type Step = 'pick' | 'linking' | 'cloud'
type WhatsAppMode = 'web_shell' | 'cloud_api'

interface RelinkAccount {
  id: string
  platform: ChatPlatform
  displayName: string
}

/**
 * 添加账号：选平台 → 建账号 → 扫码 → 上线。
 *
 * 建完账号接口立刻返回，二维码由服务端经 WebSocket 推过来（auth_challenge）。
 * TDLib 的二维码 token 过期后会自动下发新的链接，所以这里不用计时刷新，
 * 跟着事件走就行。
 */
export function AddAccountDialog({ initialPlatform, onClose }: {
  initialPlatform: ChatPlatform
  onClose(): void
}) {
  const [platform, setPlatform] = useState<ChatPlatform>(initialPlatform)
  const [name, setName] = useState('')
  const [step, setStep] = useState<Step>('pick')
  const [accountId, setAccountId] = useState<string | null>(null)
  // 单独记一份：进入扫码步骤后上面的平台选择器就不该再影响指引文案了
  const [linkingPlatform, setLinkingPlatform] = useState<ChatPlatform>(initialPlatform)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [whatsAppMode, setWhatsAppMode] = useState<WhatsAppMode>('web_shell')
  const [cloudSessionId, setCloudSessionId] = useState<string | null>(null)
  const [cloudExpiresAt, setCloudExpiresAt] = useState<string | null>(null)
  const [cloudStatus, setCloudStatus] = useState<WhatsAppOnboardingStatus['state']>('pending')
  const [cloudAvailable, setCloudAvailable] = useState<boolean | null>(null)

  const challenge = useStore(s => s.authChallenge)
  const done = useStore(s => s.authDone)
  const clearAuth = useStore(s => s.clearAuth)
  const setAccounts = useStore(s => s.setAccounts)
  const setActivePlatform = useStore(s => s.setActivePlatform)
  const setActiveAccount = useStore(s => s.setActiveAccount)

  // 只认自己刚建的这个账号的事件：同一个人可能在别处也在关联另一个账号
  const mine = accountId !== null && challenge?.accountId === accountId ? challenge : null
  const mineDone = accountId !== null && done?.accountId === accountId ? done : null

  // 关掉弹窗时把挑战状态清掉，否则下次打开会闪一下上一轮的二维码
  useEffect(() => () => { clearAuth() }, [clearAuth])

  useEffect(() => {
    if (platform !== 'whatsapp' || step !== 'pick') return
    let active = true
    void api.getWhatsAppCloudConfig().then(() => {
      if (active) setCloudAvailable(true)
    }).catch(() => {
      if (active) {
        setCloudAvailable(false)
        setWhatsAppMode('web_shell')
      }
    })
    return () => { active = false }
  }, [platform, step])

  useEffect(() => {
    if (step !== 'cloud' || !cloudSessionId || !cloudExpiresAt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      if (stopped) return
      if (Date.now() >= new Date(cloudExpiresAt).getTime()) {
        setCloudStatus('failed')
        setError('关联票据已过期，请关闭后重新发起')
        return
      }
      try {
        const status = await api.getWhatsAppCloudOnboarding(cloudSessionId)
        if (stopped) return
        setCloudStatus(status.state)
        if (status.state === 'completed' && status.accountId) {
          const accounts = (await api.listAccounts()).accounts
          if (stopped) return
          setAccounts(accounts)
          setActivePlatform('whatsapp')
          setActiveAccount(status.accountId)
          return
        }
        if (status.state === 'failed') {
          setError('Meta 授权确认失败，请关闭后重新发起')
          return
        }
      } catch (e) {
        if (!stopped && !(e instanceof NetworkError)) {
          setError(e instanceof Error ? e.message : '查询关联状态失败')
          return
        }
      }
      if (!stopped) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [
    cloudExpiresAt,
    cloudSessionId,
    setAccounts,
    setActiveAccount,
    setActivePlatform,
    step,
  ])

  async function handleCreate(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (platform === 'whatsapp' && whatsAppMode === 'cloud_api') {
        if (cloudAvailable !== true) throw new Error('服务端尚未配置 WhatsApp Cloud API')
        const external = window.imHub?.external
        if (!external) throw new Error('当前桌面宿主不能安全打开 Meta 关联页面')
        const session = await api.startWhatsAppCloudOnboarding(name.trim())
        await external.open(session.url)
        setCloudSessionId(session.sessionId)
        setCloudExpiresAt(session.expiresAt)
        setCloudStatus('pending')
        setLinkingPlatform('whatsapp')
        setStep('cloud')
        return
      }
      const account = await api.createAccount({
        platform,
        displayName: name.trim(),
        connectionMode: platform === 'signal'
          ? 'native_desktop'
          : platform === 'whatsapp'
            ? 'web_shell'
            : 'adapter',
      })
      setAccountId(account.id)
      setLinkingPlatform(platform)
      setStep('linking')
      // 新账号此刻还不在列表里，补一次
      setAccounts((await api.listAccounts()).accounts)
      if (platform === 'signal' || platform === 'whatsapp') {
        setActivePlatform(platform)
        setActiveAccount(account.id)
      }
      if (platform === 'signal') onClose()
    } catch (e) {
      setError(e instanceof NetworkError ? '连不上服务端' : (e instanceof Error ? e.message : '创建失败'))
    } finally {
      setBusy(false)
    }
  }

  const suggested = `${PLATFORM_LABEL[platform] ?? platform} ${new Date().getMonth() + 1}`
  const canCreate = PLATFORMS.find(p => p.key === platform)?.ready === true
    && name.trim() !== ''
    && !(platform === 'whatsapp' && whatsAppMode === 'cloud_api' && cloudAvailable !== true)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(41,43,41,.38)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        className="ih-fade"
        onClick={e => e.stopPropagation()}
        style={{
          width: 620, maxWidth: '90vw', background: theme.color.card,
          borderRadius: theme.radius.xxl, boxShadow: theme.shadow.lg, overflow: 'hidden',
        }}
      >
        <div style={{
          padding: `${theme.space.xl}px ${theme.space.xl}px ${theme.space.lg}px`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          borderBottom: `1px solid ${theme.color.border}`,
        }}>
          <div>
            <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy, letterSpacing: -.5 }}>
              添加账号
            </div>
            <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 2 }}>
              {step === 'pick'
                ? '选择平台，创建一个独立登录的账号'
                : step === 'cloud'
                  ? '在外部 HTTPS 页面完成 Meta Embedded Signup'
                : linkingPlatform === 'signal'
                  ? '打开 Signal Desktop 完成关联'
                  : '用手机扫码完成关联'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ih-btn"
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: `1px solid ${theme.color.border}`, background: theme.color.white,
              color: theme.color.textMuted, fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>

        {step === 'pick' ? (
          <>
            <div style={{
              padding: theme.space.xl, display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)', gap: theme.space.md,
            }}>
              {PLATFORMS.map(p => {
                const on = platform === p.key
                return (
                  <button
                    key={p.key}
                    onClick={() => setPlatform(p.key)}
                    style={{
                      textAlign: 'left', padding: theme.space.md, borderRadius: theme.radius.lg,
                      border: `1.5px solid ${on ? theme.color.limeDeep : theme.color.border}`,
                      background: on ? theme.color.limeSoft : theme.color.white,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: theme.space.sm, marginBottom: 6 }}>
                      <PlatformIcon platform={p.key} size={26} />
                      <span style={{ fontSize: theme.font.size.md, fontWeight: theme.font.weight.heavy }}>
                        {PLATFORM_LABEL[p.key] ?? p.key}
                      </span>
                    </div>
                    <div style={{ fontSize: theme.font.size.xs, color: theme.color.textMuted, lineHeight: 1.6, minHeight: 30 }}>
                      {p.blurb}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      {p.ready
                        ? <Chip tone="accent">已接入</Chip>
                        : <Chip tone="muted" style={{ border: `1px dashed ${theme.color.borderStrong}` }}>未接入</Chip>}
                    </div>
                  </button>
                )
              })}
            </div>

            <div style={{ padding: `0 ${theme.space.xl}px ${theme.space.lg}px` }}>
              <label style={{
                display: 'block', fontSize: theme.font.size.sm,
                color: theme.color.textMuted, marginBottom: theme.space.xs,
              }}>
                账号名称
              </label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canCreate) void handleCreate() }}
                placeholder={suggested}
                autoFocus
                maxLength={60}
                style={{
                  width: '100%', padding: '11px 14px', fontSize: theme.font.size.md,
                  border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
                  background: theme.color.white, color: theme.color.text,
                }}
              />
              <div style={{ fontSize: theme.font.size.xs, color: theme.color.textFaint, marginTop: 6 }}>
                只用于在这里区分多个账号，跟平台上的昵称无关
              </div>

              {platform === 'signal' && (
                <div style={{
                  marginTop: theme.space.md, padding: theme.space.md,
                  background: theme.color.surface, borderRadius: theme.radius.lg,
                  fontSize: theme.font.size.sm, color: theme.color.textMuted, lineHeight: 1.8,
                }}>
                  这里只登记由 Signal Desktop 托管的原生账号，不会启动 signal-cli，
                  也不会生成 signal-cli 二维码。
                </div>
              )}
              {platform === 'whatsapp' && (
                <>
                  <div style={{
                    marginTop: theme.space.md, display: 'grid', gridTemplateColumns: '1fr 1fr',
                    gap: theme.space.sm,
                  }}>
                    <button
                      className="ih-btn"
                      onClick={() => setWhatsAppMode('web_shell')}
                      style={{
                        padding: 10, borderRadius: theme.radius.md,
                        border: `1px solid ${whatsAppMode === 'web_shell' ? theme.color.limeDeep : theme.color.border}`,
                        background: whatsAppMode === 'web_shell' ? theme.color.limeSoft : theme.color.white,
                      }}
                    >
                      Web 补丁双语页面
                    </button>
                    <button
                      className="ih-btn"
                      disabled={cloudAvailable !== true}
                      onClick={() => setWhatsAppMode('cloud_api')}
                      style={{
                        padding: 10, borderRadius: theme.radius.md,
                        border: `1px solid ${whatsAppMode === 'cloud_api' ? theme.color.limeDeep : theme.color.border}`,
                        background: whatsAppMode === 'cloud_api' ? theme.color.limeSoft : theme.color.white,
                        opacity: cloudAvailable === true ? 1 : .5,
                      }}
                    >
                      Cloud API 双语会话{cloudAvailable === false ? '（未配置）' : ''}
                    </button>
                  </div>
                  <div style={{
                    marginTop: theme.space.sm, padding: theme.space.md,
                    background: theme.color.surface, borderRadius: theme.radius.lg,
                    fontSize: theme.font.size.sm, color: theme.color.textMuted, lineHeight: 1.8,
                  }}>
                    {whatsAppMode === 'web_shell'
                      ? '隔离加载 WhatsApp Web，并注入双语气泡与翻译输入桥接。'
                      : '在外部 HTTPS 页面完成 Meta Embedded Signup。token 只回服务端加密保存；入站消息与中英译文显示在 im-hub 自有会话中。'}
                  </div>
                </>
              )}
              {error && (
                <div style={{
                  marginTop: theme.space.md, padding: '8px 12px',
                  background: theme.color.dangerSoft, borderRadius: theme.radius.md,
                  fontSize: theme.font.size.sm, color: theme.color.danger,
                }}>
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <FooterButton onClick={onClose} kind="ghost">取消</FooterButton>
              <FooterButton
                onClick={() => void handleCreate()}
                kind="primary"
                disabled={!canCreate || busy}
              >
                {busy
                  ? '创建中…'
                  : platform === 'signal'
                    ? '创建并打开'
                    : platform === 'whatsapp' && whatsAppMode === 'cloud_api'
                      ? '打开 Meta 关联'
                      : '创建并扫码'}
              </FooterButton>
            </DialogFooter>
          </>
        ) : step === 'cloud' ? (
          <WhatsAppCloudStep status={cloudStatus} error={error} onClose={onClose} />
        ) : accountId ? (
          <LinkingStep
            accountId={accountId}
            platform={linkingPlatform}
            challenge={mine}
            done={mineDone}
            onClose={onClose}
          />
        ) : null}
      </div>
    </div>
  )
}

function WhatsAppCloudStep({ status, error, onClose }: {
  status: WhatsAppOnboardingStatus['state']
  error: string | null
  onClose(): void
}) {
  const completed = status === 'completed'
  return (
    <>
      <div style={{ padding: `${theme.space.xxl}px ${theme.space.xl}px`, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: theme.space.md }}>{completed ? '✓' : 'W'}</div>
        <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
          {completed ? 'WhatsApp Cloud API 已关联' : '请在浏览器完成 Meta 关联'}
        </div>
        <div style={{
          maxWidth: 450, margin: '8px auto 0', fontSize: theme.font.size.sm,
          color: error ? theme.color.danger : theme.color.textMuted, lineHeight: 1.8,
        }}>
          {error ?? (completed
            ? '账号已切换到 im-hub 自有双语会话视图。'
            : status === 'processing'
              ? 'Meta 授权已返回，服务端正在确认号码并订阅 Webhook…'
              : '关联页使用一次性票据；access token 不会回到 Electron 或 WhatsApp Web。')}
        </div>
      </div>
      <DialogFooter>
        <FooterButton onClick={onClose} kind="primary">{completed ? '进入会话' : '关闭'}</FooterButton>
      </DialogFooter>
    </>
  )
}

/** 已存在但未连上的账号重新进入同一套扫码/验证码/2FA 流程。 */
export function RelinkAccountDialog({ account, onClose }: {
  account: RelinkAccount
  onClose(): void
}) {
  const challenge = useStore(s => s.authChallenge)
  const done = useStore(s => s.authDone)
  const clearAuth = useStore(s => s.clearAuth)
  const [error, setError] = useState<string | null>(null)
  const relinkRequest = useRef<{ accountId: string; promise: Promise<void> } | null>(null)

  const mine = challenge?.accountId === account.id ? challenge : null
  const mineDone = done?.accountId === account.id ? done : null

  useEffect(() => {
    let active = true
    clearAuth()
    if (account.platform === 'signal') {
      return () => {
        active = false
        clearAuth()
      }
    }
    if (relinkRequest.current?.accountId !== account.id) {
      relinkRequest.current = { accountId: account.id, promise: api.relinkAccount(account.id) }
    }
    void relinkRequest.current.promise.catch((e: unknown) => {
      if (active) {
        setError(e instanceof NetworkError ? '连不上服务端' : (e instanceof Error ? e.message : '重新关联失败'))
      }
    })
    return () => {
      active = false
      clearAuth()
    }
  }, [account.id, account.platform, clearAuth])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(41,43,41,.38)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        className="ih-fade"
        onClick={e => e.stopPropagation()}
        style={{
          width: 620, maxWidth: '90vw', background: theme.color.card,
          borderRadius: theme.radius.xxl, boxShadow: theme.shadow.lg, overflow: 'hidden',
        }}
      >
        <div style={{
          padding: `${theme.space.xl}px ${theme.space.xl}px ${theme.space.lg}px`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          borderBottom: `1px solid ${theme.color.border}`,
        }}>
          <div>
            <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy, letterSpacing: -.5 }}>
              重新关联「{account.displayName}」
            </div>
            <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 2 }}>
              重新建立服务端平台会话，原生客户端登录态保持独立
            </div>
          </div>
          <button
            onClick={onClose}
            className="ih-btn"
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: `1px solid ${theme.color.border}`, background: theme.color.white,
              color: theme.color.textMuted, fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>

        {account.platform === 'signal' ? (
          <SignalDesktopStep onClose={onClose} />
        ) : error ? (
          <>
            <div style={{
              margin: theme.space.xl, padding: theme.space.md,
              background: theme.color.dangerSoft, borderRadius: theme.radius.md,
              fontSize: theme.font.size.sm, color: theme.color.danger,
            }}>
              {error}
            </div>
            <DialogFooter>
              <FooterButton onClick={onClose} kind="primary">关闭</FooterButton>
            </DialogFooter>
          </>
        ) : (
          <LinkingStep
            accountId={account.id}
            platform={account.platform}
            challenge={mine}
            done={mineDone}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  )
}

function LinkingStep({ accountId, platform, challenge, done, onClose }: {
  accountId: string
  platform: string
  challenge: { kind: string; payload: string } | null
  done: { ok: boolean; reason: string | null } | null
  onClose(): void
}) {
  if (platform === 'whatsapp') {
    return <WhatsAppWebStep onClose={onClose} />
  }
  if (platform === 'signal') {
    return <SignalDesktopStep onClose={onClose} />
  }

  if (done) {
    return (
      <>
        <div style={{ padding: `${theme.space.xxl}px ${theme.space.xl}px`, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: theme.space.md }}>{done.ok ? '✓' : '✕'}</div>
          <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
            {done.ok ? '账号已关联' : '关联失败'}
          </div>
          <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 6 }}>
            {done.ok ? '消息会自动同步进来，稍等片刻' : (done.reason ?? '请重新发起关联')}
          </div>
        </div>
        <DialogFooter>
          <FooterButton onClick={onClose} kind="primary">完成</FooterButton>
        </DialogFooter>
      </>
    )
  }

  if (challenge?.kind === 'password' || challenge?.kind === 'code') {
    return <AnswerStep accountId={accountId} kind={challenge.kind} hint={challenge.payload} onClose={onClose} />
  }

  return (
    <QrStep
      accountId={accountId}
      platform={platform}
      link={challenge?.kind === 'qr' ? challenge.payload : null}
      onClose={onClose}
    />
  )
}

function SignalDesktopStep({ onClose }: { onClose(): void }) {
  return (
    <>
      <div style={{ padding: `${theme.space.xxl}px ${theme.space.xl}px`, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: theme.space.md }}>S</div>
        <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
          请在 Signal Desktop 中关联
        </div>
        <div style={{
          maxWidth: 440, margin: '8px auto 0', fontSize: theme.font.size.sm,
          color: theme.color.textMuted, lineHeight: 1.8,
        }}>
          返回“会话”后会在 im-hub 同一窗口中打开 Signal Desktop。二维码、文字、图片和
          贴纸都由 Signal 原生客户端处理；这里不再生成 signal-cli 二维码。
        </div>
      </div>
      <DialogFooter>
        <FooterButton onClick={onClose} kind="primary">返回会话</FooterButton>
      </DialogFooter>
    </>
  )
}

function WhatsAppWebStep({ onClose }: { onClose(): void }) {
  return (
    <>
      <div style={{ padding: `${theme.space.xxl}px ${theme.space.xl}px`, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: theme.space.md }}>✓</div>
        <div style={{ fontSize: theme.font.size.lg, fontWeight: theme.font.weight.heavy }}>
          WhatsApp 会话已创建
        </div>
        <div style={{
          maxWidth: 440, margin: '8px auto 0', fontSize: theme.font.size.sm,
          color: theme.color.textMuted, lineHeight: 1.8,
        }}>
          关闭后进入“会话”，在官方 WhatsApp Web 页面用手机扫码。
          登录身份核对完成后，当前可见的历史及新文字气泡会显示中英译文；页面改版时可能需要更新兼容补丁。
        </div>
      </div>
      <DialogFooter>
        <FooterButton onClick={onClose} kind="primary">进入会话扫码</FooterButton>
      </DialogFooter>
    </>
  )
}

/** 各平台关联入口的路径不一样，写死一套会把人带到找不到的菜单里 */
const SCAN_GUIDE: Record<string, {
  title: string
  steps: string[]
  note: string
  /** 过期后平台会不会自己下发新码。Telegram 会，Signal 的链接是一次性的 */
  autoRefresh: boolean
}> = {
  telegram: {
    title: '用手机上的 Telegram 扫这个码',
    steps: ['打开手机上的 Telegram', '设置 → 设备 → 关联桌面设备', '扫描左边这个二维码'],
    note: '如果账号开了二次验证，扫码后还会让你输一次密码。',
    autoRefresh: true,
  },
  signal: {
    title: '用手机上的 Signal 扫这个码',
    steps: ['打开手机上的 Signal', '设置 → 已关联设备 → 关联新设备', '扫描左边这个二维码'],
    note: '关联后手机仍是主设备，这里是次要设备；你在手机上发的消息也会同步过来。',
    autoRefresh: false,
  },
}

function QrStep({ accountId, platform, link, onClose }: {
  accountId: string
  platform: string
  link: string | null
  onClose(): void
}) {
  const [svg, setSvg] = useState<string | null>(null)
  const [relinking, setRelinking] = useState(false)
  const guide = SCAN_GUIDE[platform] ?? SCAN_GUIDE.telegram!

  useEffect(() => {
    if (link === null) { setSvg(null); return }
    let cancelled = false
    // 用 svg 而不是 toDataURL：后者依赖 canvas，svg 是纯字符串，渲染更省事也更清晰。
    // QRCode 自己生成整段 SVG，不会把 link 原样插进标记里，所以没有注入面
    void QRCode.toString(link, { type: 'svg', margin: 1, width: 220 })
      .then(out => { if (!cancelled) setSvg(out) })
      .catch(() => { if (!cancelled) setSvg(null) })
    return () => { cancelled = true }
  }, [link])

  async function handleRelink(): Promise<void> {
    setRelinking(true)
    try { await api.relinkAccount(accountId) } catch { /* 失败就还是停在这一屏 */ }
    finally { setRelinking(false) }
  }

  return (
    <>
      <div style={{
        padding: theme.space.xl, display: 'flex', gap: theme.space.xl, alignItems: 'center',
      }}>
        <div style={{
          width: 220, height: 220, flexShrink: 0, borderRadius: theme.radius.lg,
          background: theme.color.white, border: `1px solid ${theme.color.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.space.sm,
        }}>
          {svg
            ? <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
            : (
              <span className="ih-pulse" style={{ fontSize: theme.font.size.sm, color: theme.color.textFaint }}>
                正在生成二维码…
              </span>
            )}
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: theme.font.size.md, fontWeight: theme.font.weight.heavy, marginBottom: theme.space.sm }}>
            {guide.title}
          </div>
          <ol style={{
            margin: 0, paddingLeft: 18, fontSize: theme.font.size.sm,
            color: theme.color.textMuted, lineHeight: 2,
          }}>
            {guide.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          <div style={{
            marginTop: theme.space.md, fontSize: theme.font.size.xs,
            color: theme.color.textFaint, lineHeight: 1.7,
          }}>
            {guide.autoRefresh ? '二维码过期会自动换新的，不用管。' : '二维码过期后点「重新生成」再扫。'}
            <br />
            {guide.note}
          </div>
        </div>
      </div>

      <DialogFooter>
        <FooterButton onClick={() => void handleRelink()} kind="ghost" disabled={relinking}>
          {relinking ? '重新生成中…' : '重新生成'}
        </FooterButton>
        <FooterButton onClick={onClose} kind="ghost">稍后再说</FooterButton>
      </DialogFooter>
    </>
  )
}

/**
 * 验证码 / 二次验证密码输入。
 *
 * value 只活在这个组件的 state 里：不进 store、不打 console、发完就随组件卸载消失。
 */
function AnswerStep({ accountId, kind, hint, onClose }: {
  accountId: string
  kind: 'password' | 'code'
  hint: string
  onClose(): void
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isPassword = kind === 'password'

  async function submit(): Promise<void> {
    if (busy || value === '') return
    setBusy(true)
    setError(null)
    try {
      await api.submitAuthAnswer(accountId, value)
      setValue('')
    } catch (e) {
      setError(e instanceof NetworkError ? '连不上服务端' : '提交失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ padding: theme.space.xl }}>
        <div style={{ fontSize: theme.font.size.md, fontWeight: theme.font.weight.heavy }}>
          {isPassword ? '这个账号开了二次验证' : '需要输入验证码'}
        </div>
        <div style={{
          fontSize: theme.font.size.sm, color: theme.color.textMuted,
          marginTop: 4, marginBottom: theme.space.lg, lineHeight: 1.7,
        }}>
          {isPassword
            ? <>请输入你的 Telegram 二次验证密码{hint !== '' && <>（提示：{hint}）</>}。<br />
                它只用于完成这次登录，不会被保存。</>
            : hint}
        </div>
        <input
          type={isPassword ? 'password' : 'text'}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          autoFocus
          maxLength={256}
          placeholder={isPassword ? '••••••••' : '验证码'}
          style={{
            width: '100%', padding: '11px 14px', fontSize: theme.font.size.md,
            border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.lg,
            background: theme.color.white, color: theme.color.text,
          }}
        />
        {error && (
          <div style={{
            marginTop: theme.space.md, padding: '8px 12px',
            background: theme.color.dangerSoft, borderRadius: theme.radius.md,
            fontSize: theme.font.size.sm, color: theme.color.danger,
          }}>
            {error}
          </div>
        )}
      </div>

      <DialogFooter>
        <FooterButton onClick={onClose} kind="ghost">取消</FooterButton>
        <FooterButton onClick={() => void submit()} kind="primary" disabled={busy || value === ''}>
          {busy ? '提交中…' : '确定'}
        </FooterButton>
      </DialogFooter>
    </>
  )
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: `${theme.space.md}px ${theme.space.xl}px`, display: 'flex', justifyContent: 'flex-end',
      gap: theme.space.sm, borderTop: `1px solid ${theme.color.border}`, background: theme.color.surface,
    }}>
      {children}
    </div>
  )
}

function FooterButton({ children, onClick, kind, disabled }: {
  children: React.ReactNode
  onClick(): void
  kind: 'primary' | 'ghost'
  disabled?: boolean
}) {
  const primary = kind === 'primary'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="ih-btn"
      style={{
        padding: '10px 22px', borderRadius: theme.radius.pill,
        border: primary ? 'none' : `1px solid ${theme.color.borderStrong}`,
        background: primary ? (disabled ? theme.color.surfaceHover : theme.color.ink) : theme.color.white,
        color: primary ? (disabled ? theme.color.textFaint : theme.color.lime) : theme.color.text,
        opacity: primary ? 1 : undefined,
        fontSize: theme.font.size.base,
        fontWeight: primary ? theme.font.weight.heavy : theme.font.weight.bold,
      }}
    >
      {children}
    </button>
  )
}
