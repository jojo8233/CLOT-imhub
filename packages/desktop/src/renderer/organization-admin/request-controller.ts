import type { AdminPage } from '@im-hub/shared'

export type PageLoader<T, F> = (filters: F, signal: AbortSignal) => Promise<AdminPage<T>>

export interface RequestSnapshot<T, F> {
  ownerIdentity: string
  filters: F | null
  items: T[]
  nextCursor: string | null
  loading: boolean
  error: unknown
}

export class RequestController<T, F extends { cursor?: string }> {
  private generation = 0
  private abortController: AbortController | null = null
  private loader: PageLoader<T, F> | null = null
  private state: RequestSnapshot<T, F>

  constructor(ownerIdentity: string, loader?: PageLoader<T, F>) {
    this.loader = loader ?? null
    this.state = {
      ownerIdentity,
      filters: null,
      items: [],
      nextCursor: null,
      loading: false,
      error: null,
    }
  }

  snapshot(): RequestSnapshot<T, F> {
    return { ...this.state, items: [...this.state.items] }
  }

  setOwnerIdentity(ownerIdentity: string): void {
    if (ownerIdentity === this.state.ownerIdentity) return
    this.cancel()
    this.state = {
      ownerIdentity,
      filters: null,
      items: [],
      nextCursor: null,
      loading: false,
      error: null,
    }
  }

  async load(filters: F, loader?: PageLoader<T, F>): Promise<void> {
    if (loader) this.loader = loader
    const activeLoader = this.requireLoader()
    this.abortController?.abort()
    const abortController = new AbortController()
    this.abortController = abortController
    const generation = ++this.generation
    const normalized = { ...filters }
    delete normalized.cursor
    this.state = {
      ...this.state,
      filters: normalized,
      items: [],
      nextCursor: null,
      loading: true,
      error: null,
    }
    try {
      const page = await activeLoader(normalized, abortController.signal)
      if (generation !== this.generation || abortController.signal.aborted) return
      this.state = {
        ...this.state,
        items: page.items,
        nextCursor: page.nextCursor,
        loading: false,
      }
    } catch (error) {
      if (generation !== this.generation || abortController.signal.aborted) return
      this.state = { ...this.state, loading: false, error }
      throw error
    }
  }

  async loadMore(): Promise<void> {
    if (!this.state.filters || !this.state.nextCursor || this.state.loading) return
    const loader = this.requireLoader()
    const abortController = new AbortController()
    this.abortController = abortController
    const generation = ++this.generation
    const filters = { ...this.state.filters, cursor: this.state.nextCursor }
    this.state = { ...this.state, loading: true, error: null }
    try {
      const page = await loader(filters, abortController.signal)
      if (generation !== this.generation || abortController.signal.aborted) return
      const existing = new Set(this.state.items.map(itemId).filter(value => value !== null))
      this.state = {
        ...this.state,
        items: [
          ...this.state.items,
          ...page.items.filter(item => {
            const id = itemId(item)
            return id === null || !existing.has(id)
          }),
        ],
        nextCursor: page.nextCursor,
        loading: false,
      }
    } catch (error) {
      if (generation !== this.generation || abortController.signal.aborted) return
      this.state = { ...this.state, loading: false, error }
      throw error
    }
  }

  async reload(): Promise<void> {
    if (!this.state.filters) return
    await this.load(this.state.filters)
  }

  replace(item: T): void {
    const id = itemId(item)
    if (!id) return
    this.state = {
      ...this.state,
      items: this.state.items.map(current => itemId(current) === id ? item : current),
    }
  }

  cancel(): void {
    this.generation += 1
    this.abortController?.abort()
    this.abortController = null
    this.state = { ...this.state, loading: false }
  }

  private requireLoader(): PageLoader<T, F> {
    if (!this.loader) throw new Error('管理列表加载器未配置')
    return this.loader
  }
}

function itemId(value: unknown): string | null {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    ? value.id
    : null
}
