import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
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
