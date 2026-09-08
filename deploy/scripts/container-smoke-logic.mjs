export function expectedHealthStatus(healthUrl) {
  const pathname = new URL(healthUrl).pathname
  if (pathname.endsWith('/health/ready')) return 'ready'
  if (pathname.endsWith('/health/live')) return 'live'
  throw new Error('health URL must target /health/ready or /health/live')
}
