import { describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_COMMITS,
  CommitsError,
  createCommitsService,
} from "../commits.mjs";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const BASE = "1234567890abcdef1234567890abcdef12345678";
const FIRST = "1111111111111111111111111111111111111111";

function authorization(overrides = {}) {
  return {
    authorLogin: "viewer",
    baseRefOid: BASE,
    commitCount: 1,
    headRefName: "feature/commits",
    headRefOid: HEAD,
    headRepository: "example/repo",
    isCrossRepository: false,
    number: 7,
    repository: "example/repo",
    url: "https://github.com/example/repo/pull/7",
    viewerLogin: "viewer",
    ...overrides,
  };
}

function authorizer(implementation = async () => authorization()) {
  return { authorizePullCommits: vi.fn(implementation) };
}

function sha(index) {
  return index.toString(16).padStart(40, "0");
}

function commit(commitSha = FIRST, index = 1) {
  return {
    author: { login: `author-${index}` },
    commit: {
      author: {
        date: `2026-07-${String((index % 20) + 1).padStart(2, "0")}T00:00:00Z`,
        name: `Author ${index}`,
      },
      message: `Commit ${index}\n\nBody`,
    },
    html_url: `https://github.com/example/repo/commit/${commitSha}`,
    sha: commitSha,
  };
}

function normalizedCommit(commitSha = FIRST, index = 1, message) {
  return {
    authorLogin: `author-${index}`,
    authorName: `Author ${index}`,
    authoredAt: `2026-07-${String((index % 20) + 1).padStart(2, "0")}T00:00:00Z`,
    message: message ?? `Commit ${index}\n\nBody`,
    sha: commitSha,
    url: `https://github.com/example/repo/commit/${commitSha}`,
  };
}

function commitList(commits, overrides = {}) {
  return {
    baseRefOid: BASE,
    commits,
    complete: true,
    count: commits.length,
    headRefOid: HEAD,
    number: 7,
    repository: "example/repo",
    warning: null,
    ...overrides,
  };
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function file(path, overrides = {}) {
  return {
    additions: 1,
    blob_url: `https://github.com/example/repo/blob/${FIRST}/${path}`,
    changes: 2,
    deletions: 1,
    filename: path,
    patch: "@@ -1 +1 @@\n-old\n+new",
    raw_url: `https://github.com/example/repo/raw/${FIRST}/${path}`,
    status: "modified",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    number: 7,
    repository: "example/repo",
    ...overrides,
  };
}

describe("pull commit service", () => {
  it("paginates and normalizes the exact GraphQL-reported commit count", async () => {
    const commits = Array.from({ length: 205 }, (_, index) =>
      commit(sha(index + 1), index + 1),
    );
    const rest = vi.fn(async (endpoint) => {
      const page = Number(
        new URL(endpoint, "https://api.github.test").searchParams.get("page"),
      );
      return commits.slice((page - 1) * 100, page * 100);
    });
    const service = createCommitsService({
      authorizer: authorizer(async () => authorization({ commitCount: 205 })),
      executor: { rest },
    });

    await expect(service.load(input())).resolves.toMatchObject({
      commits: expect.arrayContaining([
        expect.objectContaining({
          authorLogin: "author-1",
          authorName: "Author 1",
          message: "Commit 1\n\nBody",
          sha: sha(1),
        }),
      ]),
      complete: true,
      count: 205,
      warning: null,
    });
    expect(rest).toHaveBeenCalledTimes(3);
  });

  it("caps the GitHub PR commit boundary honestly at 250", async () => {
    const commits = Array.from({ length: MAXIMUM_COMMITS }, (_, index) =>
      commit(sha(index + 1), index + 1),
    );
    const rest = vi.fn(async (endpoint) => {
      const page = Number(
        new URL(endpoint, "https://api.github.test").searchParams.get("page"),
      );
      return commits.slice((page - 1) * 100, page * 100);
    });
    const service = createCommitsService({
      authorizer: authorizer(async () => authorization({ commitCount: 300 })),
      executor: { rest },
    });

    const result = await service.load(input());

    expect(result.commits).toHaveLength(250);
    expect(result).toMatchObject({
      complete: false,
      count: 300,
      warning: expect.stringContaining("250"),
    });
    expect(bytes(result)).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("returns a complete commit list when the final JSON envelope exactly fits", async () => {
    const expected = commitList([normalizedCommit()]);
    const maximumBytes = bytes(expected);
    const service = createCommitsService({
      authorizer: authorizer(),
      executor: { rest: vi.fn(async () => [commit()]) },
      maximumBytes,
    });

    const result = await service.load(input());

    expect(result).toEqual(expected);
    expect(bytes(result)).toBe(maximumBytes);
  });

  it("omits only whole trailing commits when the last entry exceeds the response budget", async () => {
    const secondSha = "2".repeat(40);
    const values = [commit(FIRST, 1), commit(secondSha, 2)];
    const firstOnly = commitList([normalizedCommit()], {
      complete: false,
      count: 2,
      warning:
        "The pull request commit list stopped at a commit boundary because it exceeded the response budget.",
    });
    const maximumBytes = bytes(firstOnly);
    const service = createCommitsService({
      authorizer: authorizer(async () => authorization({ commitCount: 2 })),
      executor: { rest: vi.fn(async () => values) },
      maximumBytes,
    });

    const result = await service.load(input());

    expect(result).toEqual(firstOnly);
    expect(bytes(result)).toBe(maximumBytes);
  });

  it("returns no partial commit when the first long message exceeds the response budget", async () => {
    const message = `Large commit\n\n${"x".repeat(20_000)}`;
    const value = {
      ...commit(),
      commit: {
        ...commit().commit,
        message,
      },
    };
    const expected = commitList([], {
      complete: false,
      count: 1,
      warning:
        "The pull request commit list stopped at a commit boundary because it exceeded the response budget.",
    });
    const maximumBytes = bytes(expected);
    const service = createCommitsService({
      authorizer: authorizer(),
      executor: { rest: vi.fn(async () => [value]) },
      maximumBytes,
    });

    const result = await service.load(input());

    expect(result).toEqual(expected);
    expect(result.warning).toContain("commit boundary");
    expect(result.warning).toContain("response budget");
    expect(result.count).toBe(1);
    expect(bytes(result)).toBeLessThanOrEqual(maximumBytes);
  });

  it("denies a per-commit diff when byte truncation omitted that commit", async () => {
    const omittedSha = "2".repeat(40);
    const values = [commit(FIRST, 1), commit(omittedSha, 2)];
    const budgeted = commitList([normalizedCommit()], {
      complete: false,
      count: 2,
      warning:
        "The pull request commit list stopped at a commit boundary because it exceeded the response budget.",
    });
    const rest = vi.fn(async (endpoint) => {
      if (endpoint.includes("/pulls/7/commits")) return values;
      throw new Error("an omitted commit endpoint must not be called");
    });
    const service = createCommitsService({
      authorizer: authorizer(async () => authorization({ commitCount: 2 })),
      executor: { rest },
      maximumBytes: bytes(budgeted),
    });

    await expect(
      service.loadCommitDiff(input({ commitSha: omittedSha })),
    ).rejects.toMatchObject({
      code: "commit_missing",
      status: 404,
    });
    expect(rest).toHaveBeenCalledOnce();
  });

  it("fails stale when commit count or branch generation changes after collection", async () => {
    let calls = 0;
    const service = createCommitsService({
      authorizer: authorizer(async () => {
        calls += 1;
        return authorization({
          commitCount: calls === 1 ? 1 : 2,
        });
      }),
      executor: { rest: vi.fn(async () => [commit()]) },
    });

    await expect(service.load(input())).rejects.toMatchObject({
      code: "stale_head",
      status: 409,
    });
  });

  it("never exposes an arbitrary repository commit outside the proven PR list", async () => {
    const rest = vi.fn(async (endpoint) => {
      if (endpoint.includes("/pulls/7/commits")) return [commit()];
      throw new Error("commit endpoint must not be called");
    });
    const service = createCommitsService({
      authorizer: authorizer(),
      executor: { rest },
    });

    await expect(
      service.loadCommitDiff(input({ commitSha: "f".repeat(40) })),
    ).rejects.toBeInstanceOf(CommitsError);
    expect(rest).toHaveBeenCalledOnce();
  });

  it("loads only a proven commit and paginates its files with PullDiff normalization", async () => {
    const files = Array.from({ length: 101 }, (_, index) =>
      file(`src/file-${index + 1}.ts`),
    );
    const rest = vi.fn(async (endpoint) => {
      if (endpoint.includes("/pulls/7/commits")) return [commit()];
      const page = Number(
        new URL(endpoint, "https://api.github.test").searchParams.get("page"),
      );
      return {
        ...commit(),
        files: files.slice((page - 1) * 100, page * 100),
      };
    });
    const service = createCommitsService({
      authorizer: authorizer(),
      executor: { rest },
    });

    const result = await service.loadCommitDiff(
      input({ commitSha: FIRST.toUpperCase() }),
    );

    expect(result).toMatchObject({
      baseRefOid: BASE,
      commitSha: FIRST,
      complete: true,
      headRefOid: HEAD,
      warning: null,
    });
    expect(result.files).toHaveLength(101);
    expect(result.files[0].hunks[0].lines).toEqual([
      { content: "old", kind: "deletion", newLine: null, oldLine: 1 },
      { content: "new", kind: "addition", newLine: 1, oldLine: null },
    ]);
    expect(rest).toHaveBeenCalledTimes(3);
  });

  it("marks malformed, duplicate, and count-mismatched lists incomplete and denies membership", async () => {
    const rest = vi.fn(async () => [
      commit(),
      commit(),
      { ...commit("2".repeat(40), 2), sha: "invalid" },
    ]);
    const service = createCommitsService({
      authorizer: authorizer(async () => authorization({ commitCount: 3 })),
      executor: { rest },
    });

    const list = await service.load(input());
    expect(list).toMatchObject({
      commits: [expect.objectContaining({ sha: FIRST })],
      complete: false,
      warning: expect.stringContaining("duplicate"),
    });
    await expect(
      service.loadCommitDiff(input({ commitSha: FIRST })),
    ).rejects.toMatchObject({ code: "commit_missing" });
  });

  it("deduplicates concurrent lists and caches each PR generation", async () => {
    let resolve;
    const pending = new Promise((promiseResolve) => {
      resolve = promiseResolve;
    });
    const rest = vi.fn(() => pending);
    const service = createCommitsService({
      authorizer: authorizer(),
      executor: { rest },
    });

    const first = service.load(input());
    const second = service.load(input());
    await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce());
    resolve([commit()]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await service.load(input());
    expect(rest).toHaveBeenCalledOnce();
  });
});
