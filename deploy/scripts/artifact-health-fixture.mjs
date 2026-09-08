import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? '48080')
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('artifact health fixture port invalid')
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/health/ready') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ status: 'ready' }))
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`artifact health fixture listening on 127.0.0.1:${port}\n`)
})

function close() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
