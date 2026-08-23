import type { TranslationCache } from './cache.js'
import { cacheKey } from './cache.js'
import { ProviderFailedError, type ProviderName, type TranslationProvider } from './types.js'

/** 四级引擎配置。优先级：会话 > 账号 > 团队 > 全局默认。 */
export interface EngineConfig {
  conversation?: ProviderName
  account?: ProviderName
  team?: ProviderName
  global: ProviderName
}

export function resolveProvider(cfg: EngineConfig): ProviderName {
  return cfg.conversation ?? cfg.account ?? cfg.team ?? cfg.global
}

export interface TranslateRequest {
  text: string
  from: string
  to: string
  config: EngineConfig
}

export interface TranslationResult {
  text: string
  detectedLang: string
  provider: ProviderName
  cached: boolean
  // 本次请求确实没有发生降级，但这不代表 provider 现在健康——命中缓存时这条数据
  // 可能是几十天前写入的。不要拿它当健康看板信号。
  downgradedFrom: ProviderName[]
}

export class AllProvidersFailedError extends Error {
  constructor(readonly failures: { provider: ProviderName; error: unknown }[]) {
    super(
      'all translation providers failed: ' +
        failures
          .map((f) => `${f.provider} (${f.error instanceof Error ? f.error.message : String(f.error)})`)
          .join('; '),
    )
  }
}

export class EmptyInputError extends Error {
  constructor() {
    super('nothing to translate: input is empty or whitespace-only')
  }
}

export class TranslationGateway {
  private readonly byName: Map<ProviderName, TranslationProvider>

  constructor(
    providers: TranslationProvider[],
    private readonly cache: TranslationCache,
    private readonly fallbackOrder: ProviderName[],
  ) {
    this.byName = new Map(providers.map(p => [p.name, p]))
  }

  /** 首选引擎排最前，其余按 fallbackOrder 兜底，且只保留已注册的引擎。 */
  private order(preferred: ProviderName): ProviderName[] {
    const rest = this.fallbackOrder.filter(n => n !== preferred)
    return [preferred, ...rest].filter(n => this.byName.has(n))
  }

  async translate(req: TranslateRequest): Promise<TranslationResult> {
    if (req.text.trim() === '') throw new EmptyInputError()

    const preferred = resolveProvider(req.config)
    const key = cacheKey(preferred, req.from, req.to, req.text)

    const hit = await this.cache.get(key)
    if (hit) {
      return { ...hit, provider: preferred, cached: true, downgradedFrom: [] }
    }

    if (!this.byName.has(preferred)) {
      console.error(`[translation-gateway] 配置的首选引擎 ${preferred} 未注册，本次请求将直接走降级链`)
    }

    const downgradedFrom: ProviderName[] = []
    const failures: { provider: ProviderName; error: unknown }[] = []
    const attempts = this.order(preferred)

    for (const name of attempts) {
      const provider = this.byName.get(name)!
      try {
        const out = await provider.translate(req.text, req.from, req.to)
        // 只有首选引擎的结果才写缓存。降级结果写进去的话，一次瞬时故障会被
        // 固化成永久降级——后续请求永远命中缓存，再也不会重试恢复了的首选引擎。
        if (name === preferred) await this.cache.set(key, out)
        return { ...out, provider: name, cached: false, downgradedFrom }
      } catch (err) {
        downgradedFrom.push(name)
        failures.push({ provider: name, error: err })
        if (err instanceof ProviderFailedError) {
          const level = name === preferred ? console.error : console.warn
          level(
            `[translation-gateway] ${name} 翻译失败${name === preferred ? '（这是首选引擎，检查它的 API key 与配额）' : '，降级到下一个'}:`,
            err.message,
          )
        } else {
          // 非 ProviderFailedError = provider 自身有 bug。继续降级仍是对的运行时行为，
          // 但必须喊出来，否则一个坏掉的 provider 会被永久当成"引擎故障"静默跳过。
          console.error(`[translation-gateway] ${name} 抛出了非 ProviderFailedError，这是 provider 的 bug:`, err)
        }
      }
    }

    throw new AllProvidersFailedError(failures)
  }
}
