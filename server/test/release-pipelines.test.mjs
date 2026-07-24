import { describe, expect, it, vi } from 'vitest'

import {
  loadReleasePipelines,
  normalizePipelineState,
} from '../release-pipelines.mjs'

const NOW = Date.parse('2026-07-24T05:00:00.000Z')

function release({
  id = '10',
  publishedAt = '2026-07-24T04:37:50.000Z',
  repository = 'appwrite-labs/cloud',
  tag = '1.43.8',
} = {}) {
  return { id, publishedAt, repository, tag }
}

function run({
  attempt = 1,
  conclusion = 'success',
  createdAt = '2026-07-24T04:37:59.000Z',
  headBranch = '1.43.8',
  id = 30067297377,
  name = 'Production Deployment',
  repository = 'appwrite-labs/cloud',
  status = 'completed',
  updatedAt = '2026-07-24T04:43:24.000Z',
  workflowId = 9876,
} = {}) {
  return {
    conclusion,
    created_at: createdAt,
    event: 'release',
    head_branch: headBranch,
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    id,
    name,
    path: '.github/workflows/production.yml',
    repository: { full_name: repository },
    run_attempt: attempt,
    run_started_at: createdAt,
    status,
    updated_at: updatedAt,
    workflow_id: workflowId,
  }
}

function page(workflowRuns, totalCount = workflowRuns.length) {
  return { total_count: totalCount, workflow_runs: workflowRuns }
}

describe('release pipelines', () => {
  it.each([
    ['requested', null, 'queued'],
    ['waiting', null, 'queued'],
    ['pending', null, 'queued'],
    ['queued', null, 'queued'],
    ['in_progress', null, 'running'],
    ['completed', 'success', 'succeeded'],
    ['completed', 'failure', 'failed'],
    ['completed', 'startup_failure', 'failed'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'timed_out', 'timed-out'],
    ['completed', 'action_required', 'action-required'],
    ['completed', 'neutral', 'neutral'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'stale', 'stale'],
    ['completed', null, 'unknown'],
    ['unexpected', null, 'unknown'],
  ])('normalizes %s/%s to %s', (status, conclusion, expected) => {
    expect(normalizePipelineState(status, conclusion)).toBe(expected)
  })

  it('loads release-event runs once per repository and maps exact tags and publication time', async () => {
    const executor = {
      rest: vi.fn(async () => page([
        run(),
        run({ headBranch: '1.43.80', id: 30067297378, workflowId: 9877 }),
        run({
          createdAt: '2026-07-24T04:00:00.000Z',
          id: 30067297379,
          workflowId: 9878,
        }),
      ])),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [
        release(),
        release({ id: '11', tag: '1.43.9' }),
      ],
    })

    expect(executor.rest).toHaveBeenCalledOnce()
    expect(executor.rest.mock.calls[0][0]).toContain(
      'repos/appwrite-labs/cloud/actions/runs?',
    )
    expect(executor.rest.mock.calls[0][0]).toContain('event=release')
    expect(executor.rest.mock.calls[0][0]).not.toContain('branch=')
    expect(result.releases).toEqual([
      {
        id: '10',
        pipeline: {
          checkedAt: '2026-07-24T05:00:00.000Z',
          lookup: 'complete',
          runs: [
            {
              attempt: 1,
              createdAt: '2026-07-24T04:37:59.000Z',
              id: '30067297377',
              name: 'Production Deployment',
              path: '.github/workflows/production.yml',
              startedAt: '2026-07-24T04:37:59.000Z',
              state: 'succeeded',
              updatedAt: '2026-07-24T04:43:24.000Z',
              url: 'https://github.com/appwrite-labs/cloud/actions/runs/30067297377',
              workflowId: '9876',
            },
          ],
        },
        publishedAt: '2026-07-24T04:37:50.000Z',
        repository: 'appwrite-labs/cloud',
        tag: '1.43.8',
      },
      {
        id: '11',
        pipeline: {
          checkedAt: '2026-07-24T05:00:00.000Z',
          lookup: 'complete',
          runs: [],
        },
        publishedAt: '2026-07-24T04:37:50.000Z',
        repository: 'appwrite-labs/cloud',
        tag: '1.43.9',
      },
    ])
  })

  it('bounds broad reads to seven days and narrowly discovers reruns for older releases', async () => {
    const older = release({
      id: '11',
      publishedAt: '2026-07-01T00:00:00.000Z',
      tag: '1.40.0',
    })
    const rerun = run({
      attempt: 2,
      conclusion: null,
      createdAt: '2026-07-01T00:00:01.000Z',
      headBranch: older.tag,
      id: 30067297000,
      status: 'in_progress',
      updatedAt: '2026-07-24T04:55:00.000Z',
    })
    const executor = {
      rest: vi.fn(async (endpoint) => {
        const query = new URL(endpoint, 'https://api.github.com/').searchParams
        const branch = query.get('branch')
        if (branch === null) return page([run()])
        if (branch === older.tag) return page([rerun])
        throw new Error(`Unexpected branch ${branch}`)
      }),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      previous: [{
        ...older,
        pipeline: {
          checkedAt: '2026-07-01T00:05:00.000Z',
          lookup: 'complete',
          runs: [{
            attempt: 1,
            createdAt: rerun.created_at,
            id: String(rerun.id),
            name: rerun.name,
            path: rerun.path,
            startedAt: rerun.run_started_at,
            state: 'succeeded',
            updatedAt: '2026-07-01T00:05:00.000Z',
            url: rerun.html_url,
            workflowId: String(rerun.workflow_id),
          }],
        },
      }],
      releases: [release(), older],
    })

    expect(executor.rest).toHaveBeenCalledTimes(2)
    const [broad, exact] = executor.rest.mock.calls.map(([endpoint]) =>
      new URL(endpoint, 'https://api.github.com/'))
    expect(broad.searchParams.get('created')).toBe(
      '>=2026-07-17T05:00:00.000Z',
    )
    expect(broad.searchParams.get('branch')).toBeNull()
    expect(exact.searchParams.get('created')).toBe(`>=${older.publishedAt}`)
    expect(exact.searchParams.get('branch')).toBe(older.tag)
    expect(result.releases[1].pipeline.runs).toEqual([
      expect.objectContaining({
        attempt: 2,
        id: '30067297000',
        state: 'running',
      }),
    ])
  })

  it.each([
    [
      'repository identity',
      () => {
        const value = run()
        value.repository.full_name = 'Appwrite-Labs/cloud'
        return value
      },
    ],
    [
      'Actions run URL path',
      () => ({
        ...run(),
        html_url:
          'https://github.com/Appwrite-Labs/cloud/actions/runs/30067297377',
      }),
    ],
  ])('rejects case-variant %s evidence', async (_label, createRun) => {
    const result = await loadReleasePipelines({
      executor: { rest: vi.fn(async () => page([createRun()])) },
      now: () => NOW,
      releases: [release()],
    })

    expect(result.releases[0].pipeline).toEqual({
      checkedAt: '2026-07-24T05:00:00.000Z',
      lookup: 'unavailable',
      runs: [],
    })
  })

  it('does not share pipeline evidence across case-variant release repositories', async () => {
    const executor = {
      rest: vi.fn(async () => page([run()])),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [
        release(),
        release({
          id: '11',
          repository: 'Appwrite-Labs/cloud',
        }),
      ],
    })

    expect(executor.rest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      expect.stringContaining('repos/appwrite-labs/cloud/actions/runs?'),
      expect.stringContaining('repos/Appwrite-Labs/cloud/actions/runs?'),
    ])
    expect(result.releases.map(({ pipeline }) => pipeline.lookup)).toEqual([
      'complete',
      'unavailable',
    ])
    expect(result.releases.map(({ pipeline }) => pipeline.runs.length)).toEqual([
      1,
      0,
    ])
  })

  it('fully paginates repository runs and keeps only the newest run for each workflow', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      run({
        createdAt: `2026-07-24T04:${String(index % 60).padStart(2, '0')}:00.000Z`,
        id: 1000 + index,
        workflowId: 2000 + index,
      }))
    const second = [
      run({
        attempt: 3,
        createdAt: '2026-07-24T04:50:00.000Z',
        id: 5000,
        workflowId: 9876,
      }),
      run({
        attempt: 1,
        createdAt: '2026-07-24T04:55:00.000Z',
        id: 5001,
        workflowId: 9876,
      }),
    ]
    const executor = {
      rest: vi.fn(async (endpoint) =>
        /[?&]page=1(?:&|$)/.test(endpoint)
          ? page(first, 102)
          : page(second, 102)),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [release({ publishedAt: '2026-07-24T03:00:00.000Z' })],
    })

    expect(executor.rest).toHaveBeenCalledTimes(2)
    const deployment = result.releases[0].pipeline.runs.find(
      (value) => value.workflowId === '9876',
    )
    expect(deployment).toMatchObject({ attempt: 1, id: '5001' })
    expect(result.releases[0].pipeline.runs).toHaveLength(101)
  })

  it('keeps the newest observed attempt when the same run id is repeated', async () => {
    const executor = {
      rest: vi.fn(async () => page([
        run({ attempt: 1, id: 5000, updatedAt: '2026-07-24T04:40:00.000Z' }),
        run({ attempt: 2, id: 5000, updatedAt: '2026-07-24T04:45:00.000Z' }),
      ])),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [release()],
    })

    expect(result.releases[0].pipeline.runs).toEqual([
      expect.objectContaining({ attempt: 2, id: '5000' }),
    ])
  })

  it('falls back to exact tag queries after GitHub caps a broad filtered result', async () => {
    const executor = {
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes('branch=')) {
          return page(Array.from({ length: 100 }, (_, index) =>
            run({
              headBranch: `historical-${index}`,
              id: 10_000 + index,
              workflowId: 20_000 + index,
            })), 1001)
        }
        return endpoint.includes('branch=1.43.8')
          ? page([run()])
          : page([])
      }),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [
        release(),
        release({ id: '11', tag: '1.43.9' }),
      ],
    })

    expect(executor.rest).toHaveBeenCalledTimes(3)
    expect(result.releases.map(({ pipeline }) => pipeline.lookup)).toEqual([
      'complete',
      'complete',
    ])
    expect(result.releases.map(({ pipeline }) => pipeline.runs.length)).toEqual([
      1,
      0,
    ])
  })

  it('keeps a just-published release pending until its exact run appears', async () => {
    let visible = false
    const executor = {
      rest: vi.fn(async () => page(visible ? [run({
        createdAt: '2026-07-24T04:59:59.500Z',
        updatedAt: '2026-07-24T04:59:59.900Z',
      })] : [])),
    }
    const recent = release({
      publishedAt: '2026-07-24T04:59:59.000Z',
    })

    const pending = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [recent],
    })
    expect(pending.releases[0].pipeline).toEqual({
      checkedAt: '2026-07-24T05:00:00.000Z',
      lookup: 'pending',
      runs: [],
    })

    visible = true
    const discovered = await loadReleasePipelines({
      executor,
      now: () => NOW,
      previous: pending.releases,
      releases: [recent],
    })
    expect(discovered.releases[0].pipeline).toMatchObject({
      lookup: 'complete',
      runs: [expect.objectContaining({ id: '30067297377' })],
    })
  })

  it('settles old unmatched releases even when another tag has a workflow run', async () => {
    const executor = {
      rest: vi.fn(async () => page([
        run({ headBranch: '1.43.7' }),
      ])),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [release({ tag: '1.43.9' })],
    })

    expect(result.releases[0].pipeline).toEqual({
      checkedAt: '2026-07-24T05:00:00.000Z',
      lookup: 'complete',
      runs: [],
    })
  })

  it('uses the five-minute recent-release refresh boundary for discovery', async () => {
    const executor = { rest: vi.fn(async () => page([])) }
    const inside = new Date(NOW - 5 * 60 * 1_000 + 1).toISOString()
    const boundary = new Date(NOW - 5 * 60 * 1_000).toISOString()

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [
        release({ id: '10', publishedAt: inside }),
        release({ id: '11', publishedAt: boundary, tag: '1.43.9' }),
      ],
    })

    expect(result.releases.map(({ pipeline }) => pipeline.lookup)).toEqual([
      'pending',
      'complete',
    ])
  })

  it('falls back to exact tag queries when GitHub reports the filtered 1,000-result ceiling', async () => {
    const executor = {
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes('branch=')) {
          return page(Array.from({ length: 100 }, (_, index) =>
            run({
              headBranch: `historical-${index}`,
              id: 70_000 + index,
              workflowId: 80_000 + index,
            })), 1000)
        }
        return page([run()])
      }),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [release()],
    })

    expect(executor.rest).toHaveBeenCalledTimes(2)
    expect(executor.rest.mock.calls[1][0]).toContain('branch=1.43.8')
    expect(result.releases[0].pipeline.runs).toEqual([
      expect.objectContaining({ id: '30067297377' }),
    ])
  })

  it('distinguishes a repository without release workflows from unavailable evidence', async () => {
    const noWorkflow = await loadReleasePipelines({
      executor: { rest: vi.fn(async () => page([])) },
      now: () => NOW,
      releases: [release()],
    })
    expect(noWorkflow.releases[0].pipeline).toMatchObject({
      lookup: 'complete',
      runs: [],
    })

    const prior = {
      ...release(),
      pipeline: {
        checkedAt: '2026-07-24T04:45:00.000Z',
        lookup: 'complete',
        runs: [{
          attempt: 1,
          createdAt: '2026-07-24T04:37:59.000Z',
          id: '30067297377',
          name: 'Production Deployment',
          path: '.github/workflows/production.yml',
          startedAt: '2026-07-24T04:37:59.000Z',
          state: 'running',
          updatedAt: '2026-07-24T04:45:00.000Z',
          url: 'https://github.com/appwrite-labs/cloud/actions/runs/30067297377',
          workflowId: '9876',
        }],
      },
    }
    const unavailable = await loadReleasePipelines({
      executor: { rest: vi.fn(async () => { throw new Error('offline') }) },
      now: () => NOW,
      previous: [prior],
      releases: [release()],
    })
    expect(unavailable.releases[0].pipeline).toEqual({
      checkedAt: '2026-07-24T05:00:00.000Z',
      lookup: 'unavailable',
      runs: prior.pipeline.runs,
    })
  })

  it('marks malformed, changing, repeated, and exact-query overflow evidence unavailable', async () => {
    const previous = [{
      ...release(),
      pipeline: {
        checkedAt: '2026-07-24T04:00:00.000Z',
        lookup: 'complete',
        runs: [],
      },
    }]
    const malformed = run()
    malformed.event = 'push'
    const cases = [
      vi.fn(async () => page([malformed])),
      vi.fn(async (endpoint) =>
        /[?&]page=1(?:&|$)/.test(endpoint)
          ? page(Array.from({ length: 100 }, (_, index) =>
            run({ id: 1000 + index, workflowId: 2000 + index })), 101)
          : page([run({ id: 5000 })], 102)),
      vi.fn(async (endpoint) =>
        endpoint.includes('branch=')
          ? page(Array.from({ length: 100 }, (_, index) =>
            run({ id: 30_000 + index, workflowId: 40_000 + index })), 1001)
          : page(Array.from({ length: 100 }, (_, index) =>
            run({ id: 50_000 + index, workflowId: 60_000 + index })), 1001)),
    ]

    for (const rest of cases) {
      const result = await loadReleasePipelines({
        executor: { rest },
        now: () => NOW,
        previous,
        releases: [release()],
      })
      expect(result.releases[0].pipeline.lookup).toBe('unavailable')
    }
  })

  it('isolates repository failures and never borrows prior runs across identities', async () => {
    const other = release({
      id: '20',
      repository: 'owner/other',
      tag: 'v2.0.0',
    })
    const executor = {
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith('repos/owner/other/')) {
          return page([
            run({
              headBranch: 'v2.0.0',
              id: 6000,
              repository: 'owner/other',
              workflowId: 600,
            }),
          ])
        }
        throw new Error('cloud unavailable')
      }),
    }

    const result = await loadReleasePipelines({
      executor,
      now: () => NOW,
      previous: [{
        ...release({ tag: 'different' }),
        pipeline: {
          checkedAt: '2026-07-24T04:00:00.000Z',
          lookup: 'complete',
          runs: [run()],
        },
      }],
      releases: [release(), other],
    })

    expect(result.releases[0].pipeline).toMatchObject({
      lookup: 'unavailable',
      runs: [],
    })
    expect(result.releases[1].pipeline).toMatchObject({
      lookup: 'complete',
      runs: [expect.objectContaining({ id: '6000' })],
    })
  })

  it('rejects duplicate release identities before querying GitHub', async () => {
    const executor = { rest: vi.fn() }
    const item = release()

    await expect(loadReleasePipelines({
      executor,
      now: () => NOW,
      releases: [item, { ...item }],
    })).rejects.toThrow('must be unique')
    expect(executor.rest).not.toHaveBeenCalled()
  })
})
