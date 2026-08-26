const NATIVE_WEB_CLIENT_ORIGINS = new Set(['http://localhost:1234'])
const NATIVE_PARTITION = /^persist:native-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function nativeClientUrlAllowed(raw: string): boolean {
  try {
    return NATIVE_WEB_CLIENT_ORIGINS.has(new URL(raw).origin)
  } catch {
    return false
  }
}

export function nativePartitionAllowed(partition: string): boolean {
  return NATIVE_PARTITION.test(partition)
}
