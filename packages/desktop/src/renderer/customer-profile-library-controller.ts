export const CUSTOMER_PROFILE_SEARCH_DEBOUNCE_MS = 300

export interface CustomerProfileDebouncedQuery {
  query: string
  generation: number
}

export interface CustomerProfileQueryDebounceClock {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface CustomerProfileQueryDebouncer {
  schedule(rawQuery: string): void
  cancel(): void
}

export function createCustomerProfileQueryDebouncer(
  publish: (value: CustomerProfileDebouncedQuery) => void,
  clock?: CustomerProfileQueryDebounceClock,
  initialGeneration = 0,
): CustomerProfileQueryDebouncer {
  const activeClock = clock ?? {
    set: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
    clear: (handle: unknown) => window.clearTimeout(handle as number),
  }
  let timer: unknown | null = null
  let generation = initialGeneration

  const cancel = () => {
    if (timer === null) return
    activeClock.clear(timer)
    timer = null
  }

  return {
    schedule(rawQuery) {
      cancel()
      const query = rawQuery.trim()
      timer = activeClock.set(() => {
        timer = null
        generation += 1
        publish({ query, generation })
      }, CUSTOMER_PROFILE_SEARCH_DEBOUNCE_MS)
    },
    cancel,
  }
}

export type CustomerProfileReplacementReason = 'filters' | 'same-filter'

export function prepareCustomerProfileReplacement(
  reason: CustomerProfileReplacementReason,
  cancelActive: () => void,
  resetVisibleResults: () => void,
): void {
  cancelActive()
  if (reason === 'filters') resetVisibleResults()
}
