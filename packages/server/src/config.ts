import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string()
    .min(32, 'JWT_SECRET 至少 32 字符，用 `openssl rand -base64 32` 生成')
    .refine((v) => v !== 'change-me-in-production', {
      message: 'JWT_SECRET 仍是 .env.example 里的占位值，必须换成随机密钥：openssl rand -base64 32',
    }),
  DEEPL_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  DEFAULT_TRANSLATION_PROVIDER: z.enum(['deepl', 'openai', 'claude']).default('deepl'),
  TDLIB_DATA_DIR: z.string().default('./data/tdlib'),
  TELEGRAM_API_ID: z.coerce.number().default(0),
  TELEGRAM_API_HASH: z.string().default(''),
  PORT: z.coerce.number().default(4000),
})

export const config = schema.parse(process.env)
export type Config = z.infer<typeof schema>
