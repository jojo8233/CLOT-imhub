import { isIP } from 'node:net'
import { z } from 'zod'
import { parseTelegramTdlibShadowAccountIds } from './shadow/rollout.js'

function parseTrustedProxyCidrs(value: string, ctx: z.RefinementCtx): string[] {
  if (value.trim() === '') return []
  const entries = value.split(',').map(entry => entry.trim())
  const valid = entries.every((entry) => {
    const [address, prefix, extra] = entry.split('/')
    const version = address ? isIP(address) : 0
    if (extra !== undefined || version === 0 || !prefix || !/^\d+$/.test(prefix)) return false
    const bits = Number(prefix)
    return bits >= 0 && bits <= (version === 4 ? 32 : 128)
  })
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'TRUSTED_PROXY_CIDRS 必须是逗号分隔的 IPv4/IPv6 CIDR',
    })
    return z.NEVER
  }
  return [...new Set(entries)]
}

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_ORIGIN: z.string().default(''),
  TRUSTED_PROXY_CIDRS: z.string().default('')
    .transform((value, ctx) => parseTrustedProxyCidrs(value, ctx)),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string()
    .min(32, 'JWT_SECRET 至少 32 字符，用 `openssl rand -base64 32` 生成')
    .refine((v) => v !== 'change-me-in-production', {
      message: 'JWT_SECRET 仍是 .env.example 里的占位值，必须换成随机密钥：openssl rand -base64 32',
    }),
  DEEPL_API_KEY: z.string().default(''),
  DEEPL_ENDPOINT: z.string().url().default('https://api-free.deepl.com/v2/translate'),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  DEFAULT_TRANSLATION_PROVIDER: z.enum(['deepl', 'openai', 'claude']).default('deepl'),
  TDLIB_DATA_DIR: z.string().default('./data/tdlib'),
  /**
   * signal-cli 可执行文件。装在别处（或用容器里的那份）时覆盖它。
   * 当前仅保留为后台归档/回退链路；用户可见的 M5 入口由 Signal Desktop 托管。
   */
  SIGNAL_CLI_BINARY: z.string().default('signal-cli'),
  /** signal-cli 的数据目录。跟 TDLib session 放一起，备份和重置才好统一处理 */
  SIGNAL_DATA_DIR: z.string().default('./data/signal'),
  TELEGRAM_API_ID: z.coerce.number().default(0),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS: z.string().default('')
    .transform((value, ctx) => {
      try {
        return parseTelegramTdlibShadowAccountIds(value)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TELEGRAM_TDLIB_SHADOW_ACCOUNT_IDS 必须是逗号分隔的账号 UUID',
        })
        return z.NEVER
      }
    }),
  WHATSAPP_CLOUD_ENABLED: z.enum(['true', 'false']).default('false')
    .transform(value => value === 'true'),
  /** Meta 官方 collection 使用显式 Version 变量；部署时固定版本，禁止 latest 漂移。 */
  WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  WHATSAPP_META_APP_ID: z.string().default(''),
  WHATSAPP_META_CONFIG_ID: z.string().default(''),
  WHATSAPP_META_APP_SECRET: z.string().default(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  /** 对外可访问的 HTTPS origin，用于 Meta Webhook 与 Embedded Signup 页面。 */
  WHATSAPP_PUBLIC_BASE_URL: z.string().default(''),
  /** 32 字节 base64，只用于服务端 AES-256-GCM secret store。 */
  WHATSAPP_SECRET_MASTER_KEY: z.string().default(''),
  ORGANIZATION_ADMIN_WRITES_ENABLED: z.enum(['true', 'false']).default('false')
    .transform(value => value === 'true'),
  PORT: z.coerce.number().default(4000),
}).superRefine((value, ctx) => {
  if (value.APP_ENV === 'production') {
    try {
      const publicOrigin = new URL(value.PUBLIC_ORIGIN)
      if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== value.PUBLIC_ORIGIN) {
        throw new Error('unsafe production origin')
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_ORIGIN'],
        message: 'PUBLIC_ORIGIN 在生产环境必须是精确 HTTPS origin，不含路径、凭据、查询或 fragment',
      })
    }

    if (value.TRUSTED_PROXY_CIDRS.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_CIDRS'],
        message: 'TRUSTED_PROXY_CIDRS 在生产环境必须只包含直接 Caddy 代理的 CIDR',
      })
    }

    const databaseUrl = new URL(value.DATABASE_URL)
    if (databaseUrl.password === 'imhub_dev' || databaseUrl.pathname.endsWith('_test')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL 在生产环境不能使用开发口令或测试数据库',
      })
    }

    if (value.WHATSAPP_CLOUD_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHATSAPP_CLOUD_ENABLED'],
        message: 'WHATSAPP_CLOUD_ENABLED 在内部 WhatsApp Web 生产版本中必须关闭',
      })
    }
  }

  if (value.WHATSAPP_CLOUD_ENABLED) {
    for (const field of [
      'WHATSAPP_META_APP_ID',
      'WHATSAPP_META_CONFIG_ID',
      'WHATSAPP_META_APP_SECRET',
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
      'WHATSAPP_PUBLIC_BASE_URL',
      'WHATSAPP_SECRET_MASTER_KEY',
    ] as const) {
      if (value[field] === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} 未配置` })
      }
    }
    if (value.WHATSAPP_SECRET_MASTER_KEY !== '') {
      const decoded = Buffer.from(value.WHATSAPP_SECRET_MASTER_KEY, 'base64')
      if (decoded.length !== 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_SECRET_MASTER_KEY'],
          message: 'WHATSAPP_SECRET_MASTER_KEY 必须是 32 字节 base64',
        })
      }
    }
    if (value.WHATSAPP_PUBLIC_BASE_URL !== '') {
      try {
        const url = new URL(value.WHATSAPP_PUBLIC_BASE_URL)
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
          throw new Error('invalid public URL')
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_PUBLIC_BASE_URL'],
          message: 'WHATSAPP_PUBLIC_BASE_URL 必须是无凭据/查询/fragment 的 HTTPS URL',
        })
      }
    }
  }
})

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return schema.parse(env)
}

export const config = parseConfig(process.env)
export type Config = z.infer<typeof schema>
