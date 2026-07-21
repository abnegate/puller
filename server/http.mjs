import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'

import { SnapshotError } from './cache.mjs'
import { ACTION_LIMITS, ActionError, actionError } from './claude.mjs'

const TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

const SECURITY_HEADERS = new Map([
  ['content-security-policy', ['Content-Security-Policy', "frame-ancestors 'none'"]],
  ['x-frame-options', ['X-Frame-Options', 'DENY']],
])

function protectResponse(response) {
  const setHeader = response.setHeader.bind(response)
  const removeHeader = response.removeHeader.bind(response)
  const appendHeader = response.appendHeader?.bind(response)
  const writeHead = response.writeHead.bind(response)

  const protectedHeader = (name) => SECURITY_HEADERS.get(String(name).toLowerCase())
  const applyHeader = (name, value) => {
    const entry = protectedHeader(name)
    return setHeader(entry?.[0] ?? name, entry?.[1] ?? value)
  }
  const applyHeaders = (headers) => {
    if (!headers) return
    if (Array.isArray(headers)) {
      for (let index = 0; index < headers.length; index += 2) {
        applyHeader(headers[index], headers[index + 1])
      }
      return
    }
    for (const [name, value] of Object.entries(headers)) {
      applyHeader(name, value)
    }
  }

  response.setHeader = (name, value) => applyHeader(name, value)
  response.removeHeader = (name) => {
    if (protectedHeader(name)) return
    removeHeader(name)
  }
  if (appendHeader) {
    response.appendHeader = (name, value) => {
      const entry = protectedHeader(name)
      return entry ? setHeader(entry[0], entry[1]) : appendHeader(name, value)
    }
  }
  response.writeHead = (status, statusMessage, headers) => {
    if (typeof statusMessage === 'string') {
      applyHeaders(headers)
      for (const [name, value] of SECURITY_HEADERS.values()) setHeader(name, value)
      return writeHead(status, statusMessage)
    }
    applyHeaders(headers ?? statusMessage)
    for (const [name, value] of SECURITY_HEADERS.values()) setHeader(name, value)
    return writeHead(status)
  }

  for (const [name, value] of SECURITY_HEADERS.values()) setHeader(name, value)
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(body)
}

function sendText(response, status, message, method = 'GET', headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  })
  response.end(method === 'HEAD' ? undefined : message)
}

function trustedRequest(request, trustedOrigin, requireOrigin = true) {
  const trusted = new URL(trustedOrigin)
  const origin = request.headers.origin
  return request.headers.host === trusted.host &&
    (!requireOrigin || origin === trustedOrigin) &&
    (origin === undefined || origin === trustedOrigin)
}

function authorized(request, token) {
  const supplied = request.headers['x-action-token']
  if (typeof supplied !== 'string') return false
  const actual = Buffer.from(supplied)
  const expected = Buffer.from(token)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function sendActionError(response, error) {
  const safe = actionError(error)
  sendJson(response, safe.status, { error: safe.message, code: safe.code })
}

async function readJson(request, maximum = ACTION_LIMITS.body) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new ActionError(415, 'json_required', 'The request must use application/json.')
  }
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maximum) {
    request.resume()
    throw new ActionError(413, 'body_too_large', 'The request exceeds the 64 KiB limit.')
  }

  return await new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.resume()
      reject(error)
    }
    const onData = (chunk) => {
      size += chunk.byteLength
      if (size > maximum) {
        fail(new ActionError(413, 'body_too_large', 'The request exceeds the 64 KiB limit.'))
        return
      }
      chunks.push(chunk)
    }
    const onAborted = () => fail(new ActionError(400, 'request_aborted', 'The request was interrupted.'))
    const onEnd = () => {
      if (settled) return
      settled = true
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ActionError(400, 'invalid_json', 'The request body is not valid JSON.'))
      }
    }

    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
  })
}

function responseChannel(request, response) {
  const closeListeners = new Set()
  const closed = () => response.destroyed || request.aborted
  const onClose = () => {
    if (!response.writableEnded) {
      for (const listener of closeListeners) listener()
    }
  }
  response.once('close', onClose)

  return {
    write(event) {
      if (response.destroyed || response.writableEnded) return true
      const line = `${JSON.stringify(event)}\n`
      if (!response.headersSent) {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
      }
      if (event.type === 'complete' || event.type === 'error' || event.type === 'cancelled' || event.type === 'limit') {
        response.end(line)
        return true
      }
      return response.write(line)
    },
    onceDrain(listener) {
      response.once('drain', listener)
      return () => response.off('drain', listener)
    },
    onClose(listener) {
      if (closed()) {
        listener()
        return () => undefined
      }
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    closed,
  }
}

export function createApiHandler({
  cache,
  runManager = null,
  actionToken = '',
  trustedOrigin = 'http://127.0.0.1:5173',
  executionEnabled = true,
}) {
  return async function handleApi(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/api/')) {
      return false
    }

    if (url.pathname === '/api/actions/token') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
      } else if (!trustedRequest(request, trustedOrigin, false)) {
        sendJson(response, 403, { error: 'Untrusted request origin.' })
      } else {
        sendJson(response, 200, { token: actionToken })
      }
      return true
    }

    if (url.pathname === '/api/claude/runs') {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
        return true
      }
      if (!executionEnabled || !runManager) {
        sendJson(response, 403, { error: 'Local execution is disabled for this server binding.' })
        return true
      }
      if (!trustedRequest(request, trustedOrigin) || !authorized(request, actionToken)) {
        sendJson(response, 403, { error: 'The action request is not authorized.' })
        return true
      }
      try {
        const body = await readJson(request)
        await runManager.start(body, responseChannel(request, response))
      } catch (error) {
        if (!response.headersSent) {
          sendActionError(response, error)
        } else if (!response.writableEnded) {
          response.end(`${JSON.stringify({ type: 'error', message: 'The Claude Code run failed.' })}\n`)
        }
      }
      return true
    }

    const cancellation = /^\/api\/claude\/runs\/([A-Za-z0-9-]+)$/.exec(url.pathname)
    if (cancellation) {
      if (request.method !== 'DELETE') {
        sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'DELETE' })
      } else if (!executionEnabled || !runManager) {
        sendJson(response, 403, { error: 'Local execution is disabled for this server binding.' })
      } else if (!trustedRequest(request, trustedOrigin) || !authorized(request, actionToken)) {
        sendJson(response, 403, { error: 'The action request is not authorized.' })
      } else {
        runManager.cancel(cancellation[1])
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
      }
      return true
    }

    if (url.pathname !== '/api/pulls') {
      sendJson(response, 404, { error: 'API endpoint not found.' })
      return true
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET' })
      return true
    }

    try {
      const snapshot = await cache.get({
        refresh: url.searchParams.get('refresh') === '1',
      })
      sendJson(response, 200, snapshot)
    } catch (error) {
      sendJson(response, 503, {
        error:
          error instanceof SnapshotError
            ? error.message
            : 'Pull requests could not be loaded. Run gh auth status and try again.',
      })
    }

    return true
  }
}

function isInside(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))
}

function decodePath(requestUrl) {
  const raw = (requestUrl ?? '/').split('?', 1)[0]
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }

  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((segment) => segment === '..')
  ) {
    return null
  }

  return decoded.startsWith('/') ? decoded : `/${decoded}`
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function safeFile(root, actualRoot, candidate) {
  if (!isInside(root, candidate) || !(await existingFile(candidate))) {
    return null
  }

  const actual = await realpath(candidate)
  return isInside(actualRoot, actual) ? actual : null
}

export function createStaticHandler({ distPath }) {
  const root = resolve(distPath)
  const indexPath = resolve(root, 'index.html')
  const actualRoot = realpath(root)

  return async function serveStatic(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendText(response, 405, 'Method not allowed.', request.method, { Allow: 'GET, HEAD' })
      return
    }

    const pathname = decodePath(request.url)
    if (pathname === null) {
      sendText(response, 400, 'Invalid path.', request.method)
      return
    }

    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    let file = await safeFile(root, await actualRoot, candidate)
    if (!file) {
      const assetRequest = pathname.startsWith('/assets/') || extname(pathname) !== ''
      if (assetRequest) {
        sendText(response, 404, 'Not found.', request.method)
        return
      }

      file = await safeFile(root, await actualRoot, indexPath)
      if (!file) {
        sendText(response, 500, 'The production client is unavailable.', request.method)
        return
      }
    }

    const body = await readFile(file)
    const extension = extname(file).toLowerCase()
    response.writeHead(200, {
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Length': body.byteLength,
      'Content-Type': TYPES.get(extension) ?? 'application/octet-stream',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
}

export function createRequestListener({ cache, fallback, ...actions }) {
  const api = createApiHandler({ cache, ...actions })

  return function requestListener(request, response) {
    protectResponse(response)
    Promise.resolve(api(request, response))
      .then((handled) => {
        if (!handled) {
          return fallback(request, response)
        }
        return undefined
      })
      .catch(() => {
        if (!response.headersSent) {
          sendText(response, 500, 'Unexpected server error.', request.method)
        } else {
          response.destroy()
        }
      })
  }
}

export async function assertProductionBuild(distPath) {
  const indexPath = resolve(distPath, 'index.html')
  try {
    await access(indexPath, constants.R_OK)
  } catch {
    throw new Error(
      `Production client not found at ${indexPath}. Run pnpm build before pnpm start.`,
    )
  }
}
