import { dirname } from 'node:path'

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CREDENTIAL = /^[0-9a-f]{64}$/

export interface DesktopInstallationIdentity {
  installationId: string
  credential: string
}

export type DesktopInstallationStoreResult =
  | { available: true; identity: DesktopInstallationIdentity }
  | { available: false }

export interface DesktopInstallationStoreDependencies {
  filePath: string
  exists(path: string): boolean
  mkdir(path: string): void
  read(path: string): Buffer
  write(path: string, value: Buffer): void
  randomBytes(size: number): Buffer
  randomUUID(): string
  safeStorage: {
    isEncryptionAvailable(): boolean
    encryptString(value: string): Buffer
    decryptString(value: Buffer): string
  }
  logger: Pick<Console, 'error'>
}

interface StoredIdentity {
  version: 1
  installationId: string
  credential: string
}

export class DesktopInstallationStore {
  constructor(private readonly dependencies: DesktopInstallationStoreDependencies) {}

  load(): DesktopInstallationStoreResult {
    if (!this.dependencies.safeStorage.isEncryptionAvailable()) return { available: false }
    try {
      if (this.dependencies.exists(this.dependencies.filePath)) {
        return {
          available: true,
          identity: parseStoredIdentity(this.dependencies.safeStorage.decryptString(
            this.dependencies.read(this.dependencies.filePath),
          )),
        }
      }

      const identity: DesktopInstallationIdentity = {
        installationId: this.dependencies.randomUUID(),
        credential: this.dependencies.randomBytes(32).toString('hex'),
      }
      assertIdentity(identity)
      const stored: StoredIdentity = { version: 1, ...identity }
      const encrypted = this.dependencies.safeStorage.encryptString(JSON.stringify(stored))
      this.dependencies.mkdir(dirname(this.dependencies.filePath))
      this.dependencies.write(this.dependencies.filePath, encrypted)
      return { available: true, identity }
    } catch {
      // 不记录异常对象：safeStorage 或文件解析异常可能携带密文/明文片段。
      this.dependencies.logger.error('[desktop-installation] 安装身份不可用')
      return { available: false }
    }
  }
}

function parseStoredIdentity(raw: string): DesktopInstallationIdentity {
  const value: unknown = JSON.parse(raw)
  if (!record(value) || value.version !== 1) throw new Error('invalid installation identity')
  const identity = {
    installationId: value.installationId,
    credential: value.credential,
  }
  assertIdentity(identity)
  return identity
}

function assertIdentity(value: {
  installationId: unknown
  credential: unknown
}): asserts value is DesktopInstallationIdentity {
  if (typeof value.installationId !== 'string'
    || !INSTALLATION_ID.test(value.installationId)
    || typeof value.credential !== 'string'
    || !CREDENTIAL.test(value.credential)) {
    throw new Error('invalid installation identity')
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
