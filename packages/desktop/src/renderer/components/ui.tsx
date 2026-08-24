import type { CSSProperties, ReactNode } from 'react'
import { PLATFORM_COLOR, PLATFORM_LABEL, STATUS_LABEL, theme } from '../theme.js'

/** 取显示名的首个字符做头像。中文取第一个字，英文取首字母大写；空名兜底成 ?。 */
export function initial(name: string | null | undefined): string {
  const s = (name ?? '').trim()
  if (s === '') return '?'
  return (s[0] ?? '?').toUpperCase()
}

/**
 * 由字符串稳定地推出一个色相。同一个联系人每次渲染颜色必须一样，
 * 所以不能用随机数——这里用最朴素的字符和。
 */
export function hueOf(seed: string): number {
  let sum = 0
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i)
  return sum % 360
}

export function Avatar({ name, size = 36, seed, tone = 'light' }: {
  name: string | null
  size?: number
  seed?: string
  /** dark = 黑底白字，放在绿卡片上用；light = 极淡的彩色底 */
  tone?: 'light' | 'dark'
}) {
  const h = hueOf(seed ?? name ?? '')
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: tone === 'dark' ? theme.color.ink : `hsl(${h} 44% 93%)`,
      color: tone === 'dark' ? theme.color.onInk : `hsl(${h} 34% 30%)`,
      fontSize: Math.round(size * 0.42), fontWeight: theme.font.weight.bold,
    }}>
      {initial(name)}
    </div>
  )
}

/** 平台小图标：圆角方块 + 平台色。没登记过的平台退化成灰底问号，不会崩。 */
export function PlatformIcon({ platform, size = 18 }: { platform: string; size?: number }) {
  const color = PLATFORM_COLOR[platform] ?? theme.color.textFaint
  return (
    <div
      title={PLATFORM_LABEL[platform] ?? platform}
      style={{
        width: size, height: size, borderRadius: Math.round(size * 0.32), flexShrink: 0,
        background: color, color: theme.color.onInk, fontSize: Math.round(size * 0.5), fontWeight: theme.font.weight.heavy,
        display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
      }}
    >
      {(PLATFORM_LABEL[platform] ?? platform).slice(0, 1)}
    </div>
  )
}

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const color = theme.color.status[status as keyof typeof theme.color.status] ?? theme.color.status.pending_auth
  return (
    <span
      title={STATUS_LABEL[status] ?? status}
      className={status === 'reconnecting' ? 'ih-pulse' : undefined}
      style={{
        width: size, height: size, borderRadius: '50%', background: color,
        flexShrink: 0, display: 'inline-block',
      }}
    />
  )
}

export function Chip({ children, tone = 'neutral', style }: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'muted'
  style?: CSSProperties
}) {
  const tones = {
    neutral: { bg: theme.color.surface, fg: theme.color.textMuted },
    accent: { bg: theme.color.lime, fg: theme.color.onLime },
    muted: { bg: 'transparent', fg: theme.color.textFaint },
  }[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: theme.radius.pill,
      background: tones.bg, color: tones.fg,
      fontSize: theme.font.size.xs, fontWeight: theme.font.weight.medium, whiteSpace: 'nowrap',
      ...style,
    }}>
      {children}
    </span>
  )
}

/**
 * 「还没接后端」的统一标记。刻意做得显眼——参考稿里这些入口是能点的，
 * 我们这边不是，不标出来用户会一个个点过去才发现，那更糟。
 */
export function NotWired({ what }: { what: string }) {
  return (
    <Chip tone="muted" style={{ border: `1px dashed ${theme.color.borderStrong}` }}>
      <span title={`${what}：界面已就位，等服务端接口`}>未接入</span>
    </Chip>
  )
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: `${theme.space.md}px ${theme.space.lg}px ${theme.space.sm}px`,
    }}>
      <span style={{
        fontSize: theme.font.size.xs, fontWeight: theme.font.weight.heavy,
        letterSpacing: .8, color: theme.color.textFaint, textTransform: 'uppercase',
      }}>
        {children}
      </span>
      {extra}
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: theme.space.xl, textAlign: 'center',
      fontSize: theme.font.size.sm, color: theme.color.textFaint, lineHeight: 1.7,
    }}>
      {children}
    </div>
  )
}

/** 相对时间。列表里"3 分钟前"比"2026-08-24T09:12:33Z"有用得多。 */
export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return iso.slice(0, 10)
}

export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
