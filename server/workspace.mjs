import { execFile as executeFile } from 'node:child_process'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(executeFile)
const GITHUB = 'github.com'

export class WorkspaceError extends Error {
  constructor(message, code = 'workspace_unavailable') {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    this.status = 409
  }
}

function isInside(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function normalizeRepository(repository) {
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  ) {
    return null
  }
  return repository.replace(/\.git$/i, '').toLowerCase()
}

export function repositoryFromOrigin(origin) {
  if (typeof origin !== 'string') {
    return null
  }

  const trimmed = origin.trim()
  const scp = /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(trimmed)
  if (scp) {
    return normalizeRepository(scp[1])
  }

  try {
    const url = new URL(trimmed)
    if (
      url.hostname.toLowerCase() !== GITHUB ||
      (url.protocol !== 'https:' && url.protocol !== 'ssh:')
    ) {
      return null
    }
    return normalizeRepository(url.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
}

function splitRoots(value, home = homedir()) {
  const configured = value
    ? value.split(delimiter).filter(Boolean)
    : [join(home, 'Local'), join(home, '.codex', 'worktrees')]

  return configured.map((path) => resolve(path))
}

export function resolveWorkspaceOptions(environment = process.env, home = homedir()) {
  return {
    roots: splitRoots(environment.ACTION_WORKSPACE_ROOTS, home),
  }
}

async function command(run, cwd, args) {
  try {
    const result = await run('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    return String(result.stdout ?? '').trim()
  } catch {
    return null
  }
}

async function hasGitMarker(path) {
  try {
    const marker = await lstat(join(path, '.git'))
    if (marker.isDirectory()) {
      return true
    }
    if (!marker.isFile()) {
      return false
    }
    const content = await readFile(join(path, '.git'), 'utf8')
    return /^gitdir:\s*.+/m.test(content)
  } catch {
    return false
  }
}

async function discover(root) {
  const found = []
  const pending = [root]

  while (pending.length > 0) {
    const current = pending.pop()
    let marker = false
    try {
      marker = await hasGitMarker(current)
    } catch {
      marker = false
    }
    if (marker) {
      found.push(current)
      continue
    }

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.git') {
        pending.push(join(current, entry.name))
      }
    }
  }

  return found
}

async function canonicalRoots(roots) {
  const canonical = []
  for (const root of roots) {
    try {
      canonical.push(await realpath(root))
    } catch {
      // Missing configured roots are ignored. A later error remains path-free.
    }
  }
  return canonical
}

async function inspectCandidate(run, roots, candidate) {
  const top = await command(run, candidate, ['rev-parse', '--show-toplevel'])
  if (!top) {
    return null
  }

  let cwd
  try {
    cwd = await realpath(top)
  } catch {
    return null
  }
  if (!roots.some((root) => isInside(root, cwd))) {
    return null
  }

  const origin = await command(run, cwd, ['config', '--get', 'remote.origin.url'])
  const head = await command(run, cwd, ['rev-parse', 'HEAD'])
  const status = await command(run, cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (!origin || !/^[a-f0-9]{40}$/i.test(head ?? '') || status === null) {
    return null
  }

  return {
    cwd,
    repository: repositoryFromOrigin(origin),
    head: head.toLowerCase(),
    clean: status === '',
  }
}

export function createWorkspaceResolver({
  roots = resolveWorkspaceOptions().roots,
  run = execFile,
  discoverRepositories = discover,
} = {}) {
  const associations = new Map()

  async function inspectAssociated(association, repository) {
    const canonical = await canonicalRoots(roots)
    if (canonical.length === 0 || !canonical.some((root) => isInside(root, association.cwd))) {
      return null
    }
    const candidate = await inspectCandidate(run, canonical, association.cwd)
    if (!candidate || candidate.repository !== repository) {
      return null
    }
    return candidate
  }

  return {
    async resolve({ repository, number, expectedHeadRefOid }) {
      const normalized = normalizeRepository(repository)
      const expected = String(expectedHeadRefOid).toLowerCase()
      const key = `${normalized}#${number}`
      const association = associations.get(key)

      if (association) {
        if (association.remoteHead !== expected) {
          associations.delete(key)
        } else {
          const current = await inspectAssociated(association, normalized)
          if (current) {
            return current.cwd
          }
          associations.delete(key)
        }
      }

      const canonical = await canonicalRoots(roots)
      if (canonical.length === 0) {
        throw new WorkspaceError('No trusted workspace roots are available.')
      }

      const paths = new Set()
      for (const root of canonical) {
        for (const candidate of await discoverRepositories(root)) {
          paths.add(candidate)
        }
      }

      const inspected = []
      for (const path of paths) {
        const candidate = await inspectCandidate(run, canonical, path)
        if (candidate?.repository === normalized) {
          inspected.push(candidate)
        }
      }

      const eligible = inspected.filter((candidate) => candidate.head === expected && candidate.clean)
      const unique = new Map(eligible.map((candidate) => [candidate.cwd, candidate]))
      if (unique.size > 1) {
        throw new WorkspaceError('More than one clean matching worktree was found.', 'workspace_ambiguous')
      }
      if (unique.size === 0) {
        if (inspected.some((candidate) => candidate.head === expected && !candidate.clean)) {
          throw new WorkspaceError('The matching worktree has uncommitted changes.', 'workspace_dirty')
        }
        if (inspected.length > 0) {
          throw new WorkspaceError('No clean worktree is checked out at the current pull request head.', 'workspace_head_mismatch')
        }
        throw new WorkspaceError('No trusted local worktree matches this repository.', 'workspace_missing')
      }

      const selected = [...unique.values()][0]
      associations.set(key, { cwd: selected.cwd, remoteHead: expected })
      return selected.cwd
    },

    clear({ repository, number }) {
      associations.delete(`${normalizeRepository(repository)}#${number}`)
    },
  }
}
