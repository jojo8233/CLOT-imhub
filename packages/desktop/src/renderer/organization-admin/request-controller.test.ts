import { describe, expect, it } from 'vitest'

import { RequestController } from './request-controller.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('RequestController', () => {
  it('筛选变化后拒绝迟到的旧搜索结果', async () => {
    const first = deferred<{ items: string[]; nextCursor: string | null }>()
    const second = deferred<{ items: string[]; nextCursor: string | null }>()
    const controller = new RequestController<string, { q: string; cursor?: string }>('owner-1')

    const oldLoad = controller.load({ q: 'old' }, () => first.promise)
    const newLoad = controller.load({ q: 'new' }, () => second.promise)
    second.resolve({ items: ['new'], nextCursor: null })
    await newLoad
    first.resolve({ items: ['old'], nextCursor: null })
    await oldLoad

    expect(controller.snapshot().items).toEqual(['new'])
  })

  it('owner 会话身份替换会取消旧请求并清空旧组织数据', async () => {
    const pending = deferred<{ items: string[]; nextCursor: string | null }>()
    const controller = new RequestController<string, { q: string; cursor?: string }>('owner-1')
    const load = controller.load({ q: 'old owner' }, () => pending.promise)

    controller.setOwnerIdentity('owner-2')
    pending.resolve({ items: ['must-not-appear'], nextCursor: null })
    await load

    expect(controller.snapshot()).toMatchObject({ ownerIdentity: 'owner-2', items: [] })
  })
})
