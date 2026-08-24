import { useState } from 'react'
import { PLATFORM_LABEL, theme } from '../theme.js'
import { Chip, PlatformIcon } from './ui.js'

/** 各平台目前的接入程度。写在这里而不是散在文案里，将来接完一个改一行。 */
const PLATFORMS: { key: string; blurb: string; ready: boolean }[] = [
  { key: 'telegram', blurb: '消息收发、自动翻译、发送前校对', ready: true },
  { key: 'whatsapp', blurb: '需要网页版壳 + 扫码登录', ready: false },
  { key: 'signal', blurb: '需要 signal-cli + 关联设备扫码', ready: false },
  { key: 'zoom', blurb: 'Team Chat，需走官方 OAuth', ready: false },
]

/**
 * 添加账号弹窗。
 *
 * 界面照参考稿做齐了，但「创建」是灰的——服务端目前只有 GET /api/accounts，
 * 没有创建账号的接口，账号还是 seed 出来的。做成能点但点了没反应，
 * 比明说「还没接」更浪费用户时间。
 */
export function AddAccountDialog({ onClose }: { onClose(): void }) {
  const [selected, setSelected] = useState('telegram')

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
            <div style={{ fontSize: theme.font.size.xl, fontWeight: theme.font.weight.heavy, letterSpacing: -.5 }}>添加账号</div>
            <div style={{ fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: 2 }}>
              选择平台，创建一个独立登录的账号
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: `1px solid ${theme.color.border}`, background: theme.color.white,
              color: theme.color.textMuted, fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{
          padding: theme.space.xl, display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)', gap: theme.space.md,
        }}>
          {PLATFORMS.map(p => {
            const on = selected === p.key
            return (
              <button
                key={p.key}
                onClick={() => setSelected(p.key)}
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

        <div style={{
          margin: `0 ${theme.space.xl}px ${theme.space.xl}px`, padding: theme.space.lg,
          background: theme.color.surface, borderRadius: theme.radius.lg,
          fontSize: theme.font.size.sm, color: theme.color.textMuted, lineHeight: 1.8,
        }}>
          <div style={{ fontWeight: 600, color: theme.color.text, marginBottom: 4 }}>
            为什么现在还创建不了
          </div>
          服务端目前只有 <code style={{ background: theme.color.white, padding: '1px 5px', borderRadius: 4 }}>GET /api/accounts</code>，
          账号来自 seed。要在这里创建，还缺三样：新建账号的接口、把扫码链接推到前端的通道
          （适配器里的 <code style={{ background: theme.color.white, padding: '1px 5px', borderRadius: 4 }}>onAuthChallenge</code> 已经留好）、
          以及各平台自己的登录实现。
        </div>

        <div style={{
          padding: `${theme.space.md}px ${theme.space.xl}px`, display: 'flex', justifyContent: 'flex-end',
          gap: theme.space.sm, borderTop: `1px solid ${theme.color.border}`, background: theme.color.surface,
        }}>
          <button
            onClick={onClose}
            className="ih-btn"
            style={{
              padding: '10px 22px', borderRadius: theme.radius.pill,
              border: `1px solid ${theme.color.borderStrong}`, background: theme.color.white,
              fontSize: theme.font.size.base, fontWeight: theme.font.weight.bold, color: theme.color.text,
            }}
          >
            关闭
          </button>
          <button
            disabled
            title="等服务端提供创建账号接口"
            className="ih-btn"
            style={{
              padding: '10px 22px', borderRadius: theme.radius.pill, border: 'none',
              background: theme.color.ink, color: theme.color.lime,
              fontSize: theme.font.size.base, fontWeight: theme.font.weight.heavy,
            }}
          >
            创建账号
          </button>
        </div>
      </div>
    </div>
  )
}
