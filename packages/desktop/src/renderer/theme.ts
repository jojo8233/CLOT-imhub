/**
 * 视觉基线：中性冷灰 + 克制的蓝，信息密度偏高——这是给员工盯一整天的工作工具，
 * 不是落地页。不引入任何 CSS 框架或组件库，只是把散落在各组件里的魔法值
 * 收敛成常量，组件里继续用内联 style。
 */
export const theme = {
  color: {
    bg: '#ffffff',
    surface: '#f8fafc',
    surfaceHover: '#f1f5f9',
    border: '#e2e8f0',
    borderStrong: '#cbd5e1',
    text: '#0f172a',
    textMuted: '#64748b',
    textFaint: '#94a3b8',
    accent: '#2563eb',
    accentHover: '#1d4ed8',
    accentSoft: '#eff6ff',
    danger: '#dc2626',
    dangerSoft: '#fef2f2',
    status: {
      connected: '#16a34a',
      reconnecting: '#d97706',
      degraded: '#ea580c',
      disconnected: '#dc2626',
      pending_auth: '#94a3b8',
    },
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 10, lg: 14 },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    size: { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 22 },
  },
  shadow: {
    sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
    md: '0 4px 12px rgba(15, 23, 42, 0.08)',
    lg: '0 12px 32px rgba(15, 23, 42, 0.12)',
  },
} as const
