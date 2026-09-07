import type { TranslationProvider } from '../types.js'
import { ClaudeProvider } from './claude.js'
import { DeeplProvider } from './deepl.js'
import { OpenAiProvider } from './openai.js'

export interface TranslationProviderConfig {
  DEEPL_API_KEY: string
  DEEPL_ENDPOINT: string
  OPENAI_API_KEY: string
  ANTHROPIC_API_KEY: string
}

export function createConfiguredTranslationProviders(
  config: TranslationProviderConfig,
): TranslationProvider[] {
  const providers: TranslationProvider[] = []
  const deeplKey = config.DEEPL_API_KEY.trim()
  const claudeKey = config.ANTHROPIC_API_KEY.trim()
  const openaiKey = config.OPENAI_API_KEY.trim()

  if (deeplKey) providers.push(new DeeplProvider(deeplKey, config.DEEPL_ENDPOINT))
  if (claudeKey) providers.push(new ClaudeProvider(claudeKey))
  if (openaiKey) providers.push(new OpenAiProvider(openaiKey))
  return providers
}
