import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createWorkspaceResolver,
  repositoryFromOrigin,
  resolveWorkspaceOptions,
} from '../workspace.mjs'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const temporary = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(name = 'root') {
  const base = await mkdtemp(join(tmpdir(), 'pull-workspace-'))
  temporary.push(base)
  const path = join(base, name)
  await mkdir(path, { recursive: true })
  return { base: await realpath(base), path: await realpath(path) }
}

function gitRunner(states) {
  return vi.fn(async (_git, args) => {
    const cwd = args[1]
    const command = args.slice(2).join(' ')
    const state = states.get(cwd)
    const values = {
      'rev-parse --show-toplevel': state?.top ?? cwd,
      'config --get remote.origin.url': state?.origin,
      'rev-parse HEAD': state?.head,
      'status --porcelain=v1 --untracked-files=all': state?.status ?? '',
    }
    if (values[command] === undefined) throw new Error('git failed')
    return { stdout: `${values[command]}\n`, stderr: '' }
  })
}

describe('workspace resolution', () => {
  it('normalizes exact GitHub origins case-insensitively', () => {
    expect(repositoryFromOrigin('git@github.com:Owner/Repo.git')).toBe('owner/repo')
    expect(repositoryFromOrigin('https://github.com/OWNER/Repo.git')).toBe('owner/repo')
    expect(repositoryFromOrigin('ssh://git@github.com/Owner/Repo.git')).toBe('owner/repo')
    expect(repositoryFromOrigin('https://example.com/owner/repo')).toBeNull()
    expect(repositoryFromOrigin('file://github.com/owner/repo')).toBeNull()
    expect(repositoryFromOrigin('https://github.com/owner/repo/extra')).toBeNull()
  })

  it('uses the documented environment-shaped roots option', () => {
    expect(resolveWorkspaceOptions({ ACTION_WORKSPACE_ROOTS: '/one:/two' }, '/home/test')).toEqual({
      roots: ['/one', '/two'],
    })
    expect(resolveWorkspaceOptions({}, '/home/test')).toEqual({
      roots: ['/home/test/Local', '/home/test/.codex/worktrees'],
    })
  })

  it('selects one clean exact-head normal repo or git-file worktree', async () => {
    const { path: root } = await directory()
    const repo = join(root, 'repo')
    await mkdir(repo)
    const states = new Map([[repo, {
      top: repo,
      origin: 'git@github.com:Owner/Repo.git',
      head: SHA,
      status: '',
    }]])
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
      discoverRepositories: vi.fn(async () => [repo]),
    })

    await expect(resolver.resolve({
      repository: 'owner/repo', number: 7, expectedHeadRefOid: SHA,
    })).resolves.toBe(repo)

    // The retained association permits a follow-up run after the first run changed local state.
    states.get(repo).head = '1234567890abcdef1234567890abcdef12345678'
    states.get(repo).status = ' M source.js'
    await expect(resolver.resolve({
      repository: 'OWNER/REPO', number: 7, expectedHeadRefOid: SHA,
    })).resolves.toBe(repo)
  })

  it('discovers a git-file worktree under a canonical trusted root', async () => {
    const { path: root } = await directory()
    const worktree = join(root, 'group', 'worktree')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: /trusted/common/worktrees/repo\n')
    const states = new Map([[worktree, {
      top: worktree,
      origin: 'https://github.com/owner/repo.git',
      head: SHA,
      status: '',
    }]])
    const resolver = createWorkspaceResolver({ roots: [root], run: gitRunner(states) })

    await expect(resolver.resolve({
      repository: 'owner/repo', number: 7, expectedHeadRefOid: SHA,
    })).resolves.toBe(worktree)
  })

  it('clears an association when the refreshed remote head changes', async () => {
    const { path: root } = await directory()
    const repo = join(root, 'repo')
    await mkdir(repo)
    const states = new Map([[repo, {
      top: repo, origin: 'https://github.com/owner/repo', head: SHA, status: '',
    }]])
    const resolver = createWorkspaceResolver({
      roots: [root], run: gitRunner(states), discoverRepositories: async () => [repo],
    })
    await resolver.resolve({ repository: 'owner/repo', number: 1, expectedHeadRefOid: SHA })
    states.get(repo).status = ' M local.php'

    await expect(resolver.resolve({
      repository: 'owner/repo',
      number: 1,
      expectedHeadRefOid: '1234567890abcdef1234567890abcdef12345678',
    })).rejects.toMatchObject({ code: 'workspace_head_mismatch' })
  })

  it('rejects ambiguity, dirty exact heads, wrong heads, and root escapes', async () => {
    const { base, path: root } = await directory()
    const first = join(root, 'first')
    const second = join(root, 'second')
    const outside = join(base, 'outside')
    await Promise.all([mkdir(first), mkdir(second), mkdir(outside)])
    const states = new Map([
      [first, { top: first, origin: 'https://github.com/o/r', head: SHA, status: '' }],
      [second, { top: second, origin: 'git@github.com:o/r.git', head: SHA, status: '' }],
      [outside, { top: outside, origin: 'https://github.com/o/r', head: SHA, status: '' }],
    ])
    const candidates = [first, second, outside]
    const resolver = createWorkspaceResolver({
      roots: [root], run: gitRunner(states), discoverRepositories: async () => candidates,
    })
    await expect(resolver.resolve({ repository: 'o/r', number: 1, expectedHeadRefOid: SHA }))
      .rejects.toMatchObject({ code: 'workspace_ambiguous' })

    states.get(second).status = '?? new.txt'
    states.get(first).status = ' M tracked.txt'
    await expect(resolver.resolve({ repository: 'o/r', number: 2, expectedHeadRefOid: SHA }))
      .rejects.toMatchObject({ code: 'workspace_dirty' })

    states.get(first).status = ''
    states.get(second).status = ''
    states.get(first).head = '1234567890abcdef1234567890abcdef12345678'
    states.get(second).head = states.get(first).head
    await expect(resolver.resolve({ repository: 'o/r', number: 3, expectedHeadRefOid: SHA }))
      .rejects.toMatchObject({ code: 'workspace_head_mismatch' })
  })
})
