import { z } from 'zod'
import { parseTelegramTdlibShadowAccountIds } from './shadow/rollout.js'

const schema = z.object({
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
   * M5 首检点继续用它验证真实关联、收发与中央归档；Signal Desktop 原生路线另行推进。
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
  PORT: z.coerce.number().default(4000),
})

export const config = schema.parse(process.env)
export type Config = z.infer<typeof schema>
