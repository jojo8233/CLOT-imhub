import { describe, expect, it } from 'vitest'
import { MIN, clampWidths, defaultWidths, visiblePanels } from './layout.js'

/** 三栏刚好都能按最小宽度放下的可用宽度 */
const TIGHT = MIN.list + MIN.chat + MIN.customer
const ROOMY = 1200

describe('clampWidths', () => {
  it('空间充足时原样保留', () => {
    expect(clampWidths({ list: 300, customer: 320 }, ROOMY)).toEqual({ list: 300, customer: 320 })
  })

  it('低于最小宽度的入参被抬到最小值', () => {
    expect(clampWidths({ list: 10, customer: 10 }, ROOMY)).toEqual({
      list: MIN.list, customer: MIN.customer,
    })
  })

  it('聊天区优先：空间不够时先压客户资料', () => {
    // 会话列表要 400，聊天区至少 480，客户资料只剩 320
    const r = clampWidths({ list: 400, customer: 600 }, 1200)
    expect(r.list).toBe(400)
    expect(r.customer).toBe(320)
    expect(1200 - r.list - r.customer).toBe(MIN.chat)
  })

  it('客户资料压到底还不够，才轮到会话列表', () => {
    const r = clampWidths({ list: 600, customer: 600 }, TIGHT)
    expect(r).toEqual({ list: MIN.list, customer: MIN.customer })
  })

  it('可用空间小于三栏最小值之和时不再硬压聊天区，交给调用方折叠', () => {
    // 硬压的话聊天区会变成负宽度；这里两栏都停在最小值，由 visiblePanels 决定收哪栏
    const r = clampWidths({ list: 300, customer: 300 }, 600)
    expect(r).toEqual({ list: MIN.list, customer: MIN.customer })
  })

  it('宽度取整，避免拖拽时产生小数像素导致的抖动', () => {
    const r = clampWidths({ list: 300.4, customer: 320.6 }, ROOMY)
    expect(Number.isInteger(r.list)).toBe(true)
    expect(Number.isInteger(r.customer)).toBe(true)
  })
})

describe('defaultWidths', () => {
  it('宽屏下按比例分配，且聊天区拿到最大的一份', () => {
    const r = defaultWidths(1600)
    expect(1600 - r.list - r.customer).toBeGreaterThan(Math.max(r.list, r.customer))
  })

  it('窄屏下退回最小宽度而不是给出放不下的比例值', () => {
    const r = defaultWidths(TIGHT)
    expect(r).toEqual({ list: MIN.list, customer: MIN.customer })
  })
})

describe('visiblePanels', () => {
  it('刚好放得下三栏时都显示', () => {
    expect(visiblePanels(TIGHT)).toEqual({ list: true, customer: true })
  })

  it('差一像素就先收客户资料，会话列表还在', () => {
    expect(visiblePanels(TIGHT - 1)).toEqual({ list: true, customer: false })
  })

  it('连会话列表都放不下时两栏全收', () => {
    expect(visiblePanels(MIN.list + MIN.chat - 1)).toEqual({ list: false, customer: false })
  })
})
