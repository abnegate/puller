import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ActionError } from "../claude.mjs";
import { ExecutorError } from "../executor.mjs";
import {
  createReleaseService,
  loadVerificationContext,
  nextPatchTag,
  validateCreateReleaseInput,
  VERIFICATION_OMISSION_MARKER,
} from "../releases.mjs";

const NOW = Date.parse("2026-07-21T00:00:00Z");
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const TAG_SHA = "9999999999999999999999999999999999999999";
const BASE_RELEASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function releasePreview({
  baseTag = "v1.2.3",
  body = "## What’s Changed\n\nGenerated notes",
  name = "Generated v1.2.4",
  pulls = [],
  repository = "owner/repo",
  tag = "v1.2.4",
  targetOid = RELEASE_SHA,
} = {}) {
  const identity = {
    baseTag,
    body,
    name,
    pulls,
    repository,
    tag,
    targetOid,
  };
  return {
    ...identity,
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          baseTag,
          body,
          name,
          pulls: pulls.map(({ number, title, url }) => ({
            number,
            title,
            url,
          })),
          repository: repository.toLowerCase(),
          tag,
          targetOid: targetOid.toLowerCase(),
        }),
      )
      .digest("hex"),
  };
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function annotatedTagSha(fields) {
  const timestamp = Math.floor(Date.parse(fields.tagger.date) / 1_000);
  const content = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger.name} <${fields.tagger.email}> ${timestamp} +0000`,
    "",
    fields.message,
  ].join("\n");
  return createHash("sha1")
    .update(`tag ${Buffer.byteLength(content, "utf8")}\0`)
    .update(content)
    .digest("hex");
}

function openSnapshot(repositories = ["owner/repo"]) {
  return {
    partial: false,
    stale: false,
    viewerLogin: "viewer",
    ready: repositories.map((repository) => ({
      repository,
      repositoryUrl: `https://github.com/${repository}`,
    })),
    notReady: [],
  };
}

function search(items = []) {
  return { incomplete_results: false, items, total_count: items.length };
}

function release({
  id = 10,
  tag = "v1.2.4",
  published = "2026-07-20T00:00:00Z",
  body = "",
} = {}) {
  return {
    body,
    draft: false,
    html_url: `https://github.com/owner/repo/releases/tag/${tag}`,
    id,
    name: tag,
    published_at: published,
    tag_name: tag,
  };
}

function repositoryRelease(repository, options = {}) {
  const value = release(options);
  return {
    ...value,
    html_url: `https://github.com/${repository}/releases/tag/${value.tag_name}`,
  };
}

function releaseNode({
  body = "https://github.com/owner/repo/pull/7",
  created = "2026-07-20T00:00:00Z",
  databaseId = 10,
  draft = false,
  id = `RE_${databaseId}`,
  published = draft ? null : "2026-07-20T00:00:00Z",
  repository = "owner/repo",
  tag = "v1.2.4",
} = {}) {
  return {
    createdAt: created,
    databaseId,
    description: body,
    id,
    isDraft: draft,
    name: tag,
    publishedAt: published,
    repository: {
      nameWithOwner: repository,
      url: `https://github.com/${repository}`,
    },
    tagName: tag,
    url: `https://github.com/${repository}/releases/tag/${tag}`,
  };
}

function releaseConnection(
  nodes,
  { endCursor = null, hasNextPage = false, repository = "owner/repo" } = {},
) {
  return {
    repository: {
      nameWithOwner: repository,
      releases: {
        nodes,
        pageInfo: { endCursor, hasNextPage },
      },
    },
  };
}

function nonPipelineRestCalls(executor) {
  return executor.rest.mock.calls.filter(
    ([endpoint]) => !endpoint.includes("/actions/runs?"),
  );
}

function authoredPull(number = 7, overrides = {}) {
  return {
    base: {
      repo: {
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
      },
      sha: BASE_RELEASE_SHA,
    },
    changed_files: 1,
    head: { sha: SHA },
    html_url: `https://github.com/owner/repo/pull/${number}`,
    merge_commit_sha: SHA,
    merged: true,
    merged_at: "2026-07-19T00:00:00Z",
    number,
    state: "closed",
    title: "Released fix",
    user: { login: "viewer" },
    ...overrides,
  };
}

function repositoryPull(repository, number, viewerLogin = "viewer") {
  return authoredPull(number, {
    base: {
      repo: {
        full_name: repository,
        html_url: `https://github.com/${repository}`,
      },
      sha: BASE_RELEASE_SHA,
    },
    html_url: `https://github.com/${repository}/pull/${number}`,
    user: { login: viewerLogin },
  });
}

function graphqlPull(number = 7, repository = "owner/repo", overrides = {}) {
  return {
    author: { login: "viewer" },
    baseRefOid: BASE_RELEASE_SHA,
    headRefOid: SHA,
    mergeCommit: { oid: SHA },
    merged: true,
    mergedAt: "2026-07-19T00:00:00Z",
    number,
    repository: {
      nameWithOwner: repository,
      url: `https://github.com/${repository}`,
    },
    state: "MERGED",
    title: "Released fix",
    url: `https://github.com/${repository}/pull/${number}`,
    ...overrides,
  };
}

function pullBatchResponse(variables, overrides = {}) {
  const response = { viewer: { login: "viewer" } };
  const numbers = Object.entries(variables)
    .filter(([name]) => name.startsWith("number"))
    .sort(([left], [right]) => Number(left.slice(6)) - Number(right.slice(6)));
  const repositories = Object.keys(variables)
    .filter((name) => name.startsWith("owner"))
    .map((name) => Number(name.slice(5)))
    .sort((left, right) => left - right);
  for (const index of repositories) {
    const repository = `${variables[`owner${index}`]}/${variables[`name${index}`]}`;
    response[`repository${index}`] = {
      nameWithOwner: repository,
      url: `https://github.com/${repository}`,
    };
    for (const [name, number] of numbers) {
      const pullIndex = Number(name.slice(6));
      const key = `${repository.toLowerCase()}:${number}`;
      response[`repository${index}`][`pull${pullIndex}`] = Object.hasOwn(
        overrides,
        key,
      )
        ? overrides[key]
        : graphqlPull(number, repository);
    }
  }
  return response;
}

function recentGraphql(
  document,
  variables,
  nodes = [releaseNode()],
  pulls = {},
) {
  if (document.includes("RecentRepositoryReleases"))
    return releaseConnection(nodes);
  if (document.includes("RevalidateRecentReleases")) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return { nodes: variables.ids.map((id) => byId.get(id) ?? null) };
  }
  if (document.includes("RecentReleasePulls"))
    return pullBatchResponse(variables, pulls);
  throw new Error("Unexpected GraphQL document");
}

function mergedItem(number = 7, repository = "owner/repo") {
  return {
    html_url: `https://github.com/${repository}/pull/${number}`,
    number,
    repository_url: `https://api.github.com/repos/${repository}`,
    user: { login: "viewer" },
  };
}

function mergedCandidateWithPull(number = 7, overrides = {}) {
  return {
    ...mergedItem(number),
    pull: {
      headSha: SHA,
      mergeCommitSha: SHA,
      mergedAt: "2026-07-19T00:00:00Z",
      number,
      repository: "owner/repo",
      title: "Released fix",
      url: `https://github.com/owner/repo/pull/${number}`,
      ...overrides,
    },
  };
}

function pipelineRun({
  attempt = 1,
  conclusion = null,
  createdAt = "2026-07-20T00:00:01.000Z",
  headBranch = "v1.2.4",
  id = 100,
  name = "Production Deployment",
  repository = "owner/repo",
  status = "in_progress",
  updatedAt = "2026-07-20T00:01:00.000Z",
  workflowId = 50,
} = {}) {
  return {
    conclusion,
    created_at: createdAt,
    event: "release",
    head_branch: headBranch,
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    id,
    name,
    path: `.github/workflows/${workflowId}.yml`,
    repository: { full_name: repository },
    run_attempt: attempt,
    run_started_at: createdAt,
    status,
    updated_at: updatedAt,
    workflow_id: workflowId,
  };
}

function verificationInput(overrides = {}) {
  return {
    headSha: SHA,
    pullNumber: 7,
    pullUrl: "https://github.com/owner/repo/pull/7",
    releaseId: "10",
    repository: "owner/repo",
    tag: "v1.2.4",
    ...overrides,
  };
}

function changedFile() {
  return {
    additions: 1,
    changes: 2,
    deletions: 1,
    filename: "src/fix.js",
    patch: "@@ -1 +1 @@\n-old\n+new",
    sha: SHA,
    status: "modified",
  };
}

describe("release tag selection", () => {
  it("selects the highest numeric stable tag and preserves its v prefix", () => {
    expect(
      nextPatchTag(["v2.9.9", "10.0.0", "v10.0.0-rc.1", "latest"]),
    ).toEqual({
      latestTag: "10.0.0",
      nextTag: "10.0.1",
    });
    expect(nextPatchTag(["1.2.3", "v1.2.3"])).toEqual({
      latestTag: "v1.2.3",
      nextTag: "v1.2.4",
    });
    expect(nextPatchTag([])).toEqual({ latestTag: null, nextTag: "v0.1.0" });
  });

  it("rejects unsafe tags while allowing valid user-edited tags", () => {
    expect(() =>
      validateCreateReleaseInput({
        repository: "owner/repo",
        tag: "--help",
        expectedLatestTag: null,
        prerelease: false,
      }),
    ).toThrow("tag is invalid");
    expect(
      validateCreateReleaseInput({
        repository: "owner/repo",
        tag: "release/summer-2026",
        expectedLatestTag: null,
        prerelease: false,
        preview: releasePreview({ baseTag: null, tag: "release/summer-2026" }),
      }),
    ).toEqual({
      expectedLatestTag: null,
      prerelease: false,
      preview: releasePreview({ baseTag: null, tag: "release/summer-2026" }),
      repository: "owner/repo",
      tag: "release/summer-2026",
    });
    expect(
      validateCreateReleaseInput({
        repository: "owner/repo",
        tag: "v1.2.4-rc.1",
        expectedLatestTag: null,
        prerelease: true,
        preview: releasePreview({ baseTag: null, tag: "v1.2.4-rc.1" }),
      }),
    ).toEqual({
      expectedLatestTag: null,
      prerelease: true,
      preview: releasePreview({ baseTag: null, tag: "v1.2.4-rc.1" }),
      repository: "owner/repo",
      tag: "v1.2.4-rc.1",
    });
    expect(() =>
      validateCreateReleaseInput({
        repository: "../repo",
        tag: "v1.2.3",
        expectedLatestTag: null,
        prerelease: false,
      }),
    ).toThrow("repository");
    expect(() =>
      validateCreateReleaseInput({
        repository: "owner/repo",
        tag: "v1.2.4",
        expectedLatestTag: null,
      }),
    ).toThrow("pre-release option");
    expect(() =>
      validateCreateReleaseInput({
        repository: "owner/repo",
        tag: "v1.2.4",
        expectedLatestTag: null,
        prerelease: "false",
      }),
    ).toThrow("pre-release option");
  });
});

describe("release catalog", () => {
  it("unions open and paginated merged repositories and computes repository tags", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) {
          return search([
            { repository_url: "https://api.github.com/repos/merged/repo" },
          ]);
        }
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.3" }];
        if (endpoint.startsWith("repos/merged/repo/tags?"))
          return [{ name: "3.4.5" }];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await expect(service.getOptions()).resolves.toEqual({
      generatedAt: "2026-07-21T00:00:00.000Z",
      repositoriesUpdatedAt: "2026-07-21T00:00:00.000Z",
      repositories: [
        {
          latestTag: "3.4.5",
          nextTag: "3.4.6",
          repository: "merged/repo",
          previousTags: ["3.4.5"],
          repositoryUrl: "https://github.com/merged/repo",
        },
        {
          latestTag: "v1.2.3",
          nextTag: "v1.2.4",
          repository: "owner/repo",
          previousTags: ["v1.2.3"],
          repositoryUrl: "https://github.com/owner/repo",
        },
      ],
      tagsUpdatedAt: "2026-07-21T00:00:00.000Z",
      viewerLogin: "viewer",
      warnings: [],
    });
  });

  it("bypasses the release option cache only when refresh is explicit", async () => {
    let tags = ["v1.2.3"];
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?"))
          return search([mergedItem()]);
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return tags.map((name) => ({ name }));
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    expect((await service.getOptions()).repositories[0].nextTag).toBe("v1.2.4");
    tags = ["v1.2.4"];
    expect((await service.getOptions()).repositories[0]).toMatchObject({
      nextTag: "v1.2.4",
      previousTags: ["v1.2.3"],
    });
    expect(
      (await service.getOptions({ refresh: true })).repositories[0],
    ).toMatchObject({
      nextTag: "v1.2.5",
      previousTags: ["v1.2.4"],
    });
  });

  it("returns ten exact-deduplicated tags in deterministic version and name order", async () => {
    const tags = [
      "release-2",
      "v1.9.99",
      "v2.0.0-rc.10",
      "alpha",
      "2.0.0-rc.2",
      "v2.0.0",
      "release-10",
      "v1.10.0",
      "v2.0.0-beta",
      "v2.0.0",
      "2.0.0",
      "release-20",
    ];
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/tags?")) {
          return tags.map((name) => ({ name }));
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getOptions()).resolves.toMatchObject({
      repositories: [
        {
          latestTag: "v2.0.0",
          previousTags: [
            "v2.0.0",
            "2.0.0",
            "v2.0.0-rc.10",
            "2.0.0-rc.2",
            "v2.0.0-beta",
            "v1.10.0",
            "v1.9.99",
            "release-20",
            "release-10",
            "release-2",
          ],
        },
      ],
    });
    expect(executor.rest).toHaveBeenCalledOnce();
  });

  it("does not disguise a failed explicit option refresh as fresh cached data", async () => {
    let fail = false;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (fail) throw new Error("offline");
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) return search();
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.3" }];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await service.getOptions();
    fail = true;
    await expect(service.getOptions({ refresh: true })).rejects.toMatchObject({
      code: "release_options_unavailable",
    });
  });

  it("bootstraps and coalesces repository discovery before the first pull-list prime", async () => {
    const loadOpenPulls = vi.fn(async () => openSnapshot());
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [mergedCandidateWithPull()],
    }));
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.3" }];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls,
      now: () => NOW,
    });

    const [left, right] = await Promise.all([
      service.getOptions(),
      service.getOptions(),
    ]);

    expect(left).toEqual(right);
    expect(loadOpenPulls).toHaveBeenCalledOnce();
    expect(loadOpenPulls).toHaveBeenCalledWith({ refresh: false });
    expect(loadMergedPulls).toHaveBeenCalledOnce();
    expect(executor.rest).toHaveBeenCalledOnce();
  });

  it("discovers a viewer repository catalog once and refreshes only tags afterward", async () => {
    let clock = NOW;
    let tags = ["v1.2.3"];
    const loadOpenPulls = vi.fn(async () => openSnapshot());
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [],
    }));
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return tags.map((name) => ({ name }));
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls,
      now: () => clock,
    });

    await service.primeRepositories(openSnapshot());
    const initial = await service.getOptions();
    clock += 1_000;
    tags = ["v1.2.4"];
    const refreshed = await service.getOptions({ refresh: true });
    service.invalidate();
    clock += 1_000;
    const invalidated = await service.getOptions();
    await service.primeRepositories({
      ...openSnapshot(["other/repo"]),
      viewerLogin: "VIEWER",
    });

    expect(initial).toMatchObject({
      generatedAt: "2026-07-21T00:00:00.000Z",
      repositoriesUpdatedAt: "2026-07-21T00:00:00.000Z",
      tagsUpdatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(refreshed).toMatchObject({
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: "2026-07-21T00:00:01.000Z",
    });
    expect(invalidated).toMatchObject({
      repositories: [{ repository: "owner/repo" }],
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: "2026-07-21T00:00:02.000Z",
    });
    expect(loadOpenPulls).not.toHaveBeenCalled();
    expect(loadMergedPulls).toHaveBeenCalledOnce();
    expect(executor.rest).toHaveBeenCalledTimes(3);
  });

  it("keeps a first truncated repository catalog usable and does not replace a complete catalog", async () => {
    const partialMerged = vi.fn(async () => ({
      incomplete: true,
      items: [
        {
          repository: "merged/repo",
          repositoryUrl: "https://github.com/merged/repo",
        },
      ],
    }));
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/tags?")) return [];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const partialService = createReleaseService({
      executor,
      loadMergedPulls: partialMerged,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await partialService.primeRepositories(openSnapshot());
    const partial = await partialService.getOptions();
    await partialService.primeRepositories({
      ...openSnapshot(["ignored/repo"]),
      partial: false,
    });

    expect(partial).toMatchObject({
      repositoriesUpdatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(partial.repositories.map(({ repository }) => repository)).toEqual([
      "merged/repo",
      "owner/repo",
    ]);
    expect(partial.warnings).toContain(
      "GitHub truncated the authored merged pull request search.",
    );
    expect(partialMerged).toHaveBeenCalledOnce();

    const completeMerged = vi.fn(async () => ({
      incomplete: false,
      items: [],
    }));
    const completeService = createReleaseService({
      executor,
      loadMergedPulls: completeMerged,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await completeService.primeRepositories(openSnapshot());
    await completeService.primeRepositories({
      ...openSnapshot(["ignored/repo"]),
      partial: true,
    });
    const complete = await completeService.getOptions();
    expect(complete).toMatchObject({ warnings: [] });
    expect(complete.repositories).toMatchObject([{ repository: "owner/repo" }]);
    expect(completeMerged).toHaveBeenCalledOnce();
  });

  it("ignores an old viewer discovery that completes after a new viewer is active", async () => {
    const alice = deferred();
    const bob = deferred();
    const loadMergedPulls = vi.fn(({ viewerLogin }) =>
      viewerLogin.toLowerCase() === "alice" ? alice.promise : bob.promise,
    );
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/bob/repo/tags?")) return [];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const oldPrime = service.primeRepositories({
      ...openSnapshot(["alice/repo"]),
      viewerLogin: "Alice",
    });
    const newPrime = service.primeRepositories({
      ...openSnapshot(["bob/repo"]),
      viewerLogin: "Bob",
    });
    alice.resolve({ incomplete: false, items: [] });
    await expect(oldPrime).resolves.toBeNull();
    bob.resolve({ incomplete: false, items: [] });
    await expect(newPrime).resolves.toMatchObject({ viewerLogin: "Bob" });

    await expect(service.getOptions()).resolves.toMatchObject({
      repositories: [{ repository: "bob/repo" }],
      viewerLogin: "Bob",
    });
  });

  it("clears old-viewer options immediately while the new viewer catalog is loading", async () => {
    const bob = deferred();
    const loadMergedPulls = vi.fn(({ viewerLogin }) =>
      viewerLogin === "Bob"
        ? bob.promise
        : Promise.resolve({ incomplete: false, items: [] }),
    );
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/tags?")) return [];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await service.primeRepositories({
      ...openSnapshot(["alice/repo"]),
      viewerLogin: "Alice",
    });
    await service.getOptions();

    const prime = service.primeRepositories({
      ...openSnapshot(["bob/repo"]),
      viewerLogin: "Bob",
    });
    let settled = false;
    const options = service.getOptions().then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    bob.resolve({ incomplete: false, items: [] });
    await prime;
    await expect(options).resolves.toMatchObject({
      repositories: [{ repository: "bob/repo" }],
      viewerLogin: "Bob",
    });
  });

  it("rebinds options before reading tags when the viewer changes after catalog resolution", async () => {
    const alice = deferred();
    const bob = deferred();
    const bobStarted = deferred();
    const loadMergedPulls = vi.fn(({ viewerLogin }) => {
      if (viewerLogin === "Alice") return alice.promise;
      bobStarted.resolve();
      return bob.promise;
    });
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/alice/repo/tags?"))
          return [{ name: "v9.0.0" }];
        if (endpoint.startsWith("repos/bob/repo/tags?"))
          return [{ name: "v2.0.0" }];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const alicePrime = service.primeRepositories({
      ...openSnapshot(["alice/repo"]),
      viewerLogin: "Alice",
    });
    const bobPrime = alicePrime.then(() =>
      service.primeRepositories({
        ...openSnapshot(["bob/repo"]),
        viewerLogin: "Bob",
      }),
    );
    const options = service.getOptions();

    alice.resolve({ incomplete: false, items: [] });
    await bobStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const readsBeforeBob = executor.rest.mock.calls.map(
      ([endpoint]) => endpoint,
    );
    bob.resolve({ incomplete: false, items: [] });
    await bobPrime;

    await expect(options).resolves.toMatchObject({
      repositories: [{ latestTag: "v2.0.0", repository: "bob/repo" }],
      viewerLogin: "Bob",
    });
    await expect(service.getOptions()).resolves.toMatchObject({
      viewerLogin: "Bob",
    });
    expect(readsBeforeBob).toEqual([]);
    expect(executor.rest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "repos/bob/repo/tags?per_page=100&page=1",
    ]);
  });

  it("does not begin recent-release reads from a catalog superseded after await", async () => {
    const bob = deferred();
    const bobStarted = deferred();
    const loadMergedPulls = vi.fn(({ viewerLogin }) => {
      if (viewerLogin === "Bob") {
        bobStarted.resolve();
        return bob.promise;
      }
      return Promise.resolve({ incomplete: false, items: [] });
    });
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/releases?")) return [];
        if (endpoint === "user") return { login: "Bob" };
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    await service.primeRepositories({
      ...openSnapshot(["alice/repo"]),
      viewerLogin: "Alice",
    });

    const recent = service.getRecent().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let bobPrime;
    queueMicrotask(() => {
      bobPrime = service.primeRepositories({
        ...openSnapshot(["bob/repo"]),
        viewerLogin: "Bob",
      });
    });

    await bobStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const mergedBeforeBob = loadMergedPulls.mock.calls.map(
      ([{ viewerLogin }]) => viewerLogin,
    );
    const releaseReadsBeforeBob = executor.rest.mock.calls.map(
      ([endpoint]) => endpoint,
    );
    bob.resolve({ incomplete: false, items: [] });
    await bobPrime;

    await expect(recent).resolves.toMatchObject({
      error: { code: "repository_catalog_changed" },
    });
    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [],
    });
    expect(mergedBeforeBob).toEqual(["Alice", "Bob"]);
    expect(releaseReadsBeforeBob).toEqual([]);
    expect(
      executor.rest.mock.calls.every(
        ([endpoint]) => !endpoint.startsWith("repos/alice/repo/releases?"),
      ),
    ).toBe(true);
  });

  it("falls back to cached tags only for non-explicit refresh failures", async () => {
    let clock = NOW;
    let fail = false;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/tags?")) {
          if (fail) throw new Error("offline");
          return [{ name: "v1.2.3" }];
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
      ttl: 10,
    });
    await service.primeRepositories(openSnapshot());
    const initial = await service.getOptions();
    fail = true;
    clock += 11;

    const fallback = await service.getOptions();
    expect(fallback).toMatchObject({
      generatedAt: "2026-07-21T00:00:00.011Z",
      repositories: [{ previousTags: ["v1.2.3"] }],
      repositoriesUpdatedAt: initial.repositoriesUpdatedAt,
      tagsUpdatedAt: initial.tagsUpdatedAt,
    });
    expect(fallback.warnings).toContain(
      "Showing cached release options because GitHub could not refresh tags.",
    );
    await expect(service.getOptions({ refresh: true })).rejects.toMatchObject({
      code: "release_options_unavailable",
    });
  });

  it("rebases a failed recent refresh and removes cached releases that have left the seven-day window", async () => {
    let clock = NOW;
    let fail = false;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          if (fail) {
            throw new ActionError(
              502,
              "github_unavailable",
              "GitHub is unavailable.",
            );
          }
          return [
            release({
              body: "https://github.com/owner/repo/pull/7",
              published: new Date(NOW).toISOString(),
            }),
          ];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({
            body: "https://github.com/owner/repo/pull/7",
            published: new Date(NOW).toISOString(),
          });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    const initial = await service.getRecent();
    fail = true;
    clock += 7 * 24 * 60 * 60 * 1_000 + 1;

    const fallback = await service.getRecent({ refresh: true });

    expect(initial).toMatchObject({
      generatedAt: "2026-07-21T00:00:00.000Z",
      releases: [{ id: "10" }],
    });
    expect(fallback).toMatchObject({
      generatedAt: "2026-07-28T00:00:00.001Z",
      partial: true,
      releases: [],
      warnings: [
        expect.stringContaining("owner/repo releases could not be loaded"),
      ],
    });
  });

  it("preserves cached rows only for repositories whose release read failed", async () => {
    const nodes = new Map([
      [
        "owner/failed",
        releaseNode({
          databaseId: 10,
          id: "RE_failed",
          repository: "owner/failed",
          tag: "v1.0.0",
          body: "https://github.com/owner/failed/pull/7",
        }),
      ],
      [
        "owner/success",
        releaseNode({
          databaseId: 20,
          id: "RE_success",
          repository: "owner/success",
          tag: "v2.0.0",
          body: "https://github.com/owner/success/pull/8",
        }),
      ],
    ]);
    const failed = new Set();
    const empty = new Set();
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          const repository = `${variables.owner}/${variables.name}`;
          if (failed.has(repository)) throw new ExecutorError("failed");
          return releaseConnection(
            empty.has(repository) ? [] : [nodes.get(repository)],
            { repository },
          );
        }
        if (document.includes("RevalidateRecentReleases")) {
          const byId = new Map(
            [...nodes.values()].map((node) => [node.id, node]),
          );
          return { nodes: variables.ids.map((id) => byId.get(id) ?? null) };
        }
        return pullBatchResponse(variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot([...nodes.keys()]),
      now: () => NOW,
    });

    const initial = await service.getRecent();
    expect(initial.partial).toBe(false);
    expect(initial.releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: "owner/failed" }),
        expect.objectContaining({ repository: "owner/success" }),
      ]),
    );
    failed.add("owner/failed");
    empty.add("owner/success");

    await expect(service.getRecent({ refresh: true })).resolves.toMatchObject({
      partial: true,
      releases: [{ repository: "owner/failed", pulls: [{ number: 7 }] }],
      warnings: [
        expect.stringContaining("owner/failed releases could not be loaded"),
      ],
    });
  });

  it("preserves all same-revision cached rows when every repository read fails", async () => {
    const nodes = new Map([
      [
        "owner/one",
        releaseNode({
          databaseId: 10,
          id: "RE_one",
          repository: "owner/one",
          tag: "v1.0.0",
          body: "https://github.com/owner/one/pull/7",
        }),
      ],
      [
        "owner/two",
        releaseNode({
          databaseId: 20,
          id: "RE_two",
          repository: "owner/two",
          tag: "v2.0.0",
          body: "https://github.com/owner/two/pull/8",
        }),
      ],
    ]);
    let fail = false;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          if (fail) throw new ExecutorError("failed");
          const repository = `${variables.owner}/${variables.name}`;
          return releaseConnection([nodes.get(repository)], { repository });
        }
        if (document.includes("RevalidateRecentReleases")) {
          const byId = new Map(
            [...nodes.values()].map((node) => [node.id, node]),
          );
          return { nodes: variables.ids.map((id) => byId.get(id) ?? null) };
        }
        return pullBatchResponse(variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot([...nodes.keys()]),
      now: () => NOW,
    });

    const initial = await service.getRecent();
    fail = true;
    const refreshed = await service.getRecent({ refresh: true });

    expect(initial.releases).toHaveLength(2);
    expect(refreshed.partial).toBe(true);
    expect(refreshed.releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: "owner/one" }),
        expect.objectContaining({ repository: "owner/two" }),
      ]),
    );
  });

  it("drops failed-repository fallback when the live REST viewer changes", async () => {
    const repositories = ["owner/failed", "owner/success"];
    const initial = new Map([
      ["owner/failed", { id: 10, number: 7, tag: "v1.0.0" }],
      ["owner/success", { id: 20, number: 8, tag: "v2.0.0" }],
    ]);
    const current = { id: 21, number: 9, tag: "v2.0.1" };
    let refresh = false;
    let snapshotViewer = "viewer";
    let viewerLogin = "viewer";
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: viewerLogin };
        for (const repository of repositories) {
          if (endpoint.startsWith(`repos/${repository}/releases?`)) {
            if (!refresh) {
              const item = initial.get(repository);
              return [
                repositoryRelease(repository, {
                  body: `https://github.com/${repository}/pull/${item.number}`,
                  id: item.id,
                  tag: item.tag,
                }),
              ];
            }
            if (repository === "owner/failed")
              throw new ExecutorError("failed");
            return [
              repositoryRelease(repository, {
                body: `https://github.com/${repository}/pull/${current.number}`,
                id: current.id,
                tag: current.tag,
              }),
            ];
          }
          const item =
            refresh && repository === "owner/success"
              ? current
              : initial.get(repository);
          if (endpoint === `repos/${repository}/pulls/${item.number}`) {
            return repositoryPull(repository, item.number, viewerLogin);
          }
          if (endpoint === `repos/${repository}/releases/${item.id}`) {
            return repositoryRelease(repository, {
              body: `https://github.com/${repository}/pull/${item.number}`,
              id: item.id,
              tag: item.tag,
            });
          }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => ({
        ...openSnapshot(repositories),
        viewerLogin: snapshotViewer,
      }),
      now: () => NOW,
    });

    expect((await service.getRecent()).releases).toHaveLength(2);
    refresh = true;
    snapshotViewer = "another-viewer";
    viewerLogin = "another-viewer";

    await expect(service.getRecent({ refresh: true })).rejects.toMatchObject({
      code: "repository_catalog_changed",
    });
    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [
        {
          id: "21",
          repository: "owner/success",
          pulls: [{ number: 9 }],
        },
      ],
    });
  });

  it("cannot reuse REST fallback when every release read fails and the live viewer changes", async () => {
    const repositories = ["owner/one", "owner/two"];
    const items = new Map([
      ["owner/one", { id: 10, number: 7, tag: "v1.0.0" }],
      ["owner/two", { id: 20, number: 8, tag: "v2.0.0" }],
    ]);
    let fail = false;
    let snapshotViewer = "viewer";
    let viewerLogin = "viewer";
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: viewerLogin };
        for (const repository of repositories) {
          const item = items.get(repository);
          if (endpoint.startsWith(`repos/${repository}/releases?`)) {
            if (fail) throw new ExecutorError("failed");
            return [
              repositoryRelease(repository, {
                body: `https://github.com/${repository}/pull/${item.number}`,
                id: item.id,
                tag: item.tag,
              }),
            ];
          }
          if (endpoint === `repos/${repository}/pulls/${item.number}`) {
            return repositoryPull(repository, item.number, viewerLogin);
          }
          if (endpoint === `repos/${repository}/releases/${item.id}`) {
            return repositoryRelease(repository, {
              body: `https://github.com/${repository}/pull/${item.number}`,
              id: item.id,
              tag: item.tag,
            });
          }
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => ({
        ...openSnapshot(repositories),
        viewerLogin: snapshotViewer,
      }),
      now: () => NOW,
    });

    expect((await service.getRecent()).releases).toHaveLength(2);
    fail = true;
    snapshotViewer = "another-viewer";
    viewerLogin = "another-viewer";

    await expect(service.getRecent({ refresh: true })).rejects.toMatchObject({
      code: "repository_catalog_changed",
    });
    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) => endpoint === "user"),
    ).toHaveLength(3);
  });

  it("does not reuse recent fallback after invalidation changes the revision", async () => {
    const node = releaseNode();
    let fail = false;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          if (fail) throw new ExecutorError("failed");
          return releaseConnection([node]);
        }
        return recentGraphql(document, variables, [node]);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    expect((await service.getRecent()).releases).toHaveLength(1);
    service.invalidate();
    fail = true;

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
    });
  });

  it("does not reuse a captured fallback when invalidation races an active refresh", async () => {
    const node = releaseNode();
    const refreshStarted = deferred();
    const refreshFinished = deferred();
    let refresh = false;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          if (refresh) {
            refreshStarted.resolve();
            await refreshFinished.promise;
          }
          return releaseConnection([node]);
        }
        return recentGraphql(document, variables, [node]);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    expect((await service.getRecent()).releases).toHaveLength(1);
    refresh = true;
    const pending = service.getRecent({ refresh: true });
    await refreshStarted.promise;
    service.invalidate();
    refreshFinished.resolve();

    await expect(pending).rejects.toMatchObject({
      code: "repository_catalog_changed",
    });
  });

  it("does not reuse recent fallback after the authenticated viewer changes", async () => {
    const node = releaseNode();
    let fail = false;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          if (fail) throw new ExecutorError("failed");
          return releaseConnection([node]);
        }
        return recentGraphql(document, variables, [node]);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    expect((await service.getRecent()).releases).toHaveLength(1);
    await service.primeRepositories({
      ...openSnapshot(),
      viewerLogin: "another-viewer",
    });
    fail = true;

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
    });
  });

  it("includes a release published exactly at the seven-day boundary", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release({
              body: "https://github.com/owner/repo/pull/7",
              published: "2026-07-14T00:00:00.000Z",
            }),
          ];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({
            body: "https://github.com/owner/repo/pull/7",
            published: "2026-07-14T00:00:00.000Z",
          });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
    });
  });

  it("excludes a release published one millisecond before the seven-day boundary", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release({
              body: "https://github.com/owner/repo/pull/7",
              published: "2026-07-13T23:59:59.999Z",
            }),
          ];
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({ releases: [] });
  });

  it("does not repeat authored merged pull discovery while loading recent releases", async () => {
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [],
    }));
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/releases?")) return [];
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await service.primeRepositories(openSnapshot());
    await service.getRecent();

    expect(loadMergedPulls.mock.calls.map(([input]) => input)).toEqual([
      { since: "2026-04-22", viewerLogin: "viewer" },
    ]);
  });

  it("intersects canonical release-note links with authored candidates and deduplicates pulls", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?"))
          return search([mergedItem(), mergedItem()]);
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.4" }];
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release({ body: "https://github.com/owner/repo/pull/7" }),
            release({
              id: 9,
              tag: "v1.2.3",
              published: "2026-04-01T00:00:00Z",
            }),
          ];
        }
        if (endpoint.startsWith("repos/owner/repo/compare/")) {
          return { commits: [{ sha: SHA }], status: "ahead", total_commits: 1 };
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull(), mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    const result = await service.getRecent();
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({
      complete: false,
      id: "10",
      source: "notes-fallback",
      tag: "v1.2.4",
      warning: expect.stringContaining("Verify"),
    });
    expect(result.releases[0].pulls).toEqual([
      {
        headSha: SHA,
        mergedAt: "2026-07-19T00:00:00Z",
        number: 7,
        repository: "owner/repo",
        title: "Released fix",
        url: "https://github.com/owner/repo/pull/7",
      },
    ]);
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/compare/"),
      ),
    ).toBe(false);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/pulls/7",
      ),
    ).toHaveLength(1);
  });

  it("does not fan out comparisons or per-pull REST reads during recent discovery", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?"))
          return search([mergedItem()]);
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release({ body: "https://github.com/owner/repo/pull/7" }),
            release({
              id: 9,
              tag: "v1.2.3",
              published: "2026-04-01T00:00:00Z",
            }),
          ];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const result = await service.getRecent();

    expect(result.releases[0].pulls).toMatchObject([{ number: 7 }]);
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        /^repos\/owner\/repo\/commits\/[a-f0-9]{40}\/pulls/.test(endpoint),
      ),
    ).toHaveLength(0);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/pulls/7",
      ),
    ).toHaveLength(1);
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/compare/"),
      ),
    ).toBe(false);
    expect(nonPipelineRestCalls(executor)).toHaveLength(4);
  });

  it("uses batched GraphQL authored candidates without one REST request per pull", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        document.includes("AuthoredMergedPulls")
          ? {
              search: {
                issueCount: 1,
                nodes: [
                  {
                    author: { login: "viewer" },
                    headRefOid: SHA,
                    mergeCommit: { oid: SHA },
                    mergedAt: "2026-07-19T00:00:00Z",
                    number: 7,
                    repository: {
                      nameWithOwner: "owner/repo",
                      url: "https://github.com/owner/repo",
                    },
                    title: "Released fix",
                    url: "https://github.com/owner/repo/pull/7",
                  },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            }
          : recentGraphql(document, variables),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const result = await service.getRecent();

    expect(result.releases[0]).toMatchObject({
      complete: false,
      pulls: [{ number: 7 }],
      source: "notes-fallback",
    });
    expect(executor.graphql).toHaveBeenCalledTimes(4);
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("omits completely compared release groups with no authored pull requests", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) return search();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release(),
            release({
              id: 9,
              tag: "v1.2.3",
              published: "2026-04-01T00:00:00Z",
            }),
          ];
        }
        if (endpoint === "repos/owner/repo/releases/10") return release();
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [],
    });
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/compare/"),
      ),
    ).toBe(false);
  });

  it("uses only canonical release-note links that intersect authored candidates", async () => {
    const current = release({
      body: "Included https://github.com/owner/repo/pull/7",
    });
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) return search();
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.4" }];
        if (endpoint.startsWith("repos/owner/repo/releases?")) return [current];
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") return current;
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    const result = await service.getRecent();
    expect(result.releases[0]).toMatchObject({
      complete: false,
      source: "notes-fallback",
      pulls: [{ number: 7 }],
    });
    expect(result.partial).toBe(false);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/pulls/7",
      ),
    ).toHaveLength(1);
  });

  it("returns an authoritative empty refresh when a previously linked authored pull disappears", async () => {
    let include = true;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [release({ body: "https://github.com/owner/repo/pull/7" })];
        }
        if (endpoint === "repos/owner/repo/pulls/7") {
          if (include) return authoredPull();
          throw new ExecutorError("api_rejected", 404);
        }
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: include ? [mergedCandidateWithPull()] : [],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ pulls: [{ number: 7 }] }],
    });
    include = false;
    await expect(service.getRecent({ refresh: true })).resolves.toMatchObject({
      partial: false,
      releases: [],
    });
  });

  it("marks malformed published release data partial without discarding valid groups", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release({ body: "https://github.com/owner/repo/pull/7" }),
            { draft: false, id: 9, tag_name: "v1.2.3" },
          ];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
      warnings: [
        expect.stringContaining("malformed or changing published release data"),
      ],
    });
  });

  it("bounds repeated GraphQL cursors and marks authored search evidence partial", async () => {
    const node = {
      author: { login: "viewer" },
      headRefOid: SHA,
      mergeCommit: { oid: SHA },
      mergedAt: "2026-07-19T00:00:00Z",
      number: 7,
      repository: {
        nameWithOwner: "owner/repo",
        url: "https://github.com/owner/repo",
      },
      title: "Released fix",
      url: "https://github.com/owner/repo/pull/7",
    };
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        document.includes("AuthoredMergedPulls")
          ? {
              search: {
                issueCount: 2,
                nodes: [node],
                pageInfo: { endCursor: "repeated", hasNextPage: true },
              },
            }
          : recentGraphql(document, variables),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const result = await service.getRecent();
    expect(result).toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
    });
    expect(result.warnings).toContain(
      "GitHub truncated the authored merged pull request search.",
    );
    expect(executor.graphql).toHaveBeenCalledTimes(5);
  });

  it("bounds repeated release pages and marks the release catalog partial", async () => {
    const values = [
      release({ body: "https://github.com/owner/repo/pull/7" }),
      ...Array.from({ length: 99 }, (_, index) =>
        release({
          id: index + 100,
          tag: `v0.0.${index + 1}`,
          published: "2026-07-01T00:00:00Z",
        }),
      ),
    ];
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) return values;
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
      warnings: [expect.stringContaining("repeated release page")],
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.startsWith("repos/owner/repo/releases?"),
      ),
    ).toHaveLength(2);
  });

  it("finds a recently published release on a later page after older releases", async () => {
    const oldPage = Array.from({ length: 100 }, (_, index) =>
      release({
        id: index + 100,
        tag: `v0.0.${index + 1}`,
        published: "2026-01-01T00:00:00Z",
      }),
    );
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return endpoint.endsWith("page=2")
            ? [release({ body: "https://github.com/owner/repo/pull/7" })]
            : oldPage;
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.startsWith("repos/owner/repo/releases?"),
      ),
    ).toHaveLength(2);
  });

  it("exhausts GraphQL metadata pages and hydrates only an old-created newly-published release", async () => {
    const old = Array.from({ length: 100 }, (_, index) =>
      releaseNode({
        databaseId: index + 100,
        published: "2026-01-01T00:00:00Z",
        tag: `v0.0.${index + 1}`,
      }),
    );
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        const recent = releaseNode({
          created: "2020-01-01T00:00:00Z",
          published: "2026-07-20T00:00:00Z",
        });
        if (document.includes("RecentRepositoryReleases")) {
          return variables.after
            ? releaseConnection([recent])
            : releaseConnection(old, { endCursor: "next", hasNextPage: true });
        }
        return recentGraphql(document, variables, [recent]);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
    });
    expect(
      executor.graphql.mock.calls
        .filter(([document]) => document.includes("RecentRepositoryReleases"))
        .map(([, variables]) => variables.after),
    ).toEqual([null, "next"]);
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("hydrates the seven-day boundary but skips older and draft GraphQL releases", async () => {
    const nodes = [
      releaseNode({ published: "2026-07-14T00:00:00.000Z" }),
      releaseNode({
        databaseId: 11,
        published: "2026-07-13T23:59:59.999Z",
        tag: "v1.2.3",
      }),
      releaseNode({ databaseId: 12, draft: true, tag: "v1.2.5" }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
    });
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("skips minimal draft GraphQL metadata without marking release evidence partial", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async () => releaseConnection([{ isDraft: true }])),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [],
      warnings: [],
    });
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("bounds repeated GraphQL release cursors while retaining validated details", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        document.includes("RecentRepositoryReleases")
          ? releaseConnection([releaseNode()], {
              endCursor: "repeated",
              hasNextPage: true,
            })
          : recentGraphql(document, variables),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
      warnings: [expect.stringContaining("repeated release cursor")],
    });
    expect(executor.graphql).toHaveBeenCalledTimes(4);
  });

  it("bounds a continuing one-hundredth GraphQL release page and marks evidence partial", async () => {
    let page = 0;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          page += 1;
          return releaseConnection([releaseNode()], {
            endCursor: `cursor-${page}`,
            hasNextPage: true,
          });
        }
        return recentGraphql(document, variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
      warnings: [
        expect.stringContaining("release pagination exceeded the safe bound"),
      ],
    });
    expect(executor.graphql).toHaveBeenCalledTimes(102);
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("marks malformed, conflicting, and mismatched GraphQL release evidence partial", async () => {
    const nodes = [
      releaseNode(),
      { ...releaseNode({ databaseId: 40 }), databaseId: null },
      releaseNode({ databaseId: 20, id: "RE_conflict", tag: "v2.0.0" }),
      releaseNode({ databaseId: 21, id: "RE_conflict", tag: "v2.0.1" }),
      releaseNode({ databaseId: 30, tag: "v3.0.0" }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases"))
          return releaseConnection(nodes);
        if (document.includes("RevalidateRecentReleases")) {
          const values = variables.ids.map(
            (id) => nodes.find((node) => node.id === id) ?? null,
          );
          return {
            nodes: values.map((node) =>
              node?.databaseId === 30 ? { ...node, tagName: "v3.0.1" } : node,
            ),
          };
        }
        return recentGraphql(document, variables, nodes);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
      warnings: [
        expect.stringContaining("malformed or changing published release data"),
        expect.stringContaining(
          "Some recent releases changed while linked pull requests were loaded",
        ),
      ],
    });
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("does not fall back to an exhaustive REST crawl when GraphQL release metadata fails", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async () => {
        throw new ExecutorError("failed");
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
      warnings: [
        expect.stringContaining("owner/repo releases could not be loaded"),
      ],
    });
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("scans every bound catalog repository without another authored-candidate search", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          const repository = `${variables.owner}/${variables.name}`;
          return repository === "owner/repo"
            ? releaseConnection([releaseNode()])
            : releaseConnection([], { repository });
        }
        return recentGraphql(document, variables);
      }),
      rest: vi.fn(),
    };
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [],
    }));
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls: async () => openSnapshot(["owner/repo", "other/repo"]),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ repository: "owner/repo" }],
    });
    expect(
      executor.graphql.mock.calls.filter(([document]) =>
        document.includes("RecentRepositoryReleases"),
      ),
    ).toHaveLength(2);
    expect(loadMergedPulls).toHaveBeenCalledOnce();
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("bypasses recent cache on explicit refresh and observes a new GraphQL release", async () => {
    let current = releaseNode();
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [current]),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      releases: [{ id: "10", tag: "v1.2.4" }],
    });
    current = releaseNode({ databaseId: 11, tag: "v1.2.5" });
    await expect(service.getRecent({ refresh: true })).resolves.toMatchObject({
      releases: [{ id: "11", tag: "v1.2.5" }],
    });
  });

  it("parses links only from revalidated release bodies and omits mutated, drafted, or deleted nodes", async () => {
    const listed = [
      releaseNode({ body: "https://github.com/owner/repo/pull/7" }),
      releaseNode({
        body: "https://github.com/owner/repo/pull/8",
        databaseId: 11,
        tag: "v1.2.5",
      }),
      releaseNode({
        body: "https://github.com/owner/repo/pull/9",
        databaseId: 12,
        tag: "v1.2.6",
      }),
      releaseNode({
        body: "https://github.com/owner/repo/pull/10",
        databaseId: 13,
        tag: "v1.2.7",
      }),
    ];
    const revalidated = new Map([
      [listed[0].id, listed[0]],
      [listed[1].id, { ...listed[1], description: "body changed" }],
      [listed[2].id, { ...listed[2], isDraft: true }],
      [listed[3].id, null],
    ]);
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases"))
          return releaseConnection(listed);
        if (document.includes("RevalidateRecentReleases")) {
          return {
            nodes: variables.ids.map((id) => revalidated.get(id) ?? null),
          };
        }
        return pullBatchResponse(variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ id: "10", pulls: [{ number: 7 }] }],
    });
    const pullCalls = executor.graphql.mock.calls.filter(([document]) =>
      document.includes("RecentReleasePulls"),
    );
    expect(pullCalls).toHaveLength(1);
    expect(
      Object.values(pullCalls[0][1]).filter((value) =>
        Number.isSafeInteger(value),
      ),
    ).toEqual([10, 9, 8, 7]);
    expect(nonPipelineRestCalls(executor)).toHaveLength(0);
  });

  it("confirms release identity only after a pending exact pull batch settles", async () => {
    const order = [];
    const pullStarted = deferred();
    const pullFinished = deferred();
    let current = releaseNode();
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          order.push("list");
          return releaseConnection([current]);
        }
        if (document.includes("RecentReleasePulls")) {
          order.push("pull");
          pullStarted.resolve();
          await pullFinished.promise;
          return pullBatchResponse(variables);
        }
        if (document.includes("RevalidateRecentReleases")) {
          order.push("confirm");
          return { nodes: variables.ids.map(() => current) };
        }
        throw new Error("Unexpected GraphQL document");
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const recent = service.getRecent();
    await pullStarted.promise;
    expect(order).toEqual(["list", "pull"]);
    current = {
      ...current,
      description: "changed while exact pulls were loading",
    };
    pullFinished.resolve();

    await expect(recent).resolves.toMatchObject({
      partial: true,
      releases: [],
      warnings: [
        expect.stringContaining(
          "Some recent releases changed while linked pull requests were loaded",
        ),
      ],
    });
    expect(order).toEqual(["list", "pull", "confirm"]);
  });

  it("revalidates one hundred and one recent release nodes in bounded batches", async () => {
    const nodes = Array.from({ length: 101 }, (_, index) =>
      releaseNode({
        body: index === 0 ? "https://github.com/owner/repo/pull/7" : "",
        databaseId: index + 1,
        id: `RE_${index + 1}`,
        tag: `v1.0.${index}`,
      }),
    );
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ id: "1", pulls: [{ number: 7 }] }],
    });
    expect(
      executor.graphql.mock.calls
        .filter(([document]) => document.includes("RevalidateRecentReleases"))
        .map(([, variables]) => variables.ids.length),
    ).toEqual([100, 1]);
  });

  it("isolates a failed release-node batch and retains releases from later batches", async () => {
    const nodes = Array.from({ length: 101 }, (_, index) =>
      releaseNode({
        body: index === 0 ? "https://github.com/owner/repo/pull/1" : "",
        databaseId: index + 1,
        id: `RE_${index + 1}`,
        tag: `v1.0.${index}`,
      }),
    );
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases"))
          return releaseConnection(nodes);
        if (document.includes("RevalidateRecentReleases")) {
          if (variables.ids.length === 100) throw new ExecutorError("failed");
          return { nodes: variables.ids.map((id) => byId.get(id) ?? null) };
        }
        return pullBatchResponse(variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ id: "1", pulls: [{ number: 1 }] }],
    });
  });

  it("validates exact GraphQL pull state, author, cutoff, repository, URL, SHA, and title", async () => {
    const body = Array.from(
      { length: 9 },
      (_, index) => `https://github.com/owner/repo/pull/${index + 7}`,
    ).join("\n");
    const node = releaseNode({ body });
    const pulls = {
      "owner/repo:7": graphqlPull(7, "owner/repo", {
        mergedAt: "2026-04-22T00:00:00.000Z",
      }),
      "owner/repo:8": graphqlPull(8, "owner/repo", {
        merged: false,
        state: "CLOSED",
      }),
      "owner/repo:9": graphqlPull(9, "owner/repo", {
        author: { login: "someone-else" },
      }),
      "owner/repo:10": null,
      "owner/repo:11": graphqlPull(11, "owner/repo", {
        mergedAt: "2026-04-21T23:59:59.999Z",
      }),
      "owner/repo:12": graphqlPull(12, "owner/repo", {
        repository: {
          nameWithOwner: "other/repo",
          url: "https://github.com/other/repo",
        },
      }),
      "owner/repo:13": graphqlPull(13, "owner/repo", {
        url: "https://github.com/owner/repo/pull/999",
      }),
      "owner/repo:14": graphqlPull(14, "owner/repo", { headRefOid: "invalid" }),
      "owner/repo:15": graphqlPull(15, "owner/repo", { title: null }),
    };
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node], pulls),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 7 }] }],
      warnings: [expect.stringContaining("Some authored merged pull requests")],
    });
  });

  it("treats a GraphQL viewer mismatch as partial and omits that pull batch", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        const response = recentGraphql(document, variables);
        if (document.includes("RecentReleasePulls")) {
          return { ...response, viewer: { login: "someone-else" } };
        }
        return response;
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
    });
  });

  it("treats a repository disappearing during exact pull loading as partial", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        const response = recentGraphql(document, variables);
        if (document.includes("RecentReleasePulls")) {
          return { ...response, repository0: null };
        }
        return response;
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [],
    });
  });

  it("deduplicates the same repository pull across release bodies before exact loading", async () => {
    const nodes = [
      releaseNode(),
      releaseNode({ databaseId: 11, id: "RE_11", tag: "v1.2.5" }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const result = await service.getRecent();
    expect(result.releases).toHaveLength(2);
    expect(
      result.releases.every(
        ({ pulls }) => pulls.length === 1 && pulls[0].number === 7,
      ),
    ).toBe(true);
    const pullCall = executor.graphql.mock.calls.find(([document]) =>
      document.includes("RecentReleasePulls"),
    );
    expect(
      Object.keys(pullCall[1]).filter((name) => name.startsWith("number")),
    ).toHaveLength(1);
  });

  it("loads more than one thousand linked pulls without a global cap in batches of one hundred", async () => {
    const total = 1_001;
    const node = releaseNode({
      body: Array.from(
        { length: total },
        (_, index) => `https://github.com/owner/repo/pull/${index + 1}`,
      ).join("\n"),
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node]),
      ),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    const result = await service.getRecent();
    expect(result).toMatchObject({ partial: false });
    expect(result.releases[0].pulls).toHaveLength(total);
    const batches = executor.graphql.mock.calls.filter(([document]) =>
      document.includes("RecentReleasePulls"),
    );
    expect(batches).toHaveLength(11);
    expect(
      batches.every(
        ([, variables]) =>
          Object.keys(variables).filter((name) => name.startsWith("number"))
            .length <= 100,
      ),
    ).toBe(true);
  });

  it("limits each exact pull batch to ten repositories", async () => {
    const repositories = Array.from(
      { length: 11 },
      (_, index) => `owner/repo-${index}`,
    );
    const nodes = new Map(
      repositories.map((repository, index) => [
        repository,
        releaseNode({
          body: `https://github.com/${repository}/pull/7`,
          databaseId: index + 1,
          id: `RE_${index + 1}`,
          repository,
          tag: `v1.0.${index}`,
        }),
      ]),
    );
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentRepositoryReleases")) {
          const repository = `${variables.owner}/${variables.name}`;
          return releaseConnection([nodes.get(repository)], { repository });
        }
        if (document.includes("RevalidateRecentReleases")) {
          const byId = new Map(
            [...nodes.values()].map((node) => [node.id, node]),
          );
          return { nodes: variables.ids.map((id) => byId.get(id) ?? null) };
        }
        return pullBatchResponse(variables);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(repositories),
      now: () => NOW,
    });

    const result = await service.getRecent();
    expect(result.releases).toHaveLength(11);
    const batches = executor.graphql.mock.calls.filter(([document]) =>
      document.includes("RecentReleasePulls"),
    );
    expect(batches).toHaveLength(2);
    expect(
      batches.map(
        ([, variables]) =>
          Object.keys(variables).filter((name) => name.startsWith("owner"))
            .length,
      ),
    ).toEqual([10, 1]);
  });

  it("isolates a failed exact pull batch and retains pulls from later batches", async () => {
    const node = releaseNode({
      body: Array.from(
        { length: 101 },
        (_, index) => `https://github.com/owner/repo/pull/${index + 1}`,
      ).join("\n"),
    });
    let pullBatch = 0;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) => {
        if (document.includes("RecentReleasePulls")) {
          pullBatch += 1;
          if (pullBatch === 1) throw new ExecutorError("failed");
          return pullBatchResponse(variables);
        }
        return recentGraphql(document, variables, [node]);
      }),
      rest: vi.fn(),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: true,
      releases: [{ pulls: [{ number: 101 }] }],
    });
  });

  it("uses exact REST pull fallback with the same authored merged validation", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [release({ body: "https://github.com/owner/repo/pull/7" })];
        }
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/releases/10") {
          return release({ body: "https://github.com/owner/repo/pull/7" });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [{ pulls: [{ number: 7 }] }],
    });
    expect(
      nonPipelineRestCalls(executor).map(([endpoint]) => endpoint),
    ).toEqual([
      "repos/owner/repo/releases?per_page=100&page=1",
      "user",
      "repos/owner/repo/pulls/7",
      "repos/owner/repo/releases/10",
    ]);
  });

  it("rejects a REST viewer change before loading linked pulls", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [release({ body: "https://github.com/owner/repo/pull/7" })];
        }
        if (endpoint === "user") return { login: "someone-else" };
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({ incomplete: false, items: [] }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).rejects.toMatchObject({
      code: "repository_catalog_changed",
    });
    expect(executor.rest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "repos/owner/repo/releases?per_page=100&page=1",
      "user",
    ]);
  });

  it("bypasses cached notes evidence and freshly authorizes exact comparison membership", async () => {
    let fresh = false;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) return search();
        if (endpoint.startsWith("repos/owner/repo/tags?"))
          return [{ name: "v1.2.4" }];
        if (endpoint === "repos/owner/repo/releases/10") {
          return fresh
            ? release()
            : release({ body: "https://github.com/owner/repo/pull/7" });
        }
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return fresh
            ? [
                release(),
                release({
                  id: 9,
                  tag: "v1.2.3",
                  published: "2026-04-01T00:00:00Z",
                }),
              ]
            : [release({ body: "https://github.com/owner/repo/pull/7" })];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?")) {
          return [
            {
              additions: 1,
              changes: 2,
              deletions: 1,
              filename: "src/fix.js",
              patch: "@@ -1 +1 @@\n-old\n+new",
              sha: SHA,
              status: "modified",
            },
          ];
        }
        if (endpoint.startsWith("repos/owner/repo/compare/"))
          return { status: "ahead" };
        if (endpoint.startsWith(`repos/owner/repo/commits/${SHA}/pulls?`))
          return [authoredPull()];
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: TAG_SHA, type: "tag" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === `repos/owner/repo/git/tags/${TAG_SHA}`) {
          return { object: { sha: RELEASE_SHA, type: "commit" } };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    expect((await service.getRecent()).releases[0].source).toBe(
      "notes-fallback",
    );
    fresh = true;
    await expect(
      service.resolveVerification({
        headSha: SHA,
        pullNumber: 7,
        pullUrl: "https://github.com/owner/repo/pull/7",
        releaseId: "10",
        repository: "owner/repo",
        tag: "v1.2.4",
      }),
    ).resolves.toMatchObject({
      context: expect.stringContaining("src/fix.js"),
      pull: { headSha: SHA, number: 7 },
      release: {
        commitOid: RELEASE_SHA,
        complete: true,
        id: "10",
        predecessorCommitOid: BASE_RELEASE_SHA,
        predecessorTag: "v1.2.3",
        source: "comparison",
        tag: "v1.2.4",
      },
    });
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/releases/10",
      ),
    ).toHaveLength(3);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/git/ref/tags/v1.2.4",
      ),
    ).toHaveLength(2);
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.startsWith("repos/owner/repo/compare/"),
      ),
    ).toHaveLength(2);
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        /\/commits\/[a-f0-9]{40}\/pulls/.test(endpoint),
      ),
    ).toBe(false);
  });

  it("rejects display-only notes membership and tag or pull identity drift", async () => {
    let tagCalls = 0;
    let moved = false;
    let wrongHead = false;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return moved || wrongHead
            ? [
                release(),
                release({
                  id: 9,
                  tag: "v1.2.3",
                  published: "2026-04-01T00:00:00Z",
                }),
              ]
            : [release({ body: "https://github.com/owner/repo/pull/7" })];
        }
        if (endpoint.startsWith("repos/owner/repo/compare/")) {
          return { status: moved || wrongHead ? "ahead" : "behind" };
        }
        if (endpoint.startsWith(`repos/owner/repo/commits/${SHA}/pulls?`))
          return [authoredPull()];
        if (endpoint === "repos/owner/repo/pulls/7") {
          return wrongHead
            ? authoredPull(7, { head: { sha: TAG_SHA } })
            : authoredPull();
        }
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?")) {
          return [
            {
              additions: 1,
              changes: 1,
              deletions: 0,
              filename: "src/fix.js",
              patch: "@@ -0,0 +1 @@\n+fix",
              sha: SHA,
              status: "added",
            },
          ];
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          tagCalls += 1;
          return {
            ref: "refs/tags/v1.2.4",
            object: {
              sha: moved && tagCalls % 2 === 0 ? TAG_SHA : RELEASE_SHA,
              type: "commit",
            },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    const input = {
      headSha: SHA,
      pullNumber: 7,
      pullUrl: "https://github.com/owner/repo/pull/7",
      releaseId: "10",
      repository: "owner/repo",
      tag: "v1.2.4",
    };
    await expect(service.resolveVerification(input)).resolves.toBeNull();

    moved = true;
    await expect(service.resolveVerification(input)).resolves.toBeNull();

    moved = false;
    wrongHead = true;
    await expect(service.resolveVerification(input)).resolves.toBeNull();
  });

  it("excludes a pull whose merge commit is exactly the predecessor boundary", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return [
            release(),
            release({
              id: 9,
              tag: "v1.2.3",
              published: "2026-04-01T00:00:00Z",
            }),
          ];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint.includes(`/compare/${BASE_RELEASE_SHA}...${SHA}`))
          return { status: "identical" };
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`))
          return { status: "ahead" };
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput()),
    ).resolves.toBeNull();
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/pulls/7/files?"),
      ),
    ).toBe(false);
  });

  it("finds the globally closest predecessor even when it appears on a later page", async () => {
    const closer = release({
      id: 11,
      tag: "v1.2.3-close",
      published: "2026-07-10T00:00:00Z",
    });
    const far = release({
      id: 9,
      tag: "v1.2.3-far",
      published: "2026-04-01T00:00:00Z",
    });
    const firstPage = [
      release(),
      far,
      ...Array.from({ length: 98 }, (_, index) =>
        release({
          id: index + 100,
          tag: `v0.0.${index + 1}`,
          published: "2026-03-01T00:00:00Z",
        }),
      ),
    ];
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return endpoint.endsWith("page=2") ? [closer] : firstPage;
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?"))
          return [changedFile()];
        if (endpoint.startsWith("repos/owner/repo/compare/"))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3-close") {
          return {
            ref: "refs/tags/v1.2.3-close",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput()),
    ).resolves.toMatchObject({
      pull: { number: 7 },
      release: { commitOid: RELEASE_SHA, source: "comparison" },
    });
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) =>
          endpoint === "repos/owner/repo/git/ref/tags/v1.2.3-close",
      ),
    ).toHaveLength(2);
    expect(
      executor.rest.mock.calls.some(
        ([endpoint]) => endpoint === "repos/owner/repo/git/ref/tags/v1.2.3-far",
      ),
    ).toBe(false);
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.startsWith("repos/owner/repo/releases?"),
      ),
    ).toHaveLength(4);
  });

  it("orders same-second releases by numeric GitHub release ID", async () => {
    const current = release({ id: 100, published: "2026-07-20T00:00:00Z" });
    const predecessor = release({
      id: 99,
      tag: "v1.2.3",
      published: "2026-07-20T00:00:00Z",
    });
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/100") return current;
        if (endpoint.startsWith("repos/owner/repo/releases?"))
          return [predecessor, current];
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?"))
          return [changedFile()];
        if (endpoint.startsWith("repos/owner/repo/compare/"))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput({ releaseId: "100" })),
    ).resolves.toMatchObject({
      pull: { number: 7 },
      release: { id: "100", source: "comparison" },
    });
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/git/ref/tags/v1.2.3",
      ),
    ).toHaveLength(2);
  });

  it("rejects verification when release adjacency changes after diff context is loaded", async () => {
    const predecessor = release({
      id: 9,
      tag: "v1.2.3",
      published: "2026-04-01T00:00:00Z",
    });
    const raced = release({
      id: 11,
      tag: "v1.2.3.5",
      published: "2026-07-10T00:00:00Z",
    });
    let releaseListCalls = 0;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          releaseListCalls += 1;
          return releaseListCalls === 1
            ? [release(), predecessor]
            : [release(), raced, predecessor];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?"))
          return [changedFile()];
        if (endpoint.startsWith("repos/owner/repo/compare/"))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput()),
    ).resolves.toBeNull();
    expect(releaseListCalls).toBe(2);
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/pulls/7/files?"),
      ),
    ).toBe(true);
  });

  it("verifies first-release membership against the release head without a lower bound", async () => {
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?"))
          return [release()];
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?"))
          return [changedFile()];
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput()),
    ).resolves.toMatchObject({
      context: expect.stringContaining("src/fix.js"),
      pull: { number: 7 },
      release: { commitOid: RELEASE_SHA, source: "comparison" },
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.startsWith("repos/owner/repo/compare/"),
      ),
    ).toHaveLength(1);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/git/ref/tags/v1.2.4",
      ),
    ).toHaveLength(2);
  });

  it("rejects first-release verification when a predecessor appears after context is loaded", async () => {
    const predecessor = release({
      id: 9,
      tag: "v1.2.3",
      published: "2026-04-01T00:00:00Z",
    });
    let releaseListCalls = 0;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return release();
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          releaseListCalls += 1;
          return releaseListCalls === 1
            ? [release()]
            : [release(), predecessor];
        }
        if (endpoint === "repos/owner/repo/pulls/7") return authoredPull();
        if (endpoint.startsWith("repos/owner/repo/pulls/7/files?"))
          return [changedFile()];
        if (endpoint.includes(`/compare/${SHA}...${RELEASE_SHA}`))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(
      service.resolveVerification(verificationInput()),
    ).resolves.toBeNull();
    expect(releaseListCalls).toBe(2);
    expect(
      executor.rest.mock.calls.some(([endpoint]) =>
        endpoint.includes("/pulls/7/files?"),
      ),
    ).toBe(true);
  });

  it("snapshots exact current authored release membership and rejects pull identity drift", async () => {
    const current = release({
      body: [
        "https://github.com/owner/repo/pull/7",
        "https://github.com/owner/repo/pull/8",
        "https://github.com/owner/repo/pull/8",
        "https://github.com/owner/repo/pull/9",
      ].join("\n"),
    });
    const predecessor = release({
      id: 9,
      tag: "v1.2.3",
      published: "2026-04-01T00:00:00Z",
    });
    let drift = false;
    let pullSevenReads = 0;
    const executor = {
      action: vi.fn(),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint === "repos/owner/repo/releases/10") return current;
        if (endpoint.startsWith("repos/owner/repo/releases?"))
          return [current, predecessor];
        if (endpoint === "repos/owner/repo/pulls/7") {
          pullSevenReads += 1;
          return drift && pullSevenReads % 2 === 0
            ? authoredPull(7, { head: { sha: TAG_SHA } })
            : authoredPull(7);
        }
        if (endpoint === "repos/owner/repo/pulls/8") return authoredPull(8);
        if (endpoint === "repos/owner/repo/pulls/9") {
          return authoredPull(9, { user: { login: "someone-else" } });
        }
        if (endpoint.startsWith("repos/owner/repo/compare/"))
          return { status: "ahead" };
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          return {
            ref: "refs/tags/v1.2.4",
            object: { sha: RELEASE_SHA, type: "commit" },
          };
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.3") {
          return {
            ref: "refs/tags/v1.2.3",
            object: { sha: BASE_RELEASE_SHA, type: "commit" },
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });
    const releaseIdentity = {
      releaseId: "10",
      repository: "owner/repo",
      tag: "v1.2.4",
    };

    await expect(
      service.resolveReleaseVerifications(releaseIdentity),
    ).resolves.toMatchObject({
      pulls: [
        { number: 7, headSha: SHA },
        { number: 8, headSha: SHA },
      ],
      release: {
        commitOid: RELEASE_SHA,
        complete: true,
        id: "10",
        source: "comparison",
      },
    });
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/pulls/8",
      ),
    ).toHaveLength(2);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint]) => endpoint === "repos/owner/repo/pulls/9",
      ),
    ).toHaveLength(1);

    drift = true;
    await expect(
      service.resolveReleaseVerifications(releaseIdentity),
    ).rejects.toMatchObject({
      code: "verification_membership_changed",
    });
  });

  it("seeds only fresh uncached release identities as pending", async () => {
    async function seededPipeline(publishedAt) {
      const node = releaseNode({
        created: publishedAt,
        published: publishedAt,
      });
      const executor = {
        action: vi.fn(),
        graphql: vi.fn(async (document, variables) =>
          recentGraphql(document, variables, [node]),
        ),
        rest: vi.fn(),
      };
      const service = createReleaseService({
        executor,
        loadMergedPulls: async () => ({
          incomplete: false,
          items: [mergedCandidateWithPull()],
        }),
        loadOpenPulls: async () => openSnapshot(),
        now: () => NOW,
      });

      const result = await service.getRecent();
      expect(executor.rest).not.toHaveBeenCalled();
      return result.releases[0].pipeline;
    }

    await expect(seededPipeline("2026-07-20T23:55:01Z")).resolves.toMatchObject(
      {
        lookup: "pending",
        runs: [],
      },
    );
    await expect(seededPipeline("2026-07-20T23:55:00Z")).resolves.toMatchObject(
      {
        lookup: "complete",
        runs: [],
      },
    );
  });

  it("expires an exact cached empty pending pipeline after discovery ends", async () => {
    let current = NOW;
    const publishedAt = "2026-07-20T23:59:00Z";
    const node = releaseNode({
      created: publishedAt,
      published: publishedAt,
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/actions/runs?")) {
          return { total_count: 0, workflow_runs: [] };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => current,
    });

    expect((await service.getRecent()).releases[0].pipeline).toMatchObject({
      lookup: "pending",
      runs: [],
    });
    expect(
      (await service.getPipelines({ refresh: true })).releases[0].pipeline,
    ).toMatchObject({
      lookup: "pending",
      runs: [],
    });
    expect(executor.rest).toHaveBeenCalledTimes(1);

    current = Date.parse("2026-07-21T00:04:00Z");
    expect(
      (await service.getRecent({ refresh: true })).releases[0].pipeline,
    ).toMatchObject({
      checkedAt: "2026-07-21T00:04:00.000Z",
      lookup: "complete",
      runs: [],
    });
    expect(executor.rest).toHaveBeenCalledTimes(1);
  });

  it("refreshes pipeline-only evidence without reloading release membership and syncs the recent cache", async () => {
    let status = "in_progress";
    let conclusion = null;
    const loadOpenPulls = vi.fn(async () => openSnapshot());
    const loadMergedPulls = vi.fn(async () => ({
      incomplete: false,
      items: [mergedCandidateWithPull()],
    }));
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/actions/runs?")) {
          return {
            total_count: 1,
            workflow_runs: [
              {
                conclusion,
                created_at: "2026-07-20T00:00:01.000Z",
                event: "release",
                head_branch: "v1.2.4",
                html_url: "https://github.com/owner/repo/actions/runs/100",
                id: 100,
                name: "Production Deployment",
                path: ".github/workflows/production.yml",
                repository: { full_name: "owner/repo" },
                run_attempt: 1,
                run_started_at: "2026-07-20T00:00:01.000Z",
                status,
                updated_at:
                  status === "completed"
                    ? "2026-07-20T00:05:00.000Z"
                    : "2026-07-20T00:01:00.000Z",
                workflow_id: 50,
              },
            ],
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls,
      loadOpenPulls,
      now: () => NOW,
    });

    const initial = await service.getRecent();
    expect(initial.releases[0].pipeline).toMatchObject({
      lookup: "complete",
      runs: [],
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.includes("/actions/runs?"),
      ),
    ).toHaveLength(0);
    const running = await service.getPipelines({ refresh: true });
    expect(running.releases[0].pipeline.runs[0]).toMatchObject({
      name: "Production Deployment",
      state: "running",
    });
    const actionCallsWhileRunning = executor.rest.mock.calls.filter(
      ([endpoint]) => endpoint.includes("/actions/runs?"),
    ).length;
    expect(
      (await service.getRecent({ refresh: true })).releases[0].pipeline.runs[0],
    ).toMatchObject({
      id: "100",
      state: "running",
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.includes("/actions/runs?"),
      ),
    ).toHaveLength(actionCallsWhileRunning);
    const graphqlCalls = executor.graphql.mock.calls.length;
    const openCalls = loadOpenPulls.mock.calls.length;
    const mergedCalls = loadMergedPulls.mock.calls.length;

    status = "completed";
    conclusion = "success";
    const actionCalls = executor.rest.mock.calls.filter(([endpoint]) =>
      endpoint.includes("/actions/runs?"),
    ).length;
    const [pipelines, coalesced] = await Promise.all([
      service.getPipelines({ refresh: true }),
      service.getPipelines({ refresh: true }),
    ]);
    expect(pipelines.releases[0].pipeline.runs[0]).toMatchObject({
      state: "succeeded",
    });
    expect(coalesced).toEqual(pipelines);
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.includes("/actions/runs?"),
      ),
    ).toHaveLength(actionCalls + 1);
    expect(executor.graphql).toHaveBeenCalledTimes(graphqlCalls);
    expect(loadOpenPulls).toHaveBeenCalledTimes(openCalls);
    expect(loadMergedPulls).toHaveBeenCalledTimes(mergedCalls);
    expect(
      (await service.getRecent()).releases[0].pipeline.runs[0],
    ).toMatchObject({
      state: "succeeded",
    });

    const actionCallsBeforeMembershipRefresh = executor.rest.mock.calls.filter(
      ([endpoint]) => endpoint.includes("/actions/runs?"),
    ).length;
    const graphqlCallsBeforeMembershipRefresh =
      executor.graphql.mock.calls.length;
    const refreshed = await service.getRecent({ refresh: true });
    expect(refreshed.releases[0].pipeline.runs[0]).toMatchObject({
      id: "100",
      state: "succeeded",
    });
    expect(
      executor.rest.mock.calls.filter(([endpoint]) =>
        endpoint.includes("/actions/runs?"),
      ),
    ).toHaveLength(actionCallsBeforeMembershipRefresh);
    expect(executor.graphql.mock.calls.length).toBeGreaterThan(
      graphqlCallsBeforeMembershipRefresh,
    );
  });

  it("coalesces five-second exact polls and confirms a terminal transition once", async () => {
    let clock = NOW;
    let conclusion = null;
    let status = "in_progress";
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const node = releaseNode({
      created: publishedAt,
      published: publishedAt,
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node]),
      ),
      rest: vi.fn(async (endpoint) => {
        const value = pipelineRun({
          conclusion,
          createdAt: "2026-07-20T23:59:01.000Z",
          status,
          updatedAt:
            status === "completed"
              ? "2026-07-20T23:59:05.000Z"
              : "2026-07-20T23:59:02.000Z",
        });
        if (endpoint === "repos/owner/repo/actions/runs/100") return value;
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        return {
          total_count: 1,
          workflow_runs: [value],
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    const [first, concurrent] = await Promise.all([
      service.getPipelines(),
      service.getPipelines(),
    ]);
    expect(concurrent).toEqual(first);
    expect(first.releases[0].pipeline.runs[0].state).toBe("running");
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 4_999;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 1;
    conclusion = "success";
    status = "completed";
    const terminal = await service.getPipelines();
    expect(terminal.releases[0].pipeline.runs[0].state).toBe("succeeded");
    expect(executor.rest).toHaveBeenCalledTimes(2);

    expect(executor.rest.mock.calls[1][0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    clock += 4_999;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(2);

    clock += 1;
    const confirmed = await service.getPipelines();
    expect(confirmed.releases[0].pipeline.runs[0].state).toBe("succeeded");
    expect(executor.rest).toHaveBeenCalledTimes(3);
    expect(executor.rest.mock.calls[2][0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    clock += 19_999;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(3);

    clock += 1;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(4);
    expect(executor.rest.mock.calls[3][0]).toContain("/actions/runs?");
  });

  it("quickly discovers delayed workflows and checks for follow-up deployments after terminal", async () => {
    let clock = NOW;
    let discoveries = 0;
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const node = releaseNode({
      created: publishedAt,
      published: publishedAt,
    });
    const production = (status = "in_progress") =>
      pipelineRun({
        conclusion: status === "completed" ? "success" : null,
        createdAt: "2026-07-20T23:59:01.000Z",
        status,
        updatedAt:
          status === "completed"
            ? "2026-07-20T23:59:05.000Z"
            : "2026-07-20T23:59:02.000Z",
      });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "repos/owner/repo/actions/runs/100") {
          return production("completed");
        }
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        discoveries += 1;
        const workflowRuns =
          discoveries === 1
            ? []
            : discoveries === 2
              ? [production()]
              : [
                  production("completed"),
                  pipelineRun({
                    createdAt: "2026-07-20T23:59:06.000Z",
                    id: 101,
                    name: "Publish Images",
                    updatedAt: "2026-07-20T23:59:07.000Z",
                    workflowId: 51,
                  }),
                ];
        return {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    expect((await service.getPipelines()).releases[0].pipeline).toMatchObject({
      lookup: "pending",
      runs: [],
    });

    clock += 4_999;
    await service.getPipelines();
    expect(discoveries).toBe(1);

    clock += 1;
    expect(
      (await service.getPipelines()).releases[0].pipeline.runs[0],
    ).toMatchObject({ id: "100", state: "running" });
    expect(discoveries).toBe(2);

    clock += 5_000;
    expect(
      (await service.getPipelines()).releases[0].pipeline.runs[0],
    ).toMatchObject({ id: "100", state: "succeeded" });
    expect(executor.rest.mock.calls.at(-1)[0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    clock += 5_000;
    await service.getPipelines();
    expect(executor.rest.mock.calls.at(-1)[0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    clock += 19_999;
    await service.getPipelines();
    expect(discoveries).toBe(2);

    clock += 1;
    const followup = await service.getPipelines();
    expect(discoveries).toBe(3);
    expect(followup.releases[0].pipeline.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "101", state: "running" }),
      ]),
    );
  });

  it("discovers a second workflow while the first workflow remains active", async () => {
    let clock = NOW;
    let discoveries = 0;
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const first = pipelineRun({
      createdAt: "2026-07-20T23:59:01.000Z",
      id: 100,
      name: "Production Deployment",
      workflowId: 50,
    });
    const second = pipelineRun({
      createdAt: "2026-07-20T23:59:10.000Z",
      id: 101,
      name: "Publish Images",
      updatedAt: "2026-07-20T23:59:11.000Z",
      workflowId: 51,
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [
          releaseNode({
            created: publishedAt,
            published: publishedAt,
          }),
        ]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "repos/owner/repo/actions/runs/100") return first;
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        discoveries += 1;
        const workflowRuns = discoveries === 1 ? [first] : [first, second];
        return {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    expect((await service.getPipelines()).releases[0].pipeline.runs).toEqual([
      expect.objectContaining({ id: "100", state: "running" }),
    ]);

    clock += 5_000;
    await service.getPipelines();
    expect(executor.rest.mock.calls.at(-1)[0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    clock += 25_000;
    const updated = await service.getPipelines();
    expect(discoveries).toBe(2);
    expect(executor.rest.mock.calls.at(-1)[0]).toContain("/actions/runs?");
    expect(updated.releases[0].pipeline.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "100", state: "running" }),
        expect.objectContaining({ id: "101", state: "running" }),
      ]),
    );
  });

  it("batches multiple due active workflows into one repository poll", async () => {
    let clock = NOW;
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const runs = [
      pipelineRun({
        createdAt: "2026-07-20T23:59:01.000Z",
        id: 100,
        name: "Production Deployment",
        workflowId: 50,
      }),
      pipelineRun({
        createdAt: "2026-07-20T23:59:02.000Z",
        id: 101,
        name: "Publish Images",
        updatedAt: "2026-07-20T23:59:03.000Z",
        workflowId: 51,
      }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [
          releaseNode({
            created: publishedAt,
            published: publishedAt,
          }),
        ]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        return {
          total_count: runs.length,
          workflow_runs: runs,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    await service.getPipelines();
    clock += 5_000;
    await service.getPipelines();

    expect(executor.rest).toHaveBeenCalledTimes(2);
    expect(
      executor.rest.mock.calls.every(([endpoint]) =>
        endpoint.includes("/actions/runs?"),
      ),
    ).toBe(true);
  });

  it("discovers the first workflow after the release is older than five minutes", async () => {
    let clock = NOW;
    let discoveries = 0;
    const publishedAt = "2026-07-20T23:54:00.000Z";
    const deployment = pipelineRun({
      createdAt: "2026-07-20T23:59:30.000Z",
      name: "Production Deployment",
      updatedAt: "2026-07-20T23:59:31.000Z",
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [
          releaseNode({
            created: publishedAt,
            published: publishedAt,
          }),
        ]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        discoveries += 1;
        const workflowRuns = discoveries === 1 ? [] : [deployment];
        return {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    expect((await service.getPipelines()).releases[0].pipeline.runs).toEqual(
      [],
    );

    clock += 29_999;
    await service.getPipelines();
    expect(discoveries).toBe(1);

    clock += 1;
    const updated = await service.getPipelines();
    expect(discoveries).toBe(2);
    expect(updated.releases[0].pipeline.runs).toEqual([
      expect.objectContaining({
        name: "Production Deployment",
        state: "running",
      }),
    ]);
  });

  it("batches background discovery across the one-week release view", async () => {
    const recentPublishedAt = "2026-07-20T23:59:00.000Z";
    const nodes = [
      releaseNode({
        created: recentPublishedAt,
        published: recentPublishedAt,
      }),
      releaseNode({
        body: "https://github.com/owner/repo/pull/8",
        created: "2026-07-20T01:00:00.000Z",
        databaseId: 11,
        published: "2026-07-20T01:00:00.000Z",
        tag: "v1.2.3",
      }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        return { total_count: 0, workflow_runs: [] };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull(), mergedCandidateWithPull(8)],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await service.getRecent();
    await service.getPipelines();

    expect(executor.rest).toHaveBeenCalledOnce();
    const endpoint = new URL(
      executor.rest.mock.calls[0][0],
      "https://api.github.com/",
    );
    expect(endpoint.searchParams.get("created")).toBe(
      ">=2026-07-20T01:00:00.000Z",
    );
    expect(endpoint.searchParams.get("branch")).toBeNull();
  });

  it("limits targeted discovery to releases that can gain workflow evidence", async () => {
    let clock = NOW;
    const recentPublishedAt = "2026-07-20T23:59:00.000Z";
    const olderPublishedAt = "2026-07-20T01:00:00.000Z";
    const nodes = [
      releaseNode({
        created: recentPublishedAt,
        published: recentPublishedAt,
      }),
      releaseNode({
        body: "https://github.com/owner/repo/pull/8",
        created: olderPublishedAt,
        databaseId: 11,
        published: olderPublishedAt,
        tag: "v1.2.3",
      }),
    ];
    let initializing = true;
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        const workflowRuns = initializing
          ? [
              pipelineRun({
                conclusion: "success",
                createdAt: "2026-07-20T01:00:01.000Z",
                headBranch: "v1.2.3",
                status: "completed",
                updatedAt: "2026-07-20T01:05:00.000Z",
              }),
            ]
          : [];
        return {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull(), mergedCandidateWithPull(8)],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    await service.getPipelines({ refresh: true });
    clock += 5_000;
    await service.getPipelines();
    initializing = false;
    executor.rest.mockClear();
    clock += 5_000;

    await service.getPipelines({ discover: true });

    expect(executor.rest).toHaveBeenCalledOnce();
    const endpoint = new URL(
      executor.rest.mock.calls[0][0],
      "https://api.github.com/",
    );
    expect(endpoint.searchParams.get("created")).toBe(`>=${recentPublishedAt}`);
    expect(endpoint.searchParams.get("branch")).toBeNull();
  });

  it("coalesces and caches targeted discovery while manual refresh bypasses its TTL", async () => {
    let clock = NOW;
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [
          releaseNode({
            created: publishedAt,
            published: publishedAt,
          }),
        ]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        return {
          total_count: 0,
          workflow_runs: [],
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    await Promise.all([
      service.getPipelines({ discover: true }),
      service.getPipelines({ discover: true }),
    ]);
    await service.getPipelines({ discover: true });
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 4_999;
    await service.getPipelines({ discover: true });
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 1;
    await service.getPipelines({ discover: true });
    expect(executor.rest).toHaveBeenCalledTimes(2);

    await service.getPipelines({ refresh: true });
    expect(executor.rest).toHaveBeenCalledTimes(3);
  });

  it("backs off repeated GitHub pipeline failures while retaining cached state", async () => {
    let clock = NOW;
    const publishedAt = "2026-07-20T23:59:00.000Z";
    const node = releaseNode({
      created: publishedAt,
      published: publishedAt,
    });
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, [node]),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/actions/runs?")) {
          throw new ExecutorError("api_rejected", 429);
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    const first = await service.getPipelines();
    expect(first.releases[0].pipeline).toMatchObject({
      lookup: "pending",
      runs: [],
    });
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 4_999;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledOnce();

    clock += 1;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(2);

    clock += 9_999;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(2);

    clock += 1;
    const retained = await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(3);
    expect(retained.releases[0].pipeline).toMatchObject({
      lookup: "pending",
      runs: [],
    });
  });

  it("retains completed workflow and omitted release evidence across narrow and unavailable polls", async () => {
    let clock = NOW;
    let mode = "initial";
    const nodes = [
      releaseNode(),
      releaseNode({
        body: "https://github.com/owner/repo/pull/8",
        created: "2026-07-20T01:00:00.000Z",
        databaseId: 11,
        published: "2026-07-20T01:00:00.000Z",
        tag: "v1.2.5",
      }),
    ];
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables, nodes),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "repos/owner/repo/actions/runs/100") {
          return pipelineRun({
            conclusion: "success",
            id: 100,
            status: "completed",
            workflowId: 50,
          });
        }
        if (endpoint === "repos/owner/repo/actions/runs/101") {
          if (mode === "failed") throw new Error("Actions unavailable");
          return pipelineRun({
            id: 101,
            updatedAt: "2026-07-20T00:02:00.000Z",
            workflowId: 51,
          });
        }
        if (endpoint === "repos/owner/repo/actions/runs/200") {
          return pipelineRun({
            conclusion: "success",
            createdAt: "2026-07-20T01:00:01.000Z",
            headBranch: "v1.2.5",
            id: 200,
            status: "completed",
            updatedAt: "2026-07-20T01:05:00.000Z",
            workflowId: 60,
          });
        }
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        if (mode === "failed") throw new Error("Actions unavailable");
        const workflowRuns =
          mode === "initial"
            ? [
                pipelineRun({
                  conclusion: "success",
                  id: 100,
                  status: "completed",
                  workflowId: 50,
                }),
                pipelineRun({ id: 101, workflowId: 51 }),
                pipelineRun({
                  conclusion: "success",
                  createdAt: "2026-07-20T01:00:01.000Z",
                  headBranch: "v1.2.5",
                  id: 200,
                  status: "completed",
                  updatedAt: "2026-07-20T01:05:00.000Z",
                  workflowId: 60,
                }),
              ]
            : [
                pipelineRun({
                  id: 101,
                  updatedAt: "2026-07-20T00:02:00.000Z",
                  workflowId: 51,
                }),
              ];
        return {
          total_count: workflowRuns.length,
          workflow_runs: workflowRuns,
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull(), mergedCandidateWithPull(8)],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    const initial = await service.getPipelines({ refresh: true });
    expect(initial.releases).toHaveLength(2);

    mode = "narrow";
    const narrow = await service.getPipelines();
    const active = narrow.releases.find((release) => release.id === "10");
    const omitted = narrow.releases.find((release) => release.id === "11");
    expect(active.pipeline.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "succeeded", workflowId: "50" }),
        expect.objectContaining({ state: "running", workflowId: "51" }),
      ]),
    );
    expect(omitted.pipeline.runs).toEqual([
      expect.objectContaining({ state: "succeeded", workflowId: "60" }),
    ]);

    mode = "failed";
    clock += 5_000;
    const unavailable = await service.getPipelines();
    const failedActive = unavailable.releases.find(
      (release) => release.id === "10",
    );
    const failedOmitted = unavailable.releases.find(
      (release) => release.id === "11",
    );
    expect(failedActive.pipeline.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "succeeded", workflowId: "50" }),
        expect.objectContaining({ state: "running", workflowId: "51" }),
      ]),
    );
    expect(failedOmitted.pipeline).toMatchObject({
      lookup: "complete",
      runs: omitted.pipeline.runs,
    });
  });

  it("uses an explicit all-target sweep to discover a later workflow rerun", async () => {
    let clock = NOW;
    let attempt = 1;
    let status = "completed";
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint === "repos/owner/repo/actions/runs/100") {
          return pipelineRun({
            attempt,
            conclusion: status === "completed" ? "success" : null,
            status,
            updatedAt:
              attempt === 1
                ? "2026-07-20T00:05:00.000Z"
                : "2026-07-20T00:10:00.000Z",
          });
        }
        if (!endpoint.includes("/actions/runs?")) {
          throw new Error(`Unexpected endpoint ${endpoint}`);
        }
        return {
          total_count: 1,
          workflow_runs: [
            pipelineRun({
              attempt,
              conclusion: status === "completed" ? "success" : null,
              status,
              updatedAt:
                attempt === 1
                  ? "2026-07-20T00:05:00.000Z"
                  : "2026-07-20T00:10:00.000Z",
            }),
          ],
        };
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => clock,
    });

    await service.getRecent();
    const terminal = await service.getPipelines({ refresh: true });
    expect(terminal.releases[0].pipeline.runs[0]).toMatchObject({
      attempt: 1,
      state: "succeeded",
    });
    clock += 5_000;
    await service.getPipelines();
    expect(executor.rest).toHaveBeenCalledTimes(2);
    expect(executor.rest.mock.calls[1][0]).toBe(
      "repos/owner/repo/actions/runs/100",
    );

    attempt = 2;
    status = "in_progress";
    const rerun = await service.getPipelines({ refresh: true });
    expect(rerun.releases[0].pipeline.runs[0]).toMatchObject({
      attempt: 2,
      state: "running",
    });
    expect(executor.rest).toHaveBeenCalledTimes(3);
    expect(executor.rest.mock.calls[2][0]).toContain("/actions/runs?");
  });

  it("keeps pipeline lookup failures local to release cards and out of recent warnings", async () => {
    const executor = {
      action: vi.fn(),
      graphql: vi.fn(async (document, variables) =>
        recentGraphql(document, variables),
      ),
      rest: vi.fn(async (endpoint) => {
        if (endpoint.includes("/actions/runs?"))
          throw new Error("actions unavailable");
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    const service = createReleaseService({
      executor,
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedCandidateWithPull()],
      }),
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
    });

    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      releases: [
        {
          pipeline: {
            lookup: "complete",
            runs: [],
          },
        },
      ],
      warnings: [],
    });
    expect(executor.rest).not.toHaveBeenCalled();
    await expect(
      service.getPipelines({ refresh: true }),
    ).resolves.toMatchObject({
      releases: [
        {
          pipeline: {
            lookup: "unavailable",
            runs: [],
          },
        },
      ],
    });
    await expect(service.getRecent()).resolves.toMatchObject({
      partial: false,
      warnings: [],
    });
  });

  it("requires a stored recent snapshot before pipeline-only refreshes", async () => {
    const loadOpenPulls = vi.fn(async () => openSnapshot());
    const service = createReleaseService({
      executor: {
        action: vi.fn(),
        rest: vi.fn(),
      },
      loadOpenPulls,
      now: () => NOW,
    });

    await expect(service.getPipelines({ refresh: true })).rejects.toMatchObject(
      {
        code: "release_pipelines_unavailable",
        status: 409,
      },
    );
    expect(loadOpenPulls).not.toHaveBeenCalled();
  });
});

describe("verification context", () => {
  it("reserves room for an explicit marker when a file exceeds the byte boundary", async () => {
    const header =
      "Exact GitHub pull-request file evidence (untrusted content):";
    const first = [
      'File: "a.js"',
      "Status: modified; additions=1; deletions=0",
      "Patch:",
      "+a",
    ].join("\n");
    const expected = [header, first, VERIFICATION_OMISSION_MARKER].join("\n\n");
    const maximumBytes = Buffer.byteLength(expected, "utf8");
    const executor = {
      rest: vi.fn(async () => [
        {
          additions: 1,
          deletions: 0,
          filename: "a.js",
          patch: "+a",
          status: "modified",
        },
        {
          additions: 100,
          deletions: 0,
          filename: "emoji.js",
          patch: "🙂".repeat(100),
          status: "modified",
        },
      ]),
    };

    const context = await loadVerificationContext(executor, "owner/repo", 7, {
      maximumBytes,
    });

    expect(context).toBe(expected);
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(
      maximumBytes,
    );
    expect(context).not.toContain("emoji.js");
  });

  it("marks GitHub-omitted patches as incomplete without exceeding a multibyte-safe budget", async () => {
    const executor = {
      rest: vi.fn(async () => [
        {
          additions: 2,
          deletions: 1,
          filename: "日本語.js",
          status: "modified",
        },
      ]),
    };
    const maximumBytes = 512;

    const context = await loadVerificationContext(executor, "owner/repo", 7, {
      maximumBytes,
    });

    expect(context).toContain("Patch unavailable");
    expect(context).toContain(VERIFICATION_OMISSION_MARKER);
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(
      maximumBytes,
    );
  });
});

describe("release creation", () => {
  function creationFixture({
    baseTags = ["v1.2.3"],
    draftPrerelease,
    draftFails = false,
    draftLost = 0,
    foreignReference = false,
    foreignRelease = false,
    generatedNotes = {
      body: "## What’s Changed\n\nGenerated notes",
      name: "Generated v1.2.4",
    },
    omitDraftPrerelease = false,
    publishedPrerelease,
    publishFails = false,
    publishAfterReleaseRead = null,
    publishLost = 0,
    changeBodyOnReleaseRead = null,
    changeNameOnReleaseRead = null,
    changePrereleaseOnReleaseRead = null,
    referenceLost = 0,
    tagObjectLost = 0,
    moveOnReferenceRead = null,
    moveAfterReferenceRead = null,
  } = {}) {
    const state = {
      draftLost,
      publishLost,
      reference: null,
      referenceReads: 0,
      referenceLost,
      release: null,
      releaseReads: 0,
      tagObjectExists: false,
      tagObjectLost,
      tagObjectOid: null,
      tagObjectPayloads: [],
    };
    const missing = () => new ExecutorError("failed");
    const notFound = () => {
      const error = missing();
      error.status = 404;
      return error;
    };
    const published = () => ({
      body: state.release.body,
      draft: false,
      html_url: "https://github.com/owner/repo/releases/tag/v1.2.4",
      id: 10,
      name: state.release.name,
      prerelease: publishedPrerelease ?? state.release.prerelease,
      published_at: "2026-07-21T00:00:00Z",
      tag_name: state.release.tag_name,
    });
    const executor = {
      action: vi.fn(async (args) => {
        if (args[1] === "repos/owner/repo/releases/10") {
          state.release = null;
          throw new ExecutorError("timeout");
        }
        if (args[1] === "repos/owner/repo/git/refs/tags/v1.2.4") {
          state.reference = null;
          throw new ExecutorError("timeout");
        }
        throw new Error(`Unexpected action ${args.join(" ")}`);
      }),
      rest: vi.fn(async (endpoint, options = {}) => {
        if (endpoint === "user") return { login: "viewer" };
        if (endpoint.startsWith("search/issues?")) return search();
        if (endpoint.startsWith("repos/owner/repo/tags?")) {
          return [...baseTags, ...(state.reference ? ["v1.2.4"] : [])].map(
            (name) => ({ name }),
          );
        }
        if (endpoint === "repos/owner/repo") return { default_branch: "main" };
        if (endpoint === "repos/owner/repo/commits/main")
          return { sha: RELEASE_SHA };
        if (
          endpoint === "repos/owner/repo/releases/generate-notes" &&
          options.method === "POST"
        ) {
          return { ...generatedNotes };
        }
        if (
          endpoint === "repos/owner/repo/git/tags" &&
          options.method === "POST"
        ) {
          state.tagObjectOid = annotatedTagSha(options.fields);
          state.tagObjectExists = true;
          state.tagObjectPayloads.push(JSON.stringify(options.fields));
          const value = {
            message: options.fields.message,
            object: { sha: RELEASE_SHA, type: "commit" },
            sha: state.tagObjectOid,
            tag: options.fields.tag,
            tagger: options.fields.tagger,
          };
          if (state.tagObjectLost > 0) {
            state.tagObjectLost -= 1;
            throw new ExecutorError("timeout");
          }
          return value;
        }
        if (
          state.tagObjectExists &&
          endpoint === `repos/owner/repo/git/tags/${state.tagObjectOid}`
        ) {
          return {
            message: "<!-- puller-release:transaction -->\n",
            object: { sha: RELEASE_SHA, type: "commit" },
            sha: state.tagObjectOid,
            tag: "v1.2.4",
            tagger: {
              date: "2026-07-21T00:00:00.000Z",
              email: "puller@users.noreply.github.com",
              name: "Puller",
            },
          };
        }
        if (
          endpoint === "repos/owner/repo/git/refs" &&
          options.method === "POST"
        ) {
          state.reference = foreignReference
            ? { oid: BASE_RELEASE_SHA, type: "commit" }
            : { oid: options.fields.sha, type: "tag" };
          if (foreignReference) throw new Error("Reference already exists");
          const value = {
            object: { sha: options.fields.sha, type: "tag" },
            ref: "refs/tags/v1.2.4",
          };
          if (state.referenceLost > 0) {
            state.referenceLost -= 1;
            throw new ExecutorError("timeout");
          }
          return value;
        }
        if (endpoint === "repos/owner/repo/git/ref/tags/v1.2.4") {
          if (!state.reference) throw notFound();
          state.referenceReads += 1;
          if (state.referenceReads === moveOnReferenceRead) {
            state.reference = { oid: BASE_RELEASE_SHA, type: "commit" };
          }
          const value = {
            object: { sha: state.reference.oid, type: state.reference.type },
            ref: "refs/tags/v1.2.4",
          };
          if (state.referenceReads === moveAfterReferenceRead) {
            state.reference = { oid: BASE_RELEASE_SHA, type: "commit" };
          }
          return value;
        }
        if (
          endpoint === "repos/owner/repo/releases" &&
          options.method === "POST"
        ) {
          if (draftFails) throw new ExecutorError("timeout");
          state.release = foreignRelease
            ? {
                body: "foreign",
                draft: true,
                id: 11,
                prerelease: false,
                tag_name: "v1.2.4",
              }
            : {
                body: options.fields.body,
                draft: true,
                id: 10,
                name: options.fields.name,
                ...(omitDraftPrerelease
                  ? {}
                  : {
                      prerelease: draftPrerelease ?? options.fields.prerelease,
                    }),
                tag_name: options.fields.tag_name,
              };
          if (foreignRelease) throw new Error("Already exists");
          if (state.draftLost > 0) {
            state.draftLost -= 1;
            throw new ExecutorError("timeout");
          }
          return state.release;
        }
        if (
          endpoint === "repos/owner/repo/releases/10" &&
          options.method === "PATCH"
        ) {
          if (publishFails) throw new ExecutorError("timeout");
          state.release = published();
          if (state.publishLost > 0) {
            state.publishLost -= 1;
            throw new ExecutorError("timeout");
          }
          return state.release;
        }
        if (endpoint === "repos/owner/repo/releases/10") {
          if (!state.release || String(state.release.id) !== "10")
            throw notFound();
          state.releaseReads += 1;
          if (state.releaseReads === changeBodyOnReleaseRead) {
            state.release.body = "Changed by release automation.";
          }
          if (state.releaseReads === changeNameOnReleaseRead) {
            state.release.name = "Changed by release automation";
          }
          if (state.releaseReads === changePrereleaseOnReleaseRead) {
            state.release.prerelease = !state.release.prerelease;
          }
          const value = { ...state.release };
          if (state.releaseReads === publishAfterReleaseRead) {
            state.release = published();
          }
          return value;
        }
        if (endpoint === "repos/owner/repo/releases/tags/v1.2.4") {
          if (!state.release) throw notFound();
          return state.release;
        }
        if (endpoint.startsWith("repos/owner/repo/releases?")) {
          return state.release ? [state.release] : [];
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }),
    };
    return { executor, state };
  }

  function serviceFor(executor, overrides = {}) {
    return createReleaseService({
      executor,
      identifier: () => "transaction",
      loadOpenPulls: async () => openSnapshot(),
      now: () => NOW,
      ...overrides,
    });
  }

  const input = {
    expectedLatestTag: "v1.2.3",
    prerelease: false,
    preview: releasePreview(),
    repository: "owner/repo",
    tag: "v1.2.4",
  };
  const prereleaseInput = { ...input, prerelease: true };

  it("creates an ownership-marked annotated tag and publishes REST-generated notes", async () => {
    const { executor, state } = creationFixture();
    const invalidateReadiness = vi.fn();
    const refetch = vi.fn();
    const service = serviceFor(executor, { invalidateReadiness, refetch });

    await expect(service.create(input)).resolves.toMatchObject({
      id: "10",
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/git/tags", {
      fields: {
        message: "<!-- puller-release:transaction -->\n",
        object: RELEASE_SHA,
        tag: "v1.2.4",
        tagger: {
          date: "2026-07-21T00:00:00.000Z",
          email: "puller@users.noreply.github.com",
          name: "Puller",
        },
        type: "commit",
      },
      method: "POST",
      validate: expect.any(Function),
    });
    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/releases", {
      fields: {
        body: "<!-- puller-release:transaction -->\n\n## What’s Changed\n\nGenerated notes",
        draft: true,
        generate_release_notes: false,
        name: "Generated v1.2.4",
        prerelease: false,
        tag_name: "v1.2.4",
        target_commitish: RELEASE_SHA,
      },
      method: "POST",
      validate: expect.any(Function),
    });
    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/releases/10", {
      fields: {
        draft: false,
        prerelease: false,
      },
      method: "PATCH",
      validate: expect.any(Function),
    });
    expect(state.release.body).toContain("Generated notes");
    expect(state.release.draft).toBe(false);
    expect(invalidateReadiness).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("publishes the exact canonical release content that was reviewed", async () => {
    const body = [
      "## What’s Changed",
      "",
      "* Reviewed fix by @alice in https://github.com/owner/repo/pull/7",
    ].join("\n");
    const name = "Reviewed v1.2.4";
    const preview = releasePreview({
      body,
      name,
      pulls: [
        {
          number: 7,
          title: "Reviewed fix",
          url: "https://github.com/owner/repo/pull/7",
        },
      ],
    });
    const { executor, state } = creationFixture({
      generatedNotes: {
        body: body.replaceAll("\n", "\r\n"),
        name,
      },
    });

    await expect(
      serviceFor(executor).create({
        ...input,
        preview,
      }),
    ).resolves.toMatchObject({ id: "10" });

    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/releases", {
      fields: {
        body: `<!-- puller-release:transaction -->\n\n${body}`,
        draft: true,
        generate_release_notes: false,
        name,
        prerelease: false,
        tag_name: "v1.2.4",
        target_commitish: RELEASE_SHA,
      },
      method: "POST",
      validate: expect.any(Function),
    });
    expect(state.release).toMatchObject({
      body: `<!-- puller-release:transaction -->\n\n${body}`,
      name,
    });
  });

  it.each([
    {
      changed: {
        body: "* Reviewed fix by @alice in https://github.com/owner/repo/pull/7",
        name: "Changed v1.2.4",
      },
      label: "generated name",
    },
    {
      changed: {
        body: [
          "* Reviewed fix by @alice in https://github.com/owner/repo/pull/7",
          "",
          "The generated footer changed.",
        ].join("\n"),
        name: "Reviewed v1.2.4",
      },
      label: "generated body",
    },
    {
      changed: {
        body: "* Reviewed fix by @alice in https://github.com/owner/repo/pull/7",
        name: "Reviewed v1.2.4",
      },
      label: "displayed pull title",
      reviewedTitle: "Changed title",
    },
  ])(
    "rejects $label drift with the same pull membership before tag creation",
    async ({ changed, reviewedTitle = "Reviewed fix" }) => {
      const reviewedBody =
        "* Reviewed fix by @alice in https://github.com/owner/repo/pull/7";
      const preview = releasePreview({
        body: reviewedBody,
        name: "Reviewed v1.2.4",
        pulls: [
          {
            number: 7,
            title: reviewedTitle,
            url: "https://github.com/owner/repo/pull/7",
          },
        ],
      });
      const { executor, state } = creationFixture({
        generatedNotes: changed,
      });

      await expect(
        serviceFor(executor).create({
          ...input,
          preview,
        }),
      ).rejects.toMatchObject({
        code: "release_preview_changed",
        status: 409,
      });
      expect(state.reference).toBeNull();
      expect(state.release).toBeNull();
      expect(
        executor.rest.mock.calls.some(
          ([endpoint, options]) =>
            endpoint === "repos/owner/repo/git/tags" &&
            options?.method === "POST",
        ),
      ).toBe(false);
    },
  );

  it("creates and publishes a generated-notes pre-release", async () => {
    const { executor, state } = creationFixture();

    await expect(
      serviceFor(executor).create(prereleaseInput),
    ).resolves.toMatchObject({
      id: "10",
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/releases", {
      fields: {
        body: "<!-- puller-release:transaction -->\n\n## What’s Changed\n\nGenerated notes",
        draft: true,
        generate_release_notes: false,
        name: "Generated v1.2.4",
        prerelease: true,
        tag_name: "v1.2.4",
        target_commitish: RELEASE_SHA,
      },
      method: "POST",
      validate: expect.any(Function),
    });
    expect(executor.rest).toHaveBeenCalledWith("repos/owner/repo/releases/10", {
      fields: {
        draft: false,
        prerelease: true,
      },
      method: "PATCH",
      validate: expect.any(Function),
    });
    expect(state.release).toMatchObject({ draft: false, prerelease: true });
  });

  it("uses a whole-second deterministic tagger timestamp", async () => {
    const { executor, state } = creationFixture();

    await expect(
      serviceFor(executor, { now: () => NOW + 789 }).create(input),
    ).resolves.toMatchObject({
      id: "10",
    });

    const [payload] = state.tagObjectPayloads.map((value) => JSON.parse(value));
    expect(payload.tagger).toEqual({
      date: "2026-07-21T00:00:00.000Z",
      email: "puller@users.noreply.github.com",
      name: "Puller",
    });
    expect(annotatedTagSha(payload)).toBe(state.tagObjectOid);
  });

  it("reconciles response loss for tag-object, ref, draft, and publication without duplicates", async () => {
    const { executor, state } = creationFixture({
      draftLost: 1,
      publishLost: 1,
      referenceLost: 1,
      tagObjectLost: 1,
    });
    await expect(serviceFor(executor).create(input)).resolves.toMatchObject({
      id: "10",
    });
    expect(state.reference).toEqual({ oid: state.tagObjectOid, type: "tag" });
    expect(state.release).toMatchObject({ draft: false, id: 10 });
    expect(state.tagObjectPayloads).toHaveLength(1);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/git/tags" && options.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/releases" && options.method === "POST",
      ),
    ).toHaveLength(1);
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("reconciles lost pre-release responses without changing the requested state", async () => {
    const { executor, state } = creationFixture({
      draftLost: 1,
      publishLost: 1,
    });

    await expect(
      serviceFor(executor).create(prereleaseInput),
    ).resolves.toMatchObject({ id: "10" });
    expect(state.release).toMatchObject({ draft: false, prerelease: true });
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/releases" && options.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      executor.rest.mock.calls.filter(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/releases/10" &&
          options.method === "PATCH",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["missing", { omitDraftPrerelease: true }],
    ["non-boolean", { draftPrerelease: "false" }],
  ])(
    "preserves the draft when GitHub returns a %s raw pre-release state",
    async (_label, options) => {
      const { executor, state } = creationFixture(options);

      await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
        code: "release_manual_reconciliation_required",
        status: 409,
      });
      expect(state.release).not.toBeNull();
      expect(state.reference).not.toBeNull();
      expect(executor.action).not.toHaveBeenCalled();
    },
  );

  it("preserves an ownership-marked draft whose pre-release state mismatches the request", async () => {
    const { executor, state } = creationFixture({ draftPrerelease: true });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).not.toBeNull();
    expect(state.reference).not.toBeNull();
    expect(executor.action).not.toHaveBeenCalled();
  });

  it.each([
    ["publication response", { publishedPrerelease: true }],
    ["final confirmation", { changePrereleaseOnReleaseRead: 2 }],
  ])(
    "preserves the release when the %s changes the requested pre-release state",
    async (_label, options) => {
      const { executor, state } = creationFixture(options);

      await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
        code: "release_manual_reconciliation_required",
        status: 409,
      });
      expect(state.release).not.toBeNull();
      expect(state.reference).not.toBeNull();
      expect(executor.action).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["body", { changeBodyOnReleaseRead: 2 }],
    ["name", { changeNameOnReleaseRead: 2 }],
  ])(
    "preserves the published release and tag when automation changes its %s",
    async (_label, options) => {
      const { executor, state } = creationFixture(options);

      await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
        code: "release_manual_reconciliation_required",
        status: 409,
      });
      expect(state.release).toMatchObject({
        draft: false,
        id: 10,
        tag_name: "v1.2.4",
      });
      expect(state.reference).toEqual({
        oid: state.tagObjectOid,
        type: "tag",
      });
      expect(executor.action).not.toHaveBeenCalled();
    },
  );

  it("preserves a drifted owned draft and tag for manual reconciliation", async () => {
    const { executor, state } = creationFixture({
      changeBodyOnReleaseRead: 1,
    });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).toMatchObject({
      draft: true,
      id: 10,
      tag_name: "v1.2.4",
    });
    expect(state.release.body).toContain("Changed by release automation.");
    expect(state.reference).toEqual({
      oid: state.tagObjectOid,
      type: "tag",
    });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("preserves an exact unchanged owned draft and tag because GitHub cannot delete them conditionally", async () => {
    const { executor, state } = creationFixture({ publishFails: true });
    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      message: expect.stringContaining(
        "does not support atomic conditional deletion",
      ),
      status: 409,
    });
    expect(state.release).toMatchObject({
      draft: true,
      id: 10,
      tag_name: "v1.2.4",
    });
    expect(state.reference).toEqual({
      oid: state.tagObjectOid,
      type: "tag",
    });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("preserves a release published after the rollback read instead of deleting the raced state", async () => {
    const { executor, state } = creationFixture({
      publishAfterReleaseRead: 7,
      publishFails: true,
    });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).toMatchObject({
      draft: false,
      id: 10,
      tag_name: "v1.2.4",
    });
    expect(state.reference).toEqual({
      oid: state.tagObjectOid,
      type: "tag",
    });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("preserves a tag replaced after the rollback read instead of deleting the raced reference", async () => {
    const { executor, state } = creationFixture({
      draftFails: true,
      moveAfterReferenceRead: 2,
    });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).toBeNull();
    expect(state.reference).toEqual({
      oid: BASE_RELEASE_SHA,
      type: "commit",
    });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("does not delete a foreign tag or a release raced onto the owned tag", async () => {
    const tagRace = creationFixture({ foreignReference: true });
    await expect(
      serviceFor(tagRace.executor).create(input),
    ).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(tagRace.state.reference).toEqual({
      oid: BASE_RELEASE_SHA,
      type: "commit",
    });
    expect(tagRace.executor.action).not.toHaveBeenCalled();

    const releaseRace = creationFixture({ foreignRelease: true });
    await expect(
      serviceFor(releaseRace.executor).create(input),
    ).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(releaseRace.state.release).toMatchObject({
      body: "foreign",
      id: 11,
    });
    expect(releaseRace.state.reference).toEqual({
      oid: releaseRace.state.tagObjectOid,
      type: "tag",
    });
    expect(releaseRace.executor.action).not.toHaveBeenCalled();
  });

  it("preserves its published release and a replacement tag for manual reconciliation", async () => {
    const { executor, state } = creationFixture({ moveOnReferenceRead: 3 });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).not.toBeNull();
    expect(state.reference).toEqual({ oid: BASE_RELEASE_SHA, type: "commit" });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("preserves an exact draft when its release tag target drifts", async () => {
    const { executor, state } = creationFixture({ moveOnReferenceRead: 2 });

    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_manual_reconciliation_required",
      status: 409,
    });
    expect(state.release).toMatchObject({
      draft: true,
      id: 10,
      tag_name: "v1.2.4",
    });
    expect(state.reference).toEqual({ oid: BASE_RELEASE_SHA, type: "commit" });
    expect(executor.action).not.toHaveBeenCalled();
  });

  it("freshly fails closed instead of authorizing from cached or stale open-pull data", async () => {
    const { executor } = creationFixture();
    const loadOpenPulls = vi.fn(async ({ refresh }) =>
      refresh ? { ...openSnapshot(), stale: true } : openSnapshot(),
    );
    const service = serviceFor(executor, { loadOpenPulls });
    await service.getOptions();

    await expect(service.create(input)).rejects.toMatchObject({
      code: "repository_not_allowed",
    });
    expect(loadOpenPulls).toHaveBeenLastCalledWith({ refresh: true });
    expect(
      executor.rest.mock.calls.some(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/git/tags" &&
          options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("freshly authorizes a repository proven by an authored merge in the last 90 days", async () => {
    const { executor } = creationFixture();
    const service = serviceFor(executor, {
      loadMergedPulls: async () => ({
        incomplete: false,
        items: [mergedItem()],
      }),
      loadOpenPulls: async () => ({ ...openSnapshot(), stale: true }),
    });

    await expect(service.create(input)).resolves.toMatchObject({ id: "10" });
  });

  it("detects latest-tag races before creating any remote release state", async () => {
    const { executor, state } = creationFixture({ baseTags: ["v1.2.4"] });
    await expect(serviceFor(executor).create(input)).rejects.toMatchObject({
      code: "release_base_changed",
    });
    expect(state.reference).toBeNull();
    expect(state.release).toBeNull();
  });

  it("rejects an exact duplicate tag even when it is outside the preview", async () => {
    const duplicate = "archive-duplicate";
    const baseTags = [
      "v1.2.3",
      ...Array.from({ length: 12 }, (_, index) => `release-${index + 1}`),
      duplicate,
    ];
    const { executor, state } = creationFixture({ baseTags });
    const service = serviceFor(executor);
    const options = await service.getOptions();

    expect(options.repositories[0].previousTags).toHaveLength(10);
    expect(options.repositories[0].previousTags).not.toContain(duplicate);
    await expect(
      service.create({
        expectedLatestTag: "v1.2.3",
        prerelease: false,
        preview: releasePreview({ tag: duplicate }),
        repository: "owner/repo",
        tag: duplicate,
      }),
    ).rejects.toMatchObject({ code: "tag_exists" });
    expect(state.reference).toBeNull();
    expect(state.release).toBeNull();
    expect(
      executor.rest.mock.calls.some(
        ([endpoint, options]) =>
          endpoint === "repos/owner/repo/git/tags" &&
          options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("deduplicates repository release creation before the first GitHub await", async () => {
    let releaseViewer;
    const waiting = new Promise((resolve) => {
      releaseViewer = resolve;
    });
    const { executor } = creationFixture();
    const original = executor.rest;
    executor.rest = vi.fn(async (...argumentsList) => {
      if (argumentsList[0] === "user") await waiting;
      return original(...argumentsList);
    });
    const service = serviceFor(executor);
    const first = service.create(input);
    await expect(service.create(input)).rejects.toMatchObject({
      code: "release_running",
    });
    releaseViewer();
    await first;
  });
});
