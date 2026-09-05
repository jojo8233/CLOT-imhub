import { describe, expect, it, vi } from 'vitest'
import { loadActor } from './actor.js'

describe('loadActor', () => {
  it('manager 的 leadTeamIds 只含 is_lead 为 true 的组', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u1', role: 'manager', disabled_at: null, session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([
        { team_id: 't1', is_lead: true },
        { team_id: 't2', is_lead: false },
        { team_id: 't3', is_lead: true },
      ]),
    }
    expect((await loadActor('u1', 1, repo as never)).leadTeamIds).toEqual(['t1', 't3'])
  })

  it('agent 的 leadTeamIds 恒为空，即便库里错标了 is_lead', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u2', role: 'agent', disabled_at: null, session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([{ team_id: 't1', is_lead: true }]),
    }
    expect((await loadActor('u2', 1, repo as never)).leadTeamIds).toEqual([])
  })

  it('owner 不因组关系获得 leadTeamIds，可见范围由角色单独决定', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u4', role: 'owner', disabled_at: null, session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([{ team_id: 't1', is_lead: true }]),
    }
    expect((await loadActor('u4', 1, repo as never)).leadTeamIds).toEqual([])
  })

  it('auditor 同样不获得 leadTeamIds', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u5', role: 'auditor', disabled_at: null, session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([{ team_id: 't1', is_lead: true }]),
    }
    expect((await loadActor('u5', 1, repo as never)).leadTeamIds).toEqual([])
  })

  it('角色取自数据库而不是调用方传入', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u1', role: 'agent', disabled_at: null, session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([]),
    }
    const actor = await loadActor('u1', 1, repo as never)
    expect(actor.role).toBe('agent')
    expect(repo.findUser).toHaveBeenCalledWith('u1')
  })

  it('用户不存在时抛错', async () => {
    const repo = { findUser: vi.fn().mockResolvedValue(null), findMemberships: vi.fn() }
    await expect(loadActor('nope', 1, repo as never)).rejects.toThrow('invalid session actor')
  })

  it('已停用的用户抛错', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u3', role: 'agent', disabled_at: new Date(), session_version: 1,
      }),
      findMemberships: vi.fn().mockResolvedValue([]),
    }
    await expect(loadActor('u3', 1, repo as never)).rejects.toThrow('invalid session actor')
  })

  it('停用用户不再去查组关系', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u3', role: 'manager', disabled_at: new Date(), session_version: 1,
      }),
      findMemberships: vi.fn(),
    }
    await expect(loadActor('u3', 1, repo as never)).rejects.toThrow()
    expect(repo.findMemberships).not.toHaveBeenCalled()
  })

  it('数据库 session version 已变化时立即拒绝旧会话', async () => {
    const repo = {
      findUser: vi.fn().mockResolvedValue({
        id: 'u6', role: 'manager', disabled_at: null, session_version: 2,
      }),
      findMemberships: vi.fn(),
    }

    await expect(loadActor('u6', 1, repo as never)).rejects.toThrow('invalid session actor')
    expect(repo.findMemberships).not.toHaveBeenCalled()
  })
})
