import { describe, expect, it, vi } from 'vitest'

import {
  DesktopInstallationStore,
  type DesktopInstallationStoreDependencies,
} from './desktop-installation-store.js'

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555'

function fixture(options: { encryptionAvailable?: boolean } = {}) {
  const files = new Map<string, Buffer>()
  const credentialBytes = Buffer.from('credential-sentinel'.padEnd(32, '!'))
  const logger = { error: vi.fn() }
  const dependencies: DesktopInstallationStoreDependencies = {
    filePath: '/synthetic/im-hub/installation.bin',
    exists: path => files.has(path),
    mkdir: vi.fn(),
    read: path => {
      const value = files.get(path)
      if (!value) throw new Error('missing')
      return Buffer.from(value)
    },
    write: (path, value) => { files.set(path, Buffer.from(value)) },
    randomBytes: size => {
      expect(size).toBe(32)
      return credentialBytes
    },
    randomUUID: () => INSTALLATION_ID,
    safeStorage: {
      isEncryptionAvailable: () => options.encryptionAvailable !== false,
      encryptString: value => Buffer.from(Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5)),
      decryptString: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)).toString('utf8'),
    },
    logger,
  }
  return { files, credentialBytes, logger, store: new DesktopInstallationStore(dependencies) }
}

describe('DesktopInstallationStore', () => {
  it('首次加载创建 32 字节凭证并只把密文写入磁盘，之后恢复同一身份', () => {
    const { credentialBytes, files, store } = fixture()

    const first = store.load()
    expect(first).toEqual({
      available: true,
      identity: {
        installationId: INSTALLATION_ID,
        credential: credentialBytes.toString('hex'),
      },
    })
    const disk = files.get('/synthetic/im-hub/installation.bin')
    expect(disk).toBeDefined()
    expect(disk?.includes(credentialBytes)).toBe(false)
    expect(disk?.toString('utf8')).not.toContain(credentialBytes.toString('hex'))

    expect(store.load()).toEqual(first)
  })

  it('系统加密不可用时失败关闭且不创建明文文件', () => {
    const { files, store } = fixture({ encryptionAvailable: false })

    expect(store.load()).toEqual({ available: false })
    expect(files.size).toBe(0)
  })

  it('文件损坏时失败关闭且日志不包含密文', () => {
    const { files, logger, store } = fixture()
    const ciphertext = Buffer.from('corrupt-ciphertext-sentinel')
    files.set('/synthetic/im-hub/installation.bin', ciphertext)

    expect(store.load()).toEqual({ available: false })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(ciphertext.toString('utf8'))
  })
})
