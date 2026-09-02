export const CUSTOMER_PROFILE_FIELDS = [
  'name',
  'ageLocation',
  'occupation',
  'family',
  'interests',
  'other',
] as const

export type CustomerProfileField = typeof CUSTOMER_PROFILE_FIELDS[number]

export const CUSTOMER_PROFILE_MAX_CODE_POINTS = {
  name: 200,
  ageLocation: 2_000,
  occupation: 2_000,
  family: 2_000,
  interests: 2_000,
  other: 2_000,
} satisfies Record<CustomerProfileField, number>

export interface CustomerProfileValues {
  name: string | null
  ageLocation: string | null
  occupation: string | null
  family: string | null
  interests: string | null
  other: string | null
}

export interface CustomerProfile extends CustomerProfileValues {
  conversationId: string
  revision: number
  updatedAt: string | null
}

export interface CustomerProfileUpdate extends CustomerProfileValues {
  expectedRevision: number
}

export function normalizeCustomerProfileText(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

export function customerProfileCodePointLength(value: string): number {
  return Array.from(value).length
}

export function emptyCustomerProfile(conversationId: string): CustomerProfile {
  return {
    conversationId,
    name: null,
    ageLocation: null,
    occupation: null,
    family: null,
    interests: null,
    other: null,
    revision: 0,
    updatedAt: null,
  }
}
