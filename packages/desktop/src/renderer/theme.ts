/**
 * 视觉基线。参考稿的观感来自三件事，改这里之前先理解它们：
 *
 *   1. 窗口不是白的——是 page 这层浅灰，白色内容以大圆角卡片浮在上面
 *   2. 圆角给得很大（卡片 24~30，内部元素 12~18），小圆角会立刻失去那个调子
 *   3. 蓝只用在"当前所在位置"和主操作上，其余一律灰阶。蓝一多就变成花架子
 *
 * 不引入任何 CSS 框架或组件库，只把散落的魔法值收敛成常量，组件里继续用内联
 * style；伪类（hover/focus/滚动条）内联写不了，统一放 styles.ts。
 */
export const theme = {
  color: {
    /** 窗口底色。白卡片浮在这层灰上，整套设计的对比基础 */
    page: '#e3e5e8',
    bg: '#ffffff',
    surface: '#f5f7fa',
    surfaceHover: '#eceff4',
    border: '#e9edf2',
    borderStrong: '#d6dce4',
    text: '#0d1420',
    textMuted: '#6a7488',
    textFaint: '#9aa3b4',
    /** 深靛蓝：当前导航项、自己发出的气泡、主账号卡 */
    navy: '#101a5c',
    navyDeep: '#0a1244',
    accent: '#0a6fe8',
    accentHover: '#0857b8',
    accentBright: '#2e90ff',
    accentSoft: '#eaf2ff',
    gold: '#ffc439',
    green: '#22b573',
    danger: '#e0364a',
    dangerSoft: '#fdecef',
    status: {
      connected: '#22b573',
      reconnecting: '#e79a1a',
      degraded: '#ea6a1a',
      disconnected: '#e0364a',
      pending_auth: '#9aa3b4',
    },
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 18, xl: 24, xxl: 30, pill: 999 },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    size: { xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 22, xxl: 28 },
  },
  shadow: {
    sm: '0 1px 2px rgba(13, 20, 32, 0.05)',
    md: '0 4px 14px rgba(13, 20, 32, 0.07)',
    lg: '0 12px 32px rgba(13, 20, 32, 0.12)',
    /** 最外层那张大卡片专用，压得比 lg 更开更淡 */
    app: '0 18px 48px rgba(13, 20, 32, 0.14)',
  },
} as const

/** 平台标识色。新增平台在这里补一行，头像和徽章会一起跟着变。 */
export const PLATFORM_COLOR: Record<string, string> = {
  telegram: '#2aa3e0',
  whatsapp: '#25d366',
  signal: '#3a76f0',
  zoom: '#2d8cff',
}

export const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  zoom: 'Zoom',
}

export const STATUS_LABEL: Record<string, string> = {
  connected: '在线',
  reconnecting: '重连中',
  degraded: '降级',
  disconnected: '已断开',
  pending_auth: '待登录',
}
