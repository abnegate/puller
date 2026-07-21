import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createSnapshotCache } from './cache.mjs'
import { createClaudeRunManager } from './claude.mjs'
import { createGhGraphql, fetchAuthoredPulls } from './github.mjs'
import {
  assertProductionBuild,
  createRequestListener,
  createStaticHandler,
} from './http.mjs'
import { createReadinessSnapshot } from './readiness.mjs'
import { createWorkspaceResolver, resolveWorkspaceOptions } from './workspace.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')
const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost'])

function originFor(host, port) {
  const address = host.includes(':') ? `[${host}]` : host
  return `http://${address}:${port}`
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolveClose()
        return
      }
      reject(error)
    })
  })
}

export function resolveServerOptions(environment = process.env) {
  const host = environment.HOST || '127.0.0.1'
  if (!LOOPBACKS.has(host) && environment.ALLOW_EXTERNAL !== '1') {
    throw new Error(
      `Refusing to bind to non-loopback host ${host}. Set ALLOW_EXTERNAL=1 to opt in.`,
    )
  }

  const port = Number(environment.PORT || 5173)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535.')
  }

  return { host, port }
}

export async function start({
  mode,
  environment = process.env,
  createVite,
  graphql = createGhGraphql(),
  root = ROOT,
  distPath = DIST,
  createManager = createClaudeRunManager,
  workspaceResolver,
  actionToken = randomBytes(32).toString('base64url'),
} = {}) {
  if (mode !== 'development' && mode !== 'production') {
    throw new Error('Start mode must be development or production.')
  }

  const { host, port } = resolveServerOptions(environment)
  const cache = createSnapshotCache({
    load: async () =>
      createReadinessSnapshot(await fetchAuthoredPulls({ graphql })),
  })
  const resolver = workspaceResolver ?? createWorkspaceResolver(resolveWorkspaceOptions(environment))
  const runManager = createManager({ cache, resolver })
  const trustedOrigin = originFor(host, port)
  const executionEnabled = LOOPBACKS.has(host) || environment.ALLOW_EXTERNAL_EXECUTION === '1'

  let fallback = (_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('The client is still starting.')
  }
  const server = createServer(
    createRequestListener({
      cache,
      runManager,
      actionToken,
      trustedOrigin,
      executionEnabled,
      fallback: (request, response) => fallback(request, response),
    }),
  )

  let vite = null
  if (mode === 'development') {
    const create = createVite ?? (await import('vite')).createServer
    vite = await create({
      root,
      appType: 'spa',
      server: {
        middlewareMode: { server },
      },
    })
    fallback = vite.middlewares
  } else {
    await assertProductionBuild(distPath)
    fallback = createStaticHandler({ distPath })
  }

  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolveListen()
      })
    })
  } catch (error) {
    await Promise.allSettled([runManager.shutdown(), closeServer(server), vite?.close()])
    throw error
  }

  let closing = null
  const close = () => {
    if (!closing) {
      closing = (async () => {
        await runManager.shutdown()
        await closeServer(server)
        await vite?.close()
      })()
    }
    return closing
  }

  return { actionToken, close, host, port, runManager, server, vite }
}

async function main() {
  const mode = process.argv.includes('--dev')
    ? 'development'
    : process.argv.includes('--production')
      ? 'production'
      : null

  if (!mode) {
    throw new Error('Use --dev or --production.')
  }

  const running = await start({ mode })
  console.log(`Authored pulls ready at http://${running.host}:${running.port}`)

  const shutdown = async () => {
    try {
      await running.close()
      process.exitCode = 0
    } catch {
      process.exitCode = 1
    }
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Server failed to start.')
    process.exitCode = 1
  })
}
