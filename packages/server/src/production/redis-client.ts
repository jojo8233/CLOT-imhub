import Redis from 'ioredis'

const DEFAULT_SECURITY_REDIS_COMMAND_TIMEOUT_MS = 3000

export interface SecurityCriticalRedisOptions {
  commandTimeoutMs?: number
  lazyConnect?: boolean
}

export function createSecurityCriticalRedis(
  redisUrl: string,
  options: SecurityCriticalRedisOptions = {},
): Redis {
  const redis = new Redis(redisUrl, {
    connectTimeout: 3000,
    commandTimeout: options.commandTimeoutMs ?? DEFAULT_SECURITY_REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    lazyConnect: options.lazyConnect ?? false,
  })
  redis.on('error', () => {
    // 调用方将故障收敛为固定的 missing/503；禁止 ioredis silentEmit
    // 另外输出可能包含内部网络地址的原始错误堆栈。
  })
  return redis
}
