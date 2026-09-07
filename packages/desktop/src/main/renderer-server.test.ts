import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'

import { startRendererServer } from './renderer-server.js'

describe('loopback renderer server', () => {
  let server: Server | null = null
  let rendererRoot: string | null = null

  afterEach(async () => {
    const currentServer = server
    if (currentServer) await new Promise<void>(resolve => currentServer.close(() => resolve()))
    if (rendererRoot) await rm(rendererRoot, { recursive: true, force: true })
    server = null
    rendererRoot = null
  })

  it('serves the packaged shell from a concrete loopback origin with a restrictive CSP', async () => {
    rendererRoot = await mkdtemp(join(tmpdir(), 'imhub-renderer-'))
    await writeFile(join(rendererRoot, 'index.html'), '<!doctype html><title>im-hub</title>')

    const renderer = await startRendererServer({
      rendererRoot,
      connectSources: ['https://imhub.example.test', 'wss://imhub.example.test'],
    })
    server = renderer.server

    expect(new URL(renderer.url).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(new URL(renderer.url).origin).not.toBe('null')
    const response = await fetch(renderer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>im-hub</title>')
    expect(response.headers.get('content-security-policy')).toContain(
      'connect-src https://imhub.example.test wss://imhub.example.test',
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not serve files outside the renderer root', async () => {
    rendererRoot = await mkdtemp(join(tmpdir(), 'imhub-renderer-'))
    await writeFile(join(rendererRoot, 'index.html'), '<!doctype html>')
    const renderer = await startRendererServer({
      rendererRoot,
      connectSources: ['http://127.0.0.1:4000', 'ws://127.0.0.1:4000'],
    })
    server = renderer.server

    const response = await fetch(`${renderer.url}%2e%2e/%2e%2e/package.json`)
    expect(response.status).toBe(404)
  })
})
