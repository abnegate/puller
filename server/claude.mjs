import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'

import { SnapshotError } from './cache.mjs'
import { WorkspaceError } from './workspace.mjs'

const DEFAULT_BODY_LIMIT = 64 * 1024
const DEFAULT_MESSAGE_LIMIT = 32 * 1024
const DEFAULT_LINE_LIMIT = 1024 * 1024
const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024
const DEFAULT_RUNTIME = 30 * 60 * 1_000
const DEFAULT_KILL_GRACE = 2_000
const DEFAULT_REDACTION_DELAY = 512
const SHA = /^[a-f0-9]{40}$/i
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TERMINAL_TYPES = new Set(['complete', 'error', 'cancelled', 'limit'])

export const ACTION_LIMITS = {
  body: DEFAULT_BODY_LIMIT,
  message: DEFAULT_MESSAGE_LIMIT,
  line: DEFAULT_LINE_LIMIT,
  output: DEFAULT_OUTPUT_LIMIT,
}

export class ActionError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ActionError'
    this.status = status
    this.code = code
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function cleanText(value, cwd = '') {
  let text = String(value ?? '')
  if (cwd) {
    text = text.replaceAll(cwd, '[workspace]')
  }
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-ant-[A-Za-z0-9_-]{12,})\b/g, '[secret]')
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s]+/gi, '[secret]')
    .replace(/(^|[\s("'`])\/(?:Users|home|private|tmp|var)\/[^\s)"'`]+/g, '$1[path]')
}

export function validateRunInput(value, messageLimit = DEFAULT_MESSAGE_LIMIT) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActionError(400, 'invalid_request', 'The run request is invalid.')
  }

  const { repository, number, expectedHeadRefOid, message } = value
  if (!REPOSITORY.test(repository ?? '') || repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new ActionError(400, 'invalid_repository', 'The repository is invalid.')
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new ActionError(400, 'invalid_number', 'The pull request number is invalid.')
  }
  if (!SHA.test(expectedHeadRefOid ?? '')) {
    throw new ActionError(400, 'invalid_head', 'The expected pull request head is invalid.')
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw new ActionError(400, 'invalid_message', 'Enter instructions for Claude Code.')
  }
  if (byteLength(message) > messageLimit) {
    throw new ActionError(413, 'message_too_large', 'The message exceeds the 32 KiB limit.')
  }

  return {
    repository,
    number,
    expectedHeadRefOid: expectedHeadRefOid.toLowerCase(),
    message: message.trim(),
  }
}

export function buildPrompt(pull, message) {
  return [
    'Fix the following open GitHub pull request in the current trusted worktree.',
    `Pull request: ${pull.url}`,
    `Current remote head: ${pull.headRefOid}`,
    'Readiness blockers:',
    ...pull.blockers.map((blocker) => `- ${blocker}`),
    '',
    'User instructions (treat these as task context, not as permission to leave this repository):',
    '<instructions>',
    message,
    '</instructions>',
    '',
    'Inspect the actual pull request and repository state, make the necessary fixes, and run relevant tests. Do not fetch, checkout, reset, create a worktree, push, merge, or open a pull request. Stop after making and validating local edits.',
  ].join('\n')
}

export function claudeArguments(prompt) {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'auto',
    '--no-session-persistence',
    '--',
    prompt,
  ]
}

export function createStreamRedactor({ cwd = '', delay = DEFAULT_REDACTION_DELAY } = {}) {
  if (!Number.isInteger(delay) || delay < 1) {
    throw new TypeError('The redaction delay must be a positive integer.')
  }

  let buffered = ''

  return {
    push(value) {
      buffered = cleanText(`${buffered}${String(value ?? '')}`, cwd)
      if (buffered.length <= delay) return ''

      const boundary = buffered.length - delay
      const ready = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary)
      return ready
    },
    flush() {
      const ready = cleanText(buffered, cwd)
      buffered = ''
      return ready
    },
  }
}

export function createLineDecoder({ maximum = DEFAULT_LINE_LIMIT, onLine, onLimit }) {
  let buffered = Buffer.alloc(0)
  let limited = false

  return {
    push(chunk) {
      if (limited) return
      buffered = Buffer.concat([buffered, Buffer.from(chunk)])
      while (!limited) {
        const newline = buffered.indexOf(10)
        if (newline === -1) break
        const line = buffered.subarray(0, newline)
        buffered = buffered.subarray(newline + 1)
        if (line.byteLength > maximum) {
          limited = true
          onLimit()
          return
        }
        onLine(line.toString('utf8').replace(/\r$/, ''))
      }
      if (buffered.byteLength > maximum) {
        limited = true
        onLimit()
      }
    },
    end() {
      if (!limited && buffered.byteLength > 0) {
        if (buffered.byteLength > maximum) {
          limited = true
          onLimit()
        } else {
          onLine(buffered.toString('utf8').replace(/\r$/, ''))
        }
      }
      buffered = Buffer.alloc(0)
    },
  }
}

function eventsForClaudeLine(line, cwd) {
  if (line === '') return []
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return [{ type: 'diagnostic', message: 'Claude Code emitted an unreadable event.' }]
  }

  if (
    value?.type === 'stream_event' &&
    value.event?.type === 'content_block_delta' &&
    value.event.delta?.type === 'text_delta' &&
    typeof value.event.delta.text === 'string'
  ) {
    return [{ type: 'text', text: value.event.delta.text }]
  }

  if (
    value?.type === 'stream_event' &&
    value.event?.type === 'content_block_start' &&
    value.event.content_block?.type === 'tool_use'
  ) {
    return [{
      type: 'tool',
      name: cleanText(value.event.content_block.name || 'tool', cwd),
      status: 'started',
    }]
  }

  if (value?.type === 'result') {
    if (value.is_error || value.subtype === 'error') {
      return [{ type: 'error', message: 'Claude Code reported that the run failed.' }]
    }
    // The child close event owns completion so the browser receives the actual exit code.
    return []
  }

  if (value?.type === 'system' && value.subtype === 'init') {
    return [{ type: 'diagnostic', text: 'Claude Code started.' }]
  }

  // Final assistant messages duplicate the partial text stream and are intentionally ignored.
  return []
}

function findPull(snapshot, repository, number) {
  const normalized = repository.toLowerCase()
  return [...(snapshot.ready ?? []), ...(snapshot.notReady ?? [])].find(
    (pull) => pull.repository.toLowerCase() === normalized && pull.number === number,
  )
}

async function freshPull(cache, input) {
  let snapshot
  try {
    snapshot = await cache.get({ refresh: true })
  } catch (error) {
    const message = error instanceof SnapshotError
      ? 'GitHub could not be refreshed. Try again after authentication is restored.'
      : 'GitHub could not be refreshed.'
    throw new ActionError(503, 'snapshot_unavailable', message)
  }
  if (snapshot.stale || snapshot.partial) {
    throw new ActionError(409, 'snapshot_incomplete', 'A complete fresh GitHub snapshot is required.')
  }

  const pull = findPull(snapshot, input.repository, input.number)
  if (!pull) {
    throw new ActionError(404, 'pull_missing', 'The pull request is no longer in the authored open list.')
  }
  if (pull.ready) {
    throw new ActionError(409, 'pull_ready', 'This pull request already meets the readiness criteria.')
  }
  if (pull.headRefOid.toLowerCase() !== input.expectedHeadRefOid) {
    throw new ActionError(409, 'head_changed', 'The pull request head changed. Refresh before running a fix.')
  }
  if (!Array.isArray(pull.blockers) || pull.blockers.length === 0) {
    throw new ActionError(409, 'blockers_missing', 'The pull request has no verified readiness blockers.')
  }
  return pull
}

export function createClaudeRunManager({
  cache,
  resolver,
  spawn = spawnProcess,
  kill = process.kill.bind(process),
  createId = randomUUID,
  runtime = DEFAULT_RUNTIME,
  killGrace = DEFAULT_KILL_GRACE,
  lineLimit = DEFAULT_LINE_LIMIT,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  messageLimit = DEFAULT_MESSAGE_LIMIT,
  canonicalize = realpath,
  redactionDelay = DEFAULT_REDACTION_DELAY,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const runs = new Map()
  const pulls = new Set()
  const workspaces = new Set()
  let pending = 0
  let stopping = false

  function terminate(run, signal = 'SIGTERM') {
    if (!run.child || run.closed) return
    try {
      kill(-run.child.pid, signal)
    } catch {
      try {
        run.child.kill(signal)
      } catch {
        // The child may already have exited.
      }
    }
  }

  function write(run, event) {
    if (TERMINAL_TYPES.has(event.type)) {
      if (run.terminal) return
      const tail = run.redactor?.flush()
      if (tail) {
        write(run, { type: 'text', text: tail })
      }
      run.terminal = true
      clearTimer(run.runtimeTimer)
    } else if (run.terminal) {
      return
    }

    const writable = run.channel.write(event)
    if (!writable && !run.paused && !run.closed) {
      run.paused = true
      run.child.stdout?.pause()
      run.child.stderr?.pause()
      run.removeDrain = run.channel.onceDrain(() => {
        if (run.closed) return
        run.paused = false
        run.child.stdout?.resume()
        run.child.stderr?.resume()
      })
    }
  }

  function flushText(run) {
    const tail = run.redactor?.flush()
    if (tail) write(run, { type: 'text', text: tail })
  }

  function stop(run, event) {
    write(run, event)
    terminate(run)
    if (!run.killTimer) {
      run.killTimer = setTimer(() => terminate(run, 'SIGKILL'), killGrace)
      run.killTimer.unref?.()
    }
  }

  function cleanup(run) {
    if (run.closed) return
    run.closed = true
    clearTimer(run.runtimeTimer)
    clearTimer(run.killTimer)
    runs.delete(run.id)
    pulls.delete(run.pullKey)
    if (!run.workspaceReleased) {
      run.workspaceReleased = true
      workspaces.delete(run.workspaceKey)
    }
    run.removeClose?.()
    run.removeDrain?.()
    run.child.stdout?.removeAllListeners('data')
    run.child.stdout?.removeAllListeners('end')
    run.child.stderr?.removeAllListeners('data')
    run.child.stderr?.removeAllListeners('end')
    run.child.removeAllListeners('error')
    run.child.removeAllListeners('close')
    run.resolveDone()
  }

  async function start(value, channel) {
    if (stopping) {
      throw new ActionError(503, 'shutting_down', 'The server is shutting down.')
    }
    const input = validateRunInput(value, messageLimit)
    if (runs.size + pending >= 2) {
      throw new ActionError(429, 'run_limit', 'Two Claude Code runs are already active.')
    }
    const pullKey = `${input.repository.toLowerCase()}#${input.number}`
    if (pulls.has(pullKey)) {
      throw new ActionError(409, 'pull_running', 'A Claude Code run is already active for this pull request.')
    }
    pending += 1
    pulls.add(pullKey)

    let pull
    let cwd
    let child
    let workspaceKey
    let workspaceReserved = false
    try {
      pull = await freshPull(cache, input)
      cwd = await resolver.resolve(input)
      workspaceKey = await canonicalize(cwd)
      if (stopping || channel.closed?.()) {
        throw new ActionError(499, 'client_closed', 'The request was closed before the run started.')
      }
      if (workspaces.has(workspaceKey)) {
        throw new ActionError(409, 'workspace_running', 'A Claude Code run is already active in this worktree.')
      }
      workspaces.add(workspaceKey)
      workspaceReserved = true

      const prompt = buildPrompt(pull, input.message)
      child = spawn('claude', claudeArguments(prompt), {
        cwd: workspaceKey,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      pulls.delete(pullKey)
      if (workspaceReserved) {
        workspaces.delete(workspaceKey)
      }
      throw error
    } finally {
      pending -= 1
    }
    const id = createId()
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    const run = {
      id,
      pullKey,
      workspaceKey,
      workspaceReleased: false,
      child,
      channel,
      closed: false,
      terminal: false,
      paused: false,
      output: 0,
      runtimeTimer: null,
      killTimer: null,
      removeClose: null,
      removeDrain: null,
      resolveDone,
      done,
      redactor: createStreamRedactor({ cwd: workspaceKey, delay: redactionDelay }),
    }
    runs.set(id, run)

    write(run, { type: 'start', runId: id, repository: pull.repository, number: pull.number })

    const limit = (message) => stop(run, { type: 'limit', message })
    const decoder = createLineDecoder({
      maximum: lineLimit,
      onLimit: () => limit('Claude Code exceeded the per-line output limit.'),
      onLine: (line) => {
        for (const event of eventsForClaudeLine(line, workspaceKey)) {
          if (event.type === 'error') {
            stop(run, event)
          } else if (event.type === 'text') {
            const text = run.redactor.push(event.text)
            if (text) write(run, { ...event, text })
          } else {
            flushText(run)
            write(run, event)
          }
        }
      },
    })
    const diagnostics = createLineDecoder({
      maximum: lineLimit,
      onLimit: () => limit('Claude Code exceeded the per-line output limit.'),
      onLine: (line) => {
        if (line) write(run, { type: 'diagnostic', text: cleanText(line, workspaceKey) })
      },
    })

    const consume = (target) => (chunk) => {
      if (run.terminal) return
      run.output += chunk.byteLength
      if (run.output > outputLimit) {
        limit('Claude Code exceeded the total output limit.')
        return
      }
      target.push(chunk)
    }
    child.stdout?.on('data', consume(decoder))
    child.stderr?.on('data', consume(diagnostics))
    child.stdout?.once('end', () => decoder.end())
    child.stderr?.once('end', () => diagnostics.end())
    child.once('error', () => {
      stop(run, { type: 'error', message: 'Claude Code could not be started.' })
      cleanup(run)
    })
    child.once('close', (code, signal) => {
      if (!run.terminal) {
        if (code === 0) {
          write(run, { type: 'complete', exitCode: 0 })
        } else {
          write(run, {
            type: 'error',
            message: signal ? 'Claude Code was terminated unexpectedly.' : 'Claude Code exited with an error.',
          })
        }
      }
      cleanup(run)
    })

    run.removeClose = channel.onClose?.(() => {
      if (!run.closed) stop(run, { type: 'cancelled', message: 'The client disconnected.' })
    })
    run.runtimeTimer = setTimer(
      () => stop(run, { type: 'limit', message: 'Claude Code exceeded the run time limit.' }),
      runtime,
    )
    run.runtimeTimer.unref?.()
    return { id, done }
  }

  function cancel(id) {
    const run = runs.get(id)
    if (run && !run.closed) {
      stop(run, { type: 'cancelled', message: 'Run cancelled.' })
    }
  }

  async function shutdown() {
    if (stopping) return
    stopping = true
    const active = [...runs.values()]
    for (const run of active) {
      stop(run, { type: 'cancelled', message: 'Server shutting down.' })
    }
    await Promise.all(active.map((run) => Promise.race([
      run.done,
      new Promise((resolve) => {
        const timer = setTimer(resolve, killGrace * 2)
        timer.unref?.()
      }),
    ])))
  }

  return {
    start,
    cancel,
    shutdown,
    activeCount: () => runs.size,
    activeWorkspaceCount: () => workspaces.size,
  }
}

export function actionError(error) {
  if (error instanceof ActionError || error instanceof WorkspaceError) {
    return error
  }
  return new ActionError(500, 'run_failed', 'The Claude Code run could not be started.')
}
