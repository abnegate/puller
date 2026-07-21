import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SnapshotError } from '../cache.mjs'
import {
  assertProductionBuild,
  createRequestListener,
  createStaticHandler,
} from '../http.mjs'
import { resolveServerOptions, start } from '../index.mjs'

const temporary = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'authored-pulls-'))
  temporary.push(path)
  return path
}

async function listen(listener) {
  const server = createServer(listener)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function freePort() {
  const running = await listen((_request, response) => response.end())
  const port = Number(new URL(running.origin).port)
  await running.close()
  return port
}

async function listenAt(listener, port) {
  const server = createServer(listener)
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function rawStatus(origin, path) {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path,
      },
      (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      },
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function eventually(assertion) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      if (attempt === 49) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

function emptyGraphql() {
  return Promise.resolve({
    search: {
      issueCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  })
}

function snapshot() {
  return {
    query: 'is:pr author:@me state:open archived:false sort:updated-desc',
    generatedAt: '2026-07-17T00:00:00.000Z',
    stale: false,
    partial: false,
    warnings: [],
    counts: { total: 0, ready: 0, notReady: 0 },
    ready: [],
    notReady: [],
  }
}

describe('API endpoint', () => {
  it('returns normalized data with no-store and no CORS header', async () => {
    const cache = { get: vi.fn(async () => snapshot()) }
    const running = await listen(
      createRequestListener({
        cache,
        fallback: (_request, response) => response.end('client'),
      }),
    )

    const response = await fetch(`${running.origin}/api/pulls`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    await expect(response.json()).resolves.toEqual(snapshot())
    await running.close()
  })

  it('protects framing headers from downstream replacement or removal', async () => {
    const running = await listen(
      createRequestListener({
        cache: { get: vi.fn(async () => snapshot()) },
        fallback: (_request, response) => {
          response.setHeader('Content-Security-Policy', 'frame-ancestors *')
          response.removeHeader('X-Frame-Options')
          response.writeHead(200, {
            'Content-Security-Policy': 'frame-ancestors https://evil.invalid',
            'X-Frame-Options': 'SAMEORIGIN',
          })
          response.end('client')
        },
      }),
    )

    const response = await fetch(`${running.origin}/client`)
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    await running.close()
  })

  it('maps refresh=1 to a manual cache bypass', async () => {
    const cache = { get: vi.fn(async () => snapshot()) }
    const running = await listen(
      createRequestListener({
        cache,
        fallback: (_request, response) => response.end(),
      }),
    )

    await fetch(`${running.origin}/api/pulls?refresh=1`)
    expect(cache.get).toHaveBeenCalledWith({ refresh: true })
    await running.close()
  })

  it('returns correct statuses for unsupported API methods and paths', async () => {
    const cache = { get: vi.fn(async () => snapshot()) }
    const running = await listen(
      createRequestListener({
        cache,
        fallback: (_request, response) => response.end(),
      }),
    )

    const method = await fetch(`${running.origin}/api/pulls`, { method: 'POST' })
    expect(method.status).toBe(405)
    expect(method.headers.get('allow')).toBe('GET')
    expect((await fetch(`${running.origin}/api/missing`)).status).toBe(404)
    await running.close()
  })

  it('does not expose unexpected server error details', async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new Error('ghp_super_secret')
      }),
    }
    const running = await listen(
      createRequestListener({
        cache,
        fallback: (_request, response) => response.end(),
      }),
    )

    const body = await (await fetch(`${running.origin}/api/pulls`)).text()
    expect(body).toContain('gh auth status')
    expect(body).not.toContain('ghp_super_secret')
    await running.close()
  })

  it('returns actionable normalized initial cache errors', async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new SnapshotError('Run gh auth status, then gh auth login if needed.')
      }),
    }
    const running = await listen(
      createRequestListener({
        cache,
        fallback: (_request, response) => response.end(),
      }),
    )

    const response = await fetch(`${running.origin}/api/pulls`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('gh auth login')
    await running.close()
  })
})

describe('local action API', () => {
  async function actionServer(runManager, executionEnabled = true) {
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const running = await listenAt(createRequestListener({
      cache: { get: vi.fn(async () => snapshot()) },
      runManager,
      actionToken: 'process-token',
      trustedOrigin: origin,
      executionEnabled,
      fallback: (_request, response) => response.end('client'),
    }), port)
    return running
  }

  it('returns the per-process action token only for the exact trusted host', async () => {
    const running = await actionServer({ start: vi.fn(), cancel: vi.fn() })
    const response = await fetch(`${running.origin}/api/actions/token`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ token: 'process-token' })

    const untrusted = await fetch(`${running.origin}/api/actions/token`, {
      headers: { Origin: 'http://evil.invalid' },
    })
    expect(untrusted.status).toBe(403)
    await running.close()
  })

  it('requires JSON, the exact Origin and Host, and the action token', async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() }
    const running = await actionServer(runManager)
    const body = JSON.stringify({ repository: 'owner/repo', number: 1, expectedHeadRefOid: 'a'.repeat(40), message: 'fix' })

    for (const headers of [
      { 'Content-Type': 'application/json', Origin: running.origin },
      { 'Content-Type': 'application/json', Origin: 'http://evil.invalid', 'X-Action-Token': 'process-token' },
      { 'Content-Type': 'application/json', Origin: running.origin, 'X-Action-Token': 'wrong' },
    ]) {
      const response = await fetch(`${running.origin}/api/claude/runs`, { method: 'POST', headers, body })
      expect(response.status).toBe(403)
    }
    expect(runManager.start).not.toHaveBeenCalled()

    const media = await fetch(`${running.origin}/api/claude/runs`, {
      method: 'POST',
      headers: { Origin: running.origin, 'X-Action-Token': 'process-token', 'Content-Type': 'text/plain' },
      body,
    })
    expect(media.status).toBe(415)
    await running.close()
  })

  it('streams NDJSON start and terminal events and forwards the parsed body', async () => {
    const runManager = {
      start: vi.fn(async (body, channel) => {
        channel.write({ type: 'start', runId: 'one', repository: body.repository, number: body.number })
        channel.write({ type: 'diagnostic', text: 'Claude Code started.' })
        channel.write({ type: 'complete', exitCode: 0 })
      }),
      cancel: vi.fn(),
    }
    const running = await actionServer(runManager)
    const body = { repository: 'owner/repo', number: 1, expectedHeadRefOid: 'a'.repeat(40), message: 'fix' }
    const response = await fetch(`${running.origin}/api/claude/runs`, {
      method: 'POST',
      headers: {
        Origin: running.origin,
        'X-Action-Token': 'process-token',
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.text()).trim().split('\n').map(JSON.parse)).toEqual([
      { type: 'start', runId: 'one', repository: 'owner/repo', number: 1 },
      { type: 'diagnostic', text: 'Claude Code started.' },
      { type: 'complete', exitCode: 0 },
    ])
    expect(runManager.start.mock.calls[0][0]).toEqual(body)
    await running.close()
  })

  it('reports a disconnect to a run that registers its close listener late', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const disconnected = vi.fn()
    const runManager = {
      start: vi.fn(async (_body, channel) => {
        await gate
        channel.onClose(disconnected)
      }),
      cancel: vi.fn(),
    }
    const running = await actionServer(runManager)
    const url = new URL(running.origin)
    const body = JSON.stringify({
      repository: 'owner/repo',
      number: 1,
      expectedHeadRefOid: 'a'.repeat(40),
      message: 'fix',
    })
    const outgoing = request({
      host: url.hostname,
      port: url.port,
      path: '/api/claude/runs',
      method: 'POST',
      headers: {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json',
        Origin: running.origin,
        'X-Action-Token': 'process-token',
      },
    })
    outgoing.on('error', () => undefined)
    outgoing.end(body)

    await eventually(() => expect(runManager.start).toHaveBeenCalledOnce())
    outgoing.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    release()
    await eventually(() => expect(disconnected).toHaveBeenCalledOnce())
    await running.close()
  })

  it('caps the body before starting a run and cancels idempotently', async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() }
    const running = await actionServer(runManager)
    const headers = {
      Origin: running.origin,
      'X-Action-Token': 'process-token',
      'Content-Type': 'application/json',
    }
    const oversized = await fetch(`${running.origin}/api/claude/runs`, {
      method: 'POST', headers, body: JSON.stringify({ message: 'x'.repeat(70_000) }),
    })
    expect(oversized.status).toBe(413)
    expect(runManager.start).not.toHaveBeenCalled()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${running.origin}/api/claude/runs/run-1`, {
        method: 'DELETE', headers: { Origin: running.origin, 'X-Action-Token': 'process-token' },
      })
      expect(response.status).toBe(204)
    }
    expect(runManager.cancel).toHaveBeenCalledTimes(2)
    await running.close()
  })

  it('disables execution on externally bound servers without the second opt-in', async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() }
    const running = await actionServer(runManager, false)
    const response = await fetch(`${running.origin}/api/claude/runs`, { method: 'POST' })
    expect(response.status).toBe(403)
    expect(runManager.start).not.toHaveBeenCalled()
    await running.close()
  })
})

describe('production static serving', () => {
  it('serves assets and uses the SPA fallback for navigation', async () => {
    const dist = await directory()
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'index.html'), '<main>app shell</main>')
    await writeFile(join(dist, 'assets', 'app.js'), 'window.ready = true')
    const running = await listen(createStaticHandler({ distPath: dist }))

    const asset = await fetch(`${running.origin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(await asset.text()).toBe('window.ready = true')

    const navigation = await fetch(`${running.origin}/pulls/ready`)
    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain('app shell')
    await running.close()
  })

  it('does not use the SPA fallback for missing assets', async () => {
    const dist = await directory()
    await writeFile(join(dist, 'index.html'), '<main>app shell</main>')
    const running = await listen(createStaticHandler({ distPath: dist }))

    expect((await fetch(`${running.origin}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${running.origin}/missing.css`)).status).toBe(404)
    await running.close()
  })

  it('rejects traversal and symlinks outside dist', async () => {
    const root = await directory()
    const dist = join(root, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, 'index.html'), '<main>safe</main>')
    await writeFile(join(root, 'secret.txt'), 'secret')
    await symlink(join(root, 'secret.txt'), join(dist, 'leak.txt'))
    const running = await listen(createStaticHandler({ distPath: dist }))

    expect(await rawStatus(running.origin, '/%2e%2e/secret.txt')).toBe(400)
    expect((await fetch(`${running.origin}/leak.txt`)).status).toBe(404)
    await running.close()
  })

  it('fails clearly when the production build is missing', async () => {
    const dist = await directory()
    await expect(assertProductionBuild(dist)).rejects.toThrow(
      'Run pnpm build before pnpm start',
    )
  })
})

describe('server startup', () => {
  it('defaults to loopback and requires explicit external opt-in', () => {
    expect(resolveServerOptions({})).toEqual({ host: '127.0.0.1', port: 5173 })
    expect(() => resolveServerOptions({ HOST: '0.0.0.0' })).toThrow('ALLOW_EXTERNAL=1')
    expect(resolveServerOptions({ HOST: '0.0.0.0', ALLOW_EXTERNAL: '1', PORT: '8080' })).toEqual(
      { host: '0.0.0.0', port: 8080 },
    )
  })

  it('runs the API and Vite middleware in one development server', async () => {
    const port = await freePort()
    const closeVite = vi.fn(async () => undefined)
    const createVite = vi.fn(async () => ({
      middlewares: (_request, response) => response.end('vite client'),
      close: closeVite,
    }))
    const running = await start({
      mode: 'development',
      environment: { PORT: String(port) },
      createVite,
      graphql: emptyGraphql,
    })

    const client = await fetch(`http://127.0.0.1:${port}/`)
    expect(await client.text()).toBe('vite client')
    expect(client.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(client.headers.get('x-frame-options')).toBe('DENY')
    const api = await fetch(`http://127.0.0.1:${port}/api/pulls`)
    expect(api.status).toBe(200)
    expect(api.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(api.headers.get('x-frame-options')).toBe('DENY')
    expect(createVite.mock.calls[0][0]).toMatchObject({
      appType: 'spa',
      server: { middlewareMode: { server: running.server } },
    })
    await running.close()
    expect(closeVite).toHaveBeenCalledOnce()
  })

  it('shuts down active runs before closing the client server', async () => {
    const port = await freePort()
    const order = []
    const manager = {
      start: vi.fn(),
      cancel: vi.fn(),
      shutdown: vi.fn(async () => { order.push('runs') }),
    }
    const running = await start({
      mode: 'development',
      environment: { PORT: String(port) },
      createManager: () => manager,
      createVite: async () => ({
        middlewares: (_request, response) => response.end('client'),
        close: async () => { order.push('vite') },
      }),
      graphql: emptyGraphql,
    })

    await running.close()
    await running.close()
    expect(order).toEqual(['runs', 'vite'])
    expect(manager.shutdown).toHaveBeenCalledOnce()
  })

  it('closes Vite and the failed server when the development port is occupied', async () => {
    const occupied = createServer((_request, response) => response.end('occupied'))
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    const closeVite = vi.fn(async () => undefined)
    let attemptedServer
    const createVite = vi.fn(async (config) => {
      attemptedServer = config.server.middlewareMode.server
      return {
        middlewares: (_request, response) => response.end('vite client'),
        close: closeVite,
      }
    })

    try {
      await expect(
        start({
          mode: 'development',
          environment: { PORT: String(address.port) },
          createVite,
          graphql: emptyGraphql,
        }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(closeVite).toHaveBeenCalledOnce()
      expect(attemptedServer.listening).toBe(false)
    } finally {
      await new Promise((resolve) => occupied.close(resolve))
    }
  })

  it('runs the API, built client, and SPA fallback in production', async () => {
    const dist = await directory()
    await writeFile(join(dist, 'index.html'), '<main>production</main>')
    const port = await freePort()
    const running = await start({
      mode: 'production',
      environment: { PORT: String(port) },
      distPath: dist,
      graphql: emptyGraphql,
    })

    const client = await fetch(`http://127.0.0.1:${port}/route`)
    expect(await client.text()).toContain(
      'production',
    )
    expect(client.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(client.headers.get('x-frame-options')).toBe('DENY')
    const api = await fetch(`http://127.0.0.1:${port}/api/pulls`)
    expect(api.status).toBe(200)
    expect(api.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    expect(api.headers.get('x-frame-options')).toBe('DENY')
    await running.close()
  })
})
