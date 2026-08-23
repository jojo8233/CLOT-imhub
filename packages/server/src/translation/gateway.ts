import type { TranslationCache } from './cache.js'
import { cacheKey } from './cache.js'
import type { ProviderName, TranslationProvider } from './types.js'

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
  downgradedFrom: ProviderName[]
}

export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: ProviderName[]) {
    super(`all translation providers failed: ${attempts.join(', ')}`)
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
    const preferred = resolveProvider(req.config)
    const key = cacheKey(preferred, req.from, req.to, req.text)

    const hit = await this.cache.get(key)
    if (hit) {
      return { ...hit, provider: preferred, cached: true, downgradedFrom: [] }
    }

    const downgradedFrom: ProviderName[] = []
    const attempts = this.order(preferred)

    for (const name of attempts) {
      const provider = this.byName.get(name)!
      try {
        const out = await provider.translate(req.text, req.from, req.to)
        // 只有首选引擎的结果才写缓存。降级结果写进去的话，一次瞬时故障会被
        // 固化成永久降级——后续请求永远命中缓存，再也不会重试恢复了的首选引擎。
        if (name === preferred) await this.cache.set(key, out)
        return { ...out, provider: name, cached: false, downgradedFrom }
      } catch {
        downgradedFrom.push(name)
      }
    }

    throw new AllProvidersFailedError(attempts)
  }
}
