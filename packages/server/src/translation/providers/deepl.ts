import { ProviderFailedError, type TranslationOutput, type TranslationProvider } from '../types.js'

const ENDPOINT = 'https://api-free.deepl.com/v2/translate'

interface DeeplResponse {
  translations: { detected_source_language: string; text: string }[]
}

export class DeeplProvider implements TranslationProvider {
  readonly name = 'deepl' as const

  constructor(private readonly apiKey: string, private readonly endpoint = ENDPOINT) {}

  async translate(text: string, from: string, to: string): Promise<TranslationOutput> {
    const params = new URLSearchParams({ text, target_lang: to.toUpperCase() })
    if (from !== 'auto') params.set('source_lang', from.toUpperCase())

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`deepl http ${res.status}`)
      const json = (await res.json()) as DeeplResponse
      const first = json.translations[0]
      if (!first || first.text.trim().length === 0) throw new Error('deepl returned no translations')
      return { text: first.text, detectedLang: first.detected_source_language }
    } catch (reason) {
      throw new ProviderFailedError('deepl', reason)
    }
  }
}
