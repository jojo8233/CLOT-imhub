import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_PROFILE_FIELDS,
  CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT,
  CUSTOMER_PROFILE_SEARCH_MAX_LIMIT,
  customerProfileCodePointLength,
  emptyCustomerProfile,
  normalizeCustomerProfileText,
  type CustomerProfileListPage,
  type CustomerProfileSearchRequest,
} from './customer-profile.js'

describe('customer profile contract', () => {
  it('固定人工字段顺序，供存储和 UI 共用', () => {
    expect(CUSTOMER_PROFILE_FIELDS).toEqual([
      'name',
      'ageLocation',
      'occupation',
      'family',
      'interests',
      'other',
    ])
  })

  it('只 trim 两端并把纯空白规范成 null', () => {
    expect(normalizeCustomerProfileText('  Alice  ')).toBe('Alice')
    expect(normalizeCustomerProfileText('  likes  tea  ')).toBe('likes  tea')
    expect(normalizeCustomerProfileText(' \n ')).toBeNull()
    expect(normalizeCustomerProfileText(null)).toBeNull()
  })

  it('用 Unicode code point 计数而不是 UTF-16 code unit', () => {
    expect('😀'.length).toBe(2)
    expect(customerProfileCodePointLength('😀')).toBe(1)
  })

  it('未建档案返回 revision 0 的全空快照', () => {
    expect(emptyCustomerProfile('conversation-1')).toEqual({
      conversationId: 'conversation-1',
      name: null,
      ageLocation: null,
      occupation: null,
      family: null,
      interests: null,
      other: null,
      revision: 0,
      updatedAt: null,
    })
  })

  it('为跨端档案库请求提供受限分页契约', () => {
    const request: CustomerProfileSearchRequest = {
      q: 'Synthetic query',
      platform: 'telegram',
      accountId: '00000000-0000-4000-8000-000000000001',
      limit: CUSTOMER_PROFILE_SEARCH_DEFAULT_LIMIT,
    }
    const page: CustomerProfileListPage = {
      items: [],
      nextCursor: null,
    }

    expect(request.limit).toBe(50)
    expect(CUSTOMER_PROFILE_SEARCH_MAX_LIMIT).toBe(100)
    expect(page).toEqual({ items: [], nextCursor: null })
  })
})
