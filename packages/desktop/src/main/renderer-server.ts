import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const RENDERER_CONTENT_TYPE: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export interface RendererServerOptions {
  connectSources: readonly string[]
  mainOutputDirectory: string
}

function canonicalConnectSources(sources: readonly string[]): string {
  if (sources.length === 0) throw new Error('renderer connect sources missing')
  return sources.map((source) => {
    const url = new URL(source)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      || source !== url.origin) {
      throw new Error('renderer connect source invalid')
    }
    return url.origin
  }).join(' ')
}

export async function startRendererServer(
  options: RendererServerOptions,
): Promise<{ server: Server; url: string }> {
  const rendererRoot = normalize(join(options.mainOutputDirectory, '../renderer'))
  const connectSources = canonicalConnectSources(options.connectSources)
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end()
          return
        }
        const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
        const pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname
        const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '')
        const file = normalize(join(rendererRoot, relative))
        if (file !== rendererRoot && !file.startsWith(`${rendererRoot}${sep}`)) {
          response.writeHead(404).end()
          return
        }
        const body = await readFile(file)
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'self'; connect-src ${connectSources}; frame-src http://localhost:1234 https://web.whatsapp.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
          'Content-Type': RENDERER_CONTENT_TYPE[extname(file)] ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      } catch {
        response.writeHead(404).end()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('im-hub 本机页面服务启动失败')
  }
  return { server, url: `http://127.0.0.1:${address.port}/` }
}
