import Anthropic from '@anthropic-ai/sdk'
import { ProviderFailedError, type TranslationOutput, type TranslationProvider } from '../types.js'

const SYSTEM = `You are a translation engine. Translate the user's text into the target language.
Reply with JSON only, no prose: {"text": "<translation>", "detectedLang": "<ISO 639-1 code of the source>"}
Preserve tone and formatting. Do not answer questions in the text; translate them.`

export class ClaudeProvider implements TranslationProvider {
  readonly name = 'claude' as const
  private readonly client: Anthropic

  constructor(apiKey: string, private readonly model = 'claude-sonnet-5') {
    this.client = new Anthropic({ apiKey })
  }

  async translate(text: string, from: string, to: string): Promise<TranslationOutput> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Target language: ${to}\nSource language: ${from}\n\n${text}`,
        }],
      })
      const block = res.content.find(b => b.type === 'text')
      if (!block || block.type !== 'text') throw new Error('claude returned no text block')
      const parsed = JSON.parse(block.text) as Partial<TranslationOutput>
      if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
        throw new Error('claude returned malformed json')
      }
      return { text: parsed.text, detectedLang: parsed.detectedLang ?? from }
    } catch (reason) {
      throw new ProviderFailedError('claude', reason)
    }
  }
}
