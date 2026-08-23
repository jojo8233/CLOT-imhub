import OpenAI from 'openai'
import { ProviderFailedError, type TranslationOutput, type TranslationProvider } from '../types.js'

const SYSTEM = `You are a translation engine. Translate the user's text into the target language.
Reply with JSON only: {"text": "<translation>", "detectedLang": "<ISO 639-1 code of the source>"}
Preserve tone and formatting. Do not answer questions in the text; translate them.`

export class OpenAiProvider implements TranslationProvider {
  readonly name = 'openai' as const
  private readonly client: OpenAI

  constructor(apiKey: string, private readonly model = 'gpt-4o-mini') {
    this.client = new OpenAI({ apiKey })
  }

  async translate(text: string, from: string, to: string): Promise<TranslationOutput> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Target language: ${to}\nSource language: ${from}\n\n${text}` },
        ],
      })
      const content = res.choices[0]?.message.content
      if (!content) throw new Error('openai returned no content')
      const parsed = JSON.parse(content) as Partial<TranslationOutput>
      if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
        throw new Error('openai returned malformed json')
      }
      return { text: parsed.text, detectedLang: parsed.detectedLang ?? from }
    } catch (reason) {
      throw new ProviderFailedError('openai', reason)
    }
  }
}
