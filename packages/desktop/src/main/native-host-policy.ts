const NATIVE_WEB_CLIENTS = new Map([
  ['http://localhost:1234', { bridgeEnabled: true }],
  ['https://web.whatsapp.com', { bridgeEnabled: false }],
])
const NATIVE_PARTITION = /^persist:native-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function nativeClientUrlAllowed(raw: string): boolean {
  try {
    return NATIVE_WEB_CLIENTS.has(new URL(raw).origin)
  } catch {
    return false
  }
}

export function nativeClientBridgeAllowed(raw: string): boolean {
  try {
    return NATIVE_WEB_CLIENTS.get(new URL(raw).origin)?.bridgeEnabled === true
  } catch {
    return false
  }
}

export function nativePartitionAllowed(partition: string): boolean {
  return NATIVE_PARTITION.test(partition)
}

export function nativeAccountIdFromPartition(partition: string): string | null {
  if (!nativePartitionAllowed(partition)) return null
  return partition.slice('persist:native-'.length).toLowerCase()
}
