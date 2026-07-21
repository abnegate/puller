import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  buildPrompt,
  claudeArguments,
  createClaudeRunManager,
  createLineDecoder,
  createStreamRedactor,
  validateRunInput,
} from '../claude.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'

function pull(overrides = {}) {
  return {
    repository: 'owner/repo',
    number: 7,
    url: 'https://github.com/owner/repo/pull/7',
    headRefOid: SHA,
    ready: false,
    blockers: ['1 unresolved review thread'],
    ...overrides,
  }
}

function snapshot(item = pull(), overrides = {}) {
  return {
    stale: false,
    partial: false,
    ready: item?.ready ? [item] : [],
    notReady: item && !item.ready ? [item] : [],
    ...overrides,
  }
}

function fakeChild(pid = 100) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  return child
}

function channel({ blockFirst = false } = {}) {
  const events = []
  let close
  let drain
  let writes = 0
  return {
    events,
    value: {
      write(event) {
        events.push(event)
        writes += 1
        return !(blockFirst && writes === 1)
      },
      onceDrain(listener) {
        drain = listener
        return () => { drain = null }
      },
      onClose(listener) {
        close = listener
        return () => { close = null }
      },
      closed: () => false,
    },
    close: () => close?.(),
    drain: () => drain?.(),
  }
}

function manager(overrides = {}) {
  const child = overrides.child ?? fakeChild()
  const spawn = overrides.spawn ?? vi.fn(() => child)
  const cache = overrides.cache ?? { get: vi.fn(async () => snapshot()) }
  const resolver = overrides.resolver ?? { resolve: vi.fn(async () => '/trusted/workspace') }
  const kill = overrides.kill ?? vi.fn()
  const value = createClaudeRunManager({
    cache,
    resolver,
    spawn,
    kill,
    createId: () => 'run-1',
    runtime: 60_000,
    killGrace: 10,
    canonicalize: async (cwd) => cwd,
    ...overrides,
  })
  return { value, child, spawn, cache, resolver, kill }
}

const input = {
  repository: 'owner/repo',
  number: 7,
  expectedHeadRefOid: SHA,
  message: 'Resolve the remaining review thread.',
}

describe('Claude Code request and parser', () => {
  it('uses the verified fixed one-shot argument surface', () => {
    const prompt = buildPrompt(pull(), 'Fix it')
    expect(prompt).toContain('https://github.com/owner/repo/pull/7')
    expect(prompt).toContain(SHA)
    expect(prompt).toContain('1 unresolved review thread')
    expect(claudeArguments(prompt)).toEqual([
      '--print', '--output-format', 'stream-json', '--include-partial-messages',
      '--permission-mode', 'auto', '--no-session-persistence', '--', prompt,
    ])
    expect(claudeArguments(prompt)).not.toContain('--from-pr')
    expect(claudeArguments(prompt)).not.toContain('--dangerously-skip-permissions')
  })

  it('redacts workspace paths and secrets split across adjacent deltas', () => {
    const redactor = createStreamRedactor({ cwd: '/trusted/workspace', delay: 16 })
    const output = [
      redactor.push(`${'safe '.repeat(8)}Edited /trusted/work`),
      redactor.push('space/src/a.js using ghp_abcdef'),
      redactor.push('ghijklmnop'),
      redactor.flush(),
    ].join('')

    expect(output).toContain('safe safe')
    expect(output).toContain('Edited [workspace]/src/a.js using [secret]')
    expect(output).not.toContain('/trusted/workspace')
    expect(output).not.toContain('ghp_abcdefghijklmnop')
  })

  it('validates message byte limits and immutable identity fields', () => {
    expect(validateRunInput(input)).toEqual(input)
    expect(() => validateRunInput({ ...input, repository: '../repo' })).toThrow('repository')
    expect(() => validateRunInput({ ...input, number: 0 })).toThrow('number')
    expect(() => validateRunInput({ ...input, expectedHeadRefOid: 'short' })).toThrow('head')
    expect(() => validateRunInput({ ...input, message: 'é'.repeat(20_000) })).toThrow('32 KiB')
  })

  it('decodes chunk-split lines and caps an unterminated source line', () => {
    const lines = []
    const limited = vi.fn()
    const decoder = createLineDecoder({ maximum: 8, onLine: (line) => lines.push(line), onLimit: limited })
    decoder.push(Buffer.from('one\nt'))
    decoder.push(Buffer.from('wo\n'))
    decoder.end()
    expect(lines).toEqual(['one', 'two'])
    decoder.push(Buffer.from('ignored'))

    const oversized = createLineDecoder({ maximum: 3, onLine: vi.fn(), onLimit: limited })
    oversized.push(Buffer.from('four'))
    expect(limited).toHaveBeenCalledOnce()
  })
})

describe('Claude Code run manager', () => {
  it('refreshes GitHub, resolves locally, spawns shell-free, and normalizes streaming events', async () => {
    const context = manager()
    const output = channel()
    const run = await context.value.start(input, output.value)

    expect(context.cache.get).toHaveBeenCalledWith({ refresh: true })
    expect(context.resolver.resolve).toHaveBeenCalledWith(input)
    expect(context.spawn).toHaveBeenCalledOnce()
    expect(context.spawn.mock.calls[0][0]).toBe('claude')
    expect(context.spawn.mock.calls[0][2]).toMatchObject({
      cwd: '/trusted/workspace', detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output.events[0]).toEqual({
      type: 'start', runId: 'run-1', repository: 'owner/repo', number: 7,
    })

    context.child.stdout.write('{"type":"system","subtype":"init"}\n')
    context.child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Edited /trusted/workspace/src/a.js ghp_abcdefghijklmnop"}}}\n')
    context.child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"duplicate"}]}}\n')
    context.child.stdout.write('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Edit"}}}\n')
    context.child.stdout.write('{"type":"result","subtype":"success","is_error":false}\n')
    context.child.emit('close', 0, null)
    await run.done

    expect(output.events).toEqual([
      { type: 'start', runId: 'run-1', repository: 'owner/repo', number: 7 },
      { type: 'diagnostic', text: 'Claude Code started.' },
      { type: 'text', text: 'Edited [workspace]/src/a.js [secret]' },
      { type: 'tool', name: 'Edit', status: 'started' },
      { type: 'complete', exitCode: 0 },
    ])
    expect(context.value.activeCount()).toBe(0)
    expect(context.value.activeWorkspaceCount()).toBe(0)
  })

  it.each([
    ['stale snapshots', snapshot(pull(), { stale: true }), 'snapshot_incomplete'],
    ['partial snapshots', snapshot(pull(), { partial: true }), 'snapshot_incomplete'],
    ['ready pulls', snapshot(pull({ ready: true })), 'pull_ready'],
    ['missing pulls', snapshot(null, { ready: [], notReady: [] }), 'pull_missing'],
  ])('rejects %s before resolving or spawning', async (_name, data, code) => {
    const context = manager({ cache: { get: vi.fn(async () => data) } })
    await expect(context.value.start(input, channel().value)).rejects.toMatchObject({ code })
    expect(context.resolver.resolve).not.toHaveBeenCalled()
    expect(context.spawn).not.toHaveBeenCalled()
  })

  it('rejects head drift and keeps URL, head, and blockers server-authored', async () => {
    const current = pull({ headRefOid: '1234567890abcdef1234567890abcdef12345678' })
    const context = manager({ cache: { get: vi.fn(async () => snapshot(current)) } })
    await expect(context.value.start(input, channel().value)).rejects.toMatchObject({ code: 'head_changed' })
    expect(context.spawn).not.toHaveBeenCalled()
  })

  it('enforces one run per pull and two globally across pending validation', async () => {
    let release
    const waiting = new Promise((resolve) => { release = resolve })
    const cache = { get: vi.fn(async () => { await waiting; return snapshot() }) }
    const context = manager({ cache })
    const first = context.value.start(input, channel().value)
    await Promise.resolve()
    await expect(context.value.start(input, channel().value)).rejects.toMatchObject({ code: 'pull_running' })
    const secondInput = { ...input, repository: 'other/repo', number: 8 }
    const second = context.value.start(secondInput, channel().value)
    await Promise.resolve()
    await expect(context.value.start({ ...input, repository: 'third/repo', number: 9 }, channel().value))
      .rejects.toMatchObject({ code: 'run_limit' })
    release()
    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toMatchObject({ code: 'pull_missing' })
    context.child.emit('close', 0, null)
  })

  it('reserves the canonical worktree across different pull requests until process exit', async () => {
    const secondInput = { ...input, repository: 'other/repo', number: 8 }
    const firstPull = pull()
    const secondPull = pull({ repository: 'other/repo', number: 8, url: 'https://github.com/other/repo/pull/8' })
    const children = [fakeChild(101), fakeChild(102)]
    const spawn = vi.fn(() => children.shift())
    const cache = {
      get: vi.fn(async () => snapshot(null, { ready: [], notReady: [firstPull, secondPull] })),
    }
    const resolver = {
      resolve: vi.fn(async ({ repository }) => repository === 'owner/repo' ? '/alias/one' : '/alias/two'),
    }
    const context = manager({
      cache,
      resolver,
      spawn,
      canonicalize: vi.fn(async () => '/canonical/shared'),
    })

    const first = await context.value.start(input, channel().value)
    expect(context.value.activeWorkspaceCount()).toBe(1)
    await expect(context.value.start(secondInput, channel().value)).rejects.toMatchObject({
      code: 'workspace_running',
    })
    expect(spawn).toHaveBeenCalledOnce()

    const firstChild = spawn.mock.results[0].value
    firstChild.emit('close', 0, null)
    await first.done
    expect(context.value.activeWorkspaceCount()).toBe(0)

    const second = await context.value.start(secondInput, channel().value)
    expect(spawn).toHaveBeenCalledTimes(2)
    const secondChild = spawn.mock.results[1].value
    secondChild.emit('close', 0, null)
    await second.done
    expect(context.value.activeWorkspaceCount()).toBe(0)
  })

  it('makes concurrent canonical workspace reservation atomic and releases spawn failures', async () => {
    const secondInput = { ...input, repository: 'other/repo', number: 8 }
    const firstPull = pull()
    const secondPull = pull({ repository: 'other/repo', number: 8, url: 'https://github.com/other/repo/pull/8' })
    const cache = {
      get: vi.fn(async () => snapshot(null, { ready: [], notReady: [firstPull, secondPull] })),
    }
    const resolver = { resolve: vi.fn(async () => '/same/workspace') }
    const child = fakeChild(103)
    const spawn = vi.fn()
      .mockImplementationOnce(() => child)
      .mockImplementationOnce(() => { throw new Error('spawn failed') })
      .mockImplementationOnce(() => fakeChild(104))
    const context = manager({ cache, resolver, spawn })

    const settled = await Promise.allSettled([
      context.value.start(input, channel().value),
      context.value.start(secondInput, channel().value),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(({ status }) => status === 'rejected')[0].reason).toMatchObject({
      code: 'workspace_running',
    })
    expect(context.value.activeWorkspaceCount()).toBe(1)

    child.emit('close', 0, null)
    await settled.find(({ status }) => status === 'fulfilled').value.done
    await expect(context.value.start(secondInput, channel().value)).rejects.toThrow('spawn failed')
    expect(context.value.activeWorkspaceCount()).toBe(0)

    const retry = await context.value.start(secondInput, channel().value)
    expect(context.value.activeWorkspaceCount()).toBe(1)
    spawn.mock.results.at(-1).value.emit('close', 0, null)
    await retry.done
    expect(context.value.activeWorkspaceCount()).toBe(0)
  })

  it('redacts adjacent assistant deltas before streaming them to the browser', async () => {
    const context = manager({ redactionDelay: 24 })
    const output = channel()
    const run = await context.value.start(input, output.value)
    const delta = (text) => `${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    })}\n`

    context.child.stdout.write(delta(`${'visible '.repeat(8)}/trusted/work`))
    context.child.stdout.write(delta('space/src/index.js ghp_abcdef'))
    context.child.stdout.write(delta('ghijklmnop'))
    expect(output.events.some(({ type }) => type === 'text')).toBe(true)
    context.child.emit('close', 0, null)
    await run.done

    const text = output.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('')
    expect(text).toContain('[workspace]/src/index.js [secret]')
    expect(text).not.toContain('/trusted/workspace')
    expect(text).not.toContain('ghp_abcdefghijklmnop')
  })

  it('pauses both streams for response backpressure and resumes on drain', async () => {
    const context = manager()
    const output = channel({ blockFirst: true })
    await context.value.start(input, output.value)
    expect(context.child.stdout.isPaused()).toBe(true)
    expect(context.child.stderr.isPaused()).toBe(true)
    output.drain()
    expect(context.child.stdout.isPaused()).toBe(false)
    context.child.emit('close', 0, null)
  })

  it('cancels disconnects idempotently with one terminal event and a process-group signal', async () => {
    const context = manager()
    const output = channel()
    const run = await context.value.start(input, output.value)
    output.close()
    context.value.cancel('run-1')
    context.value.cancel('missing')
    expect(output.events.filter(({ type }) => type === 'cancelled')).toHaveLength(1)
    expect(context.kill).toHaveBeenCalledWith(-100, 'SIGTERM')
    context.child.emit('close', null, 'SIGTERM')
    await run.done
    expect(context.value.activeCount()).toBe(0)
    expect(context.value.activeWorkspaceCount()).toBe(0)
  })

  it('terminates on raw output and line limits, then shuts down without active runs', async () => {
    const first = manager({ outputLimit: 4 })
    const output = channel()
    const run = await first.value.start(input, output.value)
    first.child.stdout.write('12345')
    expect(output.events.at(-1)).toMatchObject({ type: 'limit' })
    first.child.emit('close', null, 'SIGTERM')
    await run.done

    const second = manager({ lineLimit: 3 })
    const secondOutput = channel()
    const secondRun = await second.value.start(input, secondOutput.value)
    second.child.stdout.write('four')
    expect(secondOutput.events.at(-1)).toMatchObject({ type: 'limit' })
    const shutdown = second.value.shutdown()
    second.child.emit('close', null, 'SIGTERM')
    await Promise.all([secondRun.done, shutdown])
    expect(second.value.activeCount()).toBe(0)
  })
})
