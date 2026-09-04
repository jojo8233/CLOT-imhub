import { describe, expect, it } from 'vitest'
import { AdminOperationTokenService } from './operation-token.js'

const secret = 'admin-operation-token-test-secret-32-characters'
const issuedAt = new Date('2026-09-05T00:00:00.000Z')

describe('AdminOperationTokenService', () => {
  it('签发五分钟有效并绑定操作、owner、输入和 revisions 的 token', async () => {
    const service = new AdminOperationTokenService(secret, () => new Date(issuedAt))
    const result = await service.issue({
      kind: 'archive_team',
      ownerUserId: 'owner-1',
      input: { teamId: 'team-1', resolution: { action: 'archive' } },
      revisions: { users: { 'owner-1': 3 }, teams: { 'team-1': 7 }, accounts: {} },
    })

    expect(result.expiresAt).toBe('2026-09-05T00:05:00.000Z')
    expect(await service.verify(result.operationToken, {
      kind: 'archive_team',
      ownerUserId: 'owner-1',
    })).toEqual({
      input: { teamId: 'team-1', resolution: { action: 'archive' } },
      revisions: { users: { 'owner-1': 3 }, teams: { 'team-1': 7 }, accounts: {} },
    })
  })

  it('拒绝跨操作或跨 owner 复用', async () => {
    const service = new AdminOperationTokenService(secret, () => new Date(issuedAt))
    const issued = await service.issue({
      kind: 'assign_account',
      ownerUserId: 'owner-1',
      input: { accountId: 'account-1' },
      revisions: { users: {}, teams: {}, accounts: { 'account-1': 1 } },
    })

    await expect(service.verify(issued.operationToken, {
      kind: 'archive_team', ownerUserId: 'owner-1',
    })).rejects.toThrow()
    await expect(service.verify(issued.operationToken, {
      kind: 'assign_account', ownerUserId: 'owner-2',
    })).rejects.toThrow()
  })

  it('五分钟后拒绝 token', async () => {
    let now = new Date(issuedAt)
    const service = new AdminOperationTokenService(secret, () => new Date(now))
    const issued = await service.issue({
      kind: 'disable_user',
      ownerUserId: 'owner-1',
      input: { userId: 'user-1' },
      revisions: { users: { 'user-1': 1 }, teams: {}, accounts: {} },
    })
    now = new Date('2026-09-05T00:05:01.000Z')

    await expect(service.verify(issued.operationToken, {
      kind: 'disable_user', ownerUserId: 'owner-1',
    })).rejects.toThrow()
  })
})
