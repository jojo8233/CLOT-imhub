import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCustomerProfileQueryDebouncer,
  prepareCustomerProfileReplacement,
  type CustomerProfileDebouncedQuery,
} from './customer-profile-library-controller.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('customer profile library controller', () => {
  it('publishes a new generation when input returns to the previous query during debounce', () => {
    vi.useFakeTimers()
    const published: CustomerProfileDebouncedQuery[] = []
    const debouncer = createCustomerProfileQueryDebouncer(
      value => published.push(value),
      {
        set: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      7,
    )

    debouncer.schedule('abcd')
    vi.advanceTimersByTime(100)
    debouncer.schedule('abc')
    vi.advanceTimersByTime(299)
    expect(published).toEqual([])

    vi.advanceTimersByTime(1)
    expect(published).toEqual([{ query: 'abc', generation: 8 }])
  })

  it('clears results only for filter changes, not same-filter refreshes', () => {
    const events: string[] = []
    const cancelActive = () => events.push('cancel')
    const resetVisibleResults = () => events.push('reset')

    prepareCustomerProfileReplacement('same-filter', cancelActive, resetVisibleResults)
    expect(events).toEqual(['cancel'])

    events.length = 0
    prepareCustomerProfileReplacement('filters', cancelActive, resetVisibleResults)
    expect(events).toEqual(['cancel', 'reset'])
  })
})
