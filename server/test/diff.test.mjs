import { describe, expect, it, vi } from "vitest";

import { createArtifactAuthorizer } from "../authorization.mjs";
import { createSnapshotCache } from "../cache.mjs";
import {
  MAXIMUM_FILES,
  createDiffService,
  fetchPullDiff,
  parsePatch,
} from "../diff.mjs";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const BASE = "1234567890abcdef1234567890abcdef12345678";

function authorization(input = {}, overrides = {}) {
  const repository = input.repository ?? "example/repo";
  const number = input.number ?? 1;
  const viewerLogin = input.expectedViewerLogin ?? "viewer";

  return {
    authorLogin: viewerLogin,
    baseRefOid: input.expectedBaseRefOid ?? BASE,
    headRefOid: input.expectedHeadRefOid ?? HEAD,
    number,
    repository,
    url: `https://github.com/${repository}/pull/${number}`,
    viewerLogin,
    ...overrides,
  };
}

function createAuthorizer(
  implementation = async (input) => authorization(input),
) {
  return { authorizePull: vi.fn(implementation) };
}

function file(path, overrides = {}) {
  return {
    additions: 1,
    blob_url: `https://github.com/example/repo/blob/${HEAD}/${encodeURIComponent(path)}`,
    changes: 2,
    deletions: 1,
    filename: path,
    patch: "@@ -1 +1 @@\n-old\n+new",
    raw_url: `https://github.com/example/repo/raw/${HEAD}/${encodeURIComponent(path)}`,
    status: "modified",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    authorizer: createAuthorizer(),
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    number: 1,
    repository: "example/repo",
    rest: vi.fn(async () => []),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    number: 1,
    repository: "example/repo",
    ...overrides,
  };
}

function readinessSnapshot(overrides = {}) {
  return {
    notReady: [
      {
        baseRefOid: BASE,
        headRefOid: HEAD,
        number: 1,
        repository: "example/repo",
        url: "https://github.com/example/repo/pull/1",
      },
    ],
    partial: false,
    ready: [],
    viewerLogin: "viewer",
    warnings: [],
    ...overrides,
  };
}

function targetedProof(overrides = {}) {
  return {
    authored: true,
    authorLogin: "viewer",
    available: true,
    baseRefOid: BASE,
    complete: true,
    headRefOid: HEAD,
    number: 1,
    open: true,
    repository: "example/repo",
    state: "OPEN",
    url: "https://github.com/example/repo/pull/1",
    viewerLogin: "viewer",
    ...overrides,
  };
}

async function expiredSnapshotDiff({ loadPullAuthorization, rest }) {
  let current = 1_000;
  const snapshot = createSnapshotCache({
    load: vi.fn(async () => readinessSnapshot()),
    now: () => current,
    ttl: 10,
  });
  await snapshot.get();
  current += 11;

  const authorizer = createArtifactAuthorizer({
    loadCheckAuthorization: vi.fn(),
    loadPullAuthorization,
    loadPullCommitsAuthorization: vi.fn(),
    peek: snapshot.peek,
  });

  return {
    authorizer,
    service: createDiffService({ authorizer, executor: { rest } }),
    snapshot,
  };
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

describe("unified patch parsing", () => {
  it("parses multiple hunks, line numbers, context, and no-newline metadata", () => {
    const parsed = parsePatch(
      [
        "@@ -1,2 +1,2 @@ first",
        " keep",
        "-old",
        "+new",
        "@@ -10 +10 @@ second",
        "-before",
        "+after",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      additions: 2,
      deletions: 2,
      truncated: false,
    });
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[0].lines).toEqual([
      { content: "keep", kind: "context", newLine: 1, oldLine: 1 },
      { content: "old", kind: "deletion", newLine: null, oldLine: 2 },
      { content: "new", kind: "addition", newLine: 2, oldLine: null },
    ]);
    expect(parsed.hunks[1].lines.at(-1)).toEqual({
      content: "\\ No newline at end of file",
      kind: "meta",
      newLine: null,
      oldLine: null,
    });
  });

  it("marks malformed and cut-off hunks truncated", () => {
    expect(parsePatch("@@ -1,2 +1,2 @@\n one")).toMatchObject({
      truncated: true,
    });
    expect(parsePatch("not a hunk")).toMatchObject({ truncated: true });
  });
});

describe("pull diff loader", () => {
  it("normalizes added, modified, removed, renamed, binary, and special filenames", async () => {
    const values = [
      file("new.ts", {
        additions: 1,
        changes: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+new",
        status: "added",
      }),
      file("modified.ts"),
      file("old.ts", {
        additions: 0,
        changes: 1,
        deletions: 1,
        patch: "@@ -1 +0,0 @@\n-old",
        status: "removed",
      }),
      file("new-name.ts", {
        additions: 0,
        changes: 0,
        deletions: 0,
        patch: undefined,
        previous_filename: "old-name.ts",
        status: "renamed",
      }),
      file("image.png", {
        additions: 0,
        changes: 0,
        deletions: 0,
        patch: undefined,
      }),
      file("spaces and #hash/日本語.ts"),
    ];
    const result = await fetchPullDiff(request({ rest: async () => values }));

    expect(result).toMatchObject({
      baseRefOid: BASE,
      complete: true,
      headRefOid: HEAD,
      number: 1,
      repository: "example/repo",
      warning: null,
    });
    expect(result.files.map(({ status }) => status)).toEqual([
      "added",
      "modified",
      "removed",
      "renamed",
      "modified",
      "modified",
    ]);
    expect(result.files[3]).toMatchObject({
      binary: false,
      previousPath: "old-name.ts",
    });
    expect(result.files[4]).toMatchObject({
      binary: true,
      hunks: [],
      truncated: false,
    });
    expect(result.files[5].path).toBe("spaces and #hash/日本語.ts");
  });

  it("accepts a delegated author when fresh authored-search membership is proven", async () => {
    const authorizer = createAuthorizer(async (input) =>
      authorization(input, {
        authorLogin: "copilot-swe-agent",
      }),
    );
    const result = await fetchPullDiff(
      request({
        authorizer,
      }),
    );

    expect(result).toMatchObject({
      complete: true,
      number: 1,
      repository: "example/repo",
    });
    expect(authorizer.authorizePull).toHaveBeenCalledTimes(2);
  });

  it("marks missing or oversized textual patches incomplete without calling them binary", async () => {
    const result = await fetchPullDiff(
      request({
        rest: async () => [
          file("large.ts", {
            additions: 5,
            changes: 8,
            deletions: 3,
            patch: undefined,
          }),
        ],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.files[0]).toMatchObject({ binary: false, truncated: true });
    expect(result.warning).toContain("omitted a textual patch");
  });

  it("detects a patch truncated relative to GitHub change counts", async () => {
    const result = await fetchPullDiff(
      request({
        rest: async () => [file("cut.ts", { additions: 2, changes: 3 })],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.files[0].truncated).toBe(true);
    expect(result.warning).toContain("truncated textual patch");
  });

  it("paginates 100 files at a time until a short page proves exhaustion", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      file(`src/${index}.ts`),
    );
    const rest = vi.fn(async (endpoint) =>
      endpoint.endsWith("&page=1") ? first : [file("src/100.ts")],
    );
    const result = await fetchPullDiff(request({ rest }));
    expect(result.files).toHaveLength(101);
    expect(result.complete).toBe(true);
    expect(rest).toHaveBeenCalledTimes(2);
    expect(rest.mock.calls[0][0]).toBe(
      "repos/example/repo/pulls/1/files?per_page=100&page=1",
    );
  });

  it("reports the official 3,000-file cap without claiming completeness", async () => {
    const rest = vi.fn(async (_endpoint, _options) =>
      Array.from({ length: 100 }, (_, index) => {
        const page = rest.mock.calls.length;
        return file(`page-${page}/file-${index}.ts`, {
          additions: 0,
          changes: 0,
          deletions: 0,
          patch: undefined,
        });
      }),
    );
    const result = await fetchPullDiff(
      request({ maximumBytes: 64 * 1024 * 1024, rest }),
    );
    expect(result.files).toHaveLength(MAXIMUM_FILES);
    expect(result.complete).toBe(false);
    expect(result.warning).toContain("3,000 files");
    expect(rest).toHaveBeenCalledTimes(30);
  });

  it("enforces the exact UTF-8 response budget only at file boundaries", async () => {
    const values = [file("one.ts"), file("two.ts")];
    const full = await fetchPullDiff(request({ rest: async () => values }));
    const warning =
      "The diff stopped at a file boundary because it exceeded the response budget.";
    const oneFile = {
      ...full,
      complete: false,
      files: [full.files[0]],
      warning,
    };
    const maximumBytes = Buffer.byteLength(JSON.stringify(oneFile), "utf8");

    const exact = await fetchPullDiff(
      request({
        maximumBytes,
        rest: async () => values,
      }),
    );
    const below = await fetchPullDiff(
      request({
        maximumBytes: maximumBytes - 1,
        rest: async () => values,
      }),
    );

    expect(exact).toEqual(oneFile);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(maximumBytes);
    expect(below.files).toEqual([]);
    expect(
      Buffer.byteLength(JSON.stringify(below), "utf8"),
    ).toBeLessThanOrEqual(maximumBytes - 1);
    expect(below.warning).toContain("file boundary");
  });

  it("fails safely when even the empty response envelope exceeds the budget", async () => {
    await expect(
      fetchPullDiff(
        request({
          maximumBytes: 1,
          rest: async () => [file("too-large.ts")],
        }),
      ),
    ).rejects.toMatchObject({ code: "diff_too_large", status: 502 });
  });

  it("returns already-normalized files when the executor reaches its output limit later", async () => {
    const error = Object.assign(new Error("large"), { code: "output_limit" });
    const rest = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => file(`${index}.ts`)),
      )
      .mockRejectedValueOnce(error);
    const result = await fetchPullDiff(request({ rest }));
    expect(result.files).toHaveLength(100);
    expect(result.complete).toBe(false);
    expect(result.warning).toContain("GitHub exceeded the response budget");
  });

  it("requires an exact base and head before authorization or REST work", async () => {
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await expect(
      service.load({
        expectedHeadRefOid: HEAD,
        number: 1,
        repository: "example/repo",
      }),
    ).rejects.toThrow("expectedBaseRefOid must be a full commit SHA.");
    expect(authorizer.authorizePull).not.toHaveBeenCalled();
    expect(rest).not.toHaveBeenCalled();
  });
});

describe("diff service authorization, sharing, and caching", () => {
  it("loads an exact cold diff from fresh proofs when the complete snapshot TTL expired", async () => {
    const events = [];
    const loadPullAuthorization = vi.fn(async () => {
      events.push("proof");
      return targetedProof();
    });
    const rest = vi.fn(async () => {
      events.push("rest");
      return [file("src/index.ts")];
    });
    const { service, snapshot } = await expiredSnapshotDiff({
      loadPullAuthorization,
      rest,
    });

    expect(snapshot.peek()).toMatchObject({
      expired: true,
      partial: false,
      stale: false,
    });
    await expect(service.load(input())).resolves.toEqual({
      baseRefOid: BASE,
      complete: true,
      files: [
        {
          additions: 1,
          binary: false,
          blobUrl: `https://github.com/example/repo/blob/${HEAD}/src%2Findex.ts`,
          changes: 2,
          deletions: 1,
          hunks: [
            {
              header: "@@ -1 +1 @@",
              lines: [
                { content: "old", kind: "deletion", newLine: null, oldLine: 1 },
                { content: "new", kind: "addition", newLine: 1, oldLine: null },
              ],
              newLines: 1,
              newStart: 1,
              oldLines: 1,
              oldStart: 1,
            },
          ],
          path: "src/index.ts",
          previousPath: null,
          rawUrl: `https://github.com/example/repo/raw/${HEAD}/src%2Findex.ts`,
          status: "modified",
          truncated: false,
        },
      ],
      headRefOid: HEAD,
      number: 1,
      repository: "example/repo",
      warning: null,
    });
    expect(events).toEqual(["proof", "rest", "proof"]);
    expect(loadPullAuthorization).toHaveBeenCalledTimes(2);
    expect(rest).toHaveBeenCalledOnce();
  });

  it("reuses a cached diff only after fresh proof when the snapshot remains expired", async () => {
    const loadPullAuthorization = vi.fn(async () => targetedProof());
    const rest = vi.fn(async () => []);
    const { service, snapshot } = await expiredSnapshotDiff({
      loadPullAuthorization,
      rest,
    });

    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });

    expect(snapshot.peek()).toMatchObject({ expired: true });
    expect(loadPullAuthorization).toHaveBeenCalledTimes(4);
    expect(rest).toHaveBeenCalledOnce();
  });

  it("does not publish or cache a diff when the post-fetch proof drifts", async () => {
    const loadPullAuthorization = vi
      .fn()
      .mockResolvedValueOnce(targetedProof())
      .mockResolvedValueOnce(targetedProof({ headRefOid: "9".repeat(40) }))
      .mockResolvedValue(targetedProof());
    const rest = vi.fn(async () => []);
    const { service } = await expiredSnapshotDiff({
      loadPullAuthorization,
      rest,
    });

    await expect(service.load(input())).rejects.toMatchObject({
      code: "stale_head",
      status: 409,
    });
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });

    expect(loadPullAuthorization).toHaveBeenCalledTimes(4);
    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("keeps genuinely incomplete targeted authorization fail-closed", async () => {
    const loadPullAuthorization = vi.fn(async () =>
      targetedProof({ complete: false }),
    );
    const rest = vi.fn(async () => []);
    const { service } = await expiredSnapshotDiff({
      loadPullAuthorization,
      rest,
    });

    await expect(service.load(input())).rejects.toMatchObject({
      code: "pull_incomplete",
      status: 503,
    });
    expect(loadPullAuthorization).toHaveBeenCalledOnce();
    expect(rest).not.toHaveBeenCalled();
  });

  it("places independent fresh authorization proofs around a cold REST collection", async () => {
    const events = [];
    const authorizer = createAuthorizer(async (value) => {
      events.push(value.expectedViewerLogin ? "post" : "pre");
      return authorization(value);
    });
    let upstreamSignal;
    const rest = vi.fn(async (_endpoint, options) => {
      events.push("rest");
      upstreamSignal = options.signal;
      return [];
    });
    const service = createDiffService({ authorizer, executor: { rest } });
    const controller = new AbortController();

    await expect(
      service.load({ ...input(), signal: controller.signal }),
    ).resolves.toMatchObject({
      baseRefOid: BASE,
      complete: true,
      files: [],
      headRefOid: HEAD,
    });

    expect(events).toEqual(["pre", "rest", "post"]);
    expect(upstreamSignal).toBeInstanceOf(AbortSignal);
    expect(upstreamSignal).not.toBe(controller.signal);
    expect(authorizer.authorizePull).toHaveBeenNthCalledWith(
      1,
      input(),
      controller.signal,
    );
    expect(authorizer.authorizePull).toHaveBeenNthCalledWith(
      2,
      {
        ...input(),
        expectedViewerLogin: "viewer",
      },
      controller.signal,
    );
    expect(service.loadDiff).toBe(service.load);
  });

  it("aborts pre-authorization with the caller reason before starting REST work", async () => {
    let authorizationSignal;
    const authorizer = createAuthorizer(
      (_value, signal) =>
        new Promise((_resolve, reject) => {
          authorizationSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });
    const controller = new AbortController();
    const reason = new DOMException("Client disconnected.", "AbortError");

    const pending = service.load({ ...input(), signal: controller.signal });
    const result = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() =>
      expect(authorizer.authorizePull).toHaveBeenCalledOnce(),
    );
    controller.abort(reason);

    await result;
    expect(authorizationSignal).toBe(controller.signal);
    expect(rest).not.toHaveBeenCalled();
  });

  it("requires fresh authorization on a cache hit without repeating REST", async () => {
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await service.load(input());
    const authorized = await service.loadAuthorized(input());

    expect(rest).toHaveBeenCalledOnce();
    expect(authorizer.authorizePull).toHaveBeenCalledTimes(4);
    expect(authorized).toMatchObject({
      authorization: {
        authorLogin: "viewer",
        baseRefOid: BASE,
        headRefOid: HEAD,
        number: 1,
        repository: "example/repo",
        viewerLogin: "viewer",
      },
      diff: {
        baseRefOid: BASE,
        complete: true,
        files: [],
        headRefOid: HEAD,
      },
    });
  });

  it("rejects a cached body when its final authorization proof drifts", async () => {
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await service.load(input());
    authorizer.authorizePull
      .mockResolvedValueOnce(authorization(input()))
      .mockResolvedValueOnce(
        authorization(input(), { authorLogin: "different-author" }),
      );

    await expect(service.loadAuthorized(input())).rejects.toMatchObject({
      code: "stale_head",
      status: 409,
    });
    expect(rest).toHaveBeenCalledOnce();
  });

  it("does not fetch when snapshot or fresh authorization denies the request", async () => {
    const denial = Object.assign(new Error("snapshot unavailable"), {
      code: "snapshot_unavailable",
      status: 503,
    });
    const authorizer = createAuthorizer();
    authorizer.authorizePull.mockRejectedValueOnce(denial);
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await expect(service.load(input())).rejects.toMatchObject({
      code: "pull_incomplete",
      status: 503,
    });
    expect(rest).not.toHaveBeenCalled();

    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });
    expect(rest).toHaveBeenCalledOnce();
  });

  it.each([
    ["incomplete", "pull_incomplete", 503],
    ["not_found", "pull_missing", 404],
    ["stale", "stale_head", 409],
  ])(
    "preserves the public diff error contract for %s authorization",
    async (authorizationCode, code, status) => {
      const authorizer = createAuthorizer(async () => {
        throw Object.assign(new Error("denied"), { code: authorizationCode });
      });
      const rest = vi.fn(async () => []);
      const service = createDiffService({ authorizer, executor: { rest } });

      await expect(service.load(input())).rejects.toMatchObject({
        code,
        status,
      });
      expect(rest).not.toHaveBeenCalled();
    },
  );

  it("coalesces only the REST collection while every caller authorizes independently", async () => {
    const pending = deferred();
    const authorizer = createAuthorizer();
    const rest = vi.fn(() => pending.promise);
    const service = createDiffService({ authorizer, executor: { rest } });

    const first = service.load(input());
    const second = service.load(input());
    await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce());
    pending.resolve([]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(authorizer.authorizePull).toHaveBeenCalledTimes(4);
  });

  it("detaches one aborted waiter while the surviving waiter completes and post-authorizes", async () => {
    const pending = deferred();
    const authorizer = createAuthorizer();
    let upstreamSignal;
    const rest = vi.fn((_endpoint, options) => {
      upstreamSignal = options.signal;
      return pending.promise;
    });
    const service = createDiffService({ authorizer, executor: { rest } });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = service.load({ ...input(), signal: firstController.signal });
    const second = service.load({
      ...input(),
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce());
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal.aborted).toBe(false);
    pending.resolve([]);
    await expect(second).resolves.toMatchObject({ complete: true });
    expect(authorizer.authorizePull).toHaveBeenCalledTimes(3);
  });

  it("aborts the shared upstream collection after every waiter detaches", async () => {
    const authorizer = createAuthorizer();
    let upstreamSignal;
    const rest = vi.fn(
      (_endpoint, options) =>
        new Promise((_resolve, reject) => {
          upstreamSignal = options.signal;
          upstreamSignal.addEventListener(
            "abort",
            () => reject(upstreamSignal.reason),
            {
              once: true,
            },
          );
        }),
    );
    const service = createDiffService({ authorizer, executor: { rest } });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.load({ ...input(), signal: firstController.signal });
    const second = service.load({
      ...input(),
      signal: secondController.signal,
    });
    const firstResult = expect(first).rejects.toMatchObject({
      name: "AbortError",
    });
    const secondResult = expect(second).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce());
    firstController.abort();
    expect(upstreamSignal.aborted).toBe(false);
    secondController.abort();

    await Promise.all([firstResult, secondResult]);
    expect(upstreamSignal.aborted).toBe(true);
    expect(authorizer.authorizePull).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached data when only the base or head generation changes", async () => {
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });
    const nextBase = { ...input(), expectedBaseRefOid: "9".repeat(40) };
    const nextHead = { ...nextBase, expectedHeadRefOid: "8".repeat(40) };

    await service.load(input());
    await service.load(input());
    await service.load(nextBase);
    await service.load(nextHead);

    expect(rest).toHaveBeenCalledTimes(3);
  });

  it("supports targeted generation pruning without publishing an invalidated active result", async () => {
    const pending = deferred();
    const authorizer = createAuthorizer();
    const rest = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue([]);
    const service = createDiffService({ authorizer, executor: { rest } });

    const active = service.load(input());
    await vi.waitFor(() => expect(rest).toHaveBeenCalledOnce());
    service.invalidate({
      number: 1,
      repository: "example/repo",
      viewerLogin: "viewer",
    });
    pending.resolve([]);
    await expect(active).resolves.toMatchObject({ complete: true });
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });

    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("isolates cached data by the freshly authorized viewer", async () => {
    let viewerLogin = "viewer-one";
    const authorizer = createAuthorizer(async (value) =>
      authorization(value, {
        authorLogin: "delegated-author",
        viewerLogin,
      }),
    );
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await service.load(input());
    viewerLogin = "viewer-two";
    await service.load(input());
    viewerLogin = "viewer-one";
    await service.load(input());

    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("does not publish data when post-authorization drifts", async () => {
    const drift = Object.assign(new Error("pull changed"), {
      code: "stale",
      status: 409,
    });
    const authorizer = createAuthorizer();
    authorizer.authorizePull
      .mockResolvedValueOnce(authorization(input()))
      .mockRejectedValueOnce(drift)
      .mockImplementation(async (value) => authorization(value));
    const rest = vi.fn(async () => []);
    const service = createDiffService({ authorizer, executor: { rest } });

    await expect(service.load(input())).rejects.toMatchObject({
      code: "stale_head",
      status: 409,
    });
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });

    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("caches successful warned and degraded normalized responses", async () => {
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => [
      file("large.ts", {
        additions: 5,
        changes: 8,
        deletions: 3,
        patch: undefined,
      }),
    ]);
    const service = createDiffService({ authorizer, executor: { rest } });

    const first = await service.load(input());
    const second = await service.load(input());

    expect(first).toMatchObject({ complete: false });
    expect(first.warning).toContain("omitted a textual patch");
    expect(second).toEqual(first);
    expect(rest).toHaveBeenCalledOnce();
  });

  it("never caches failed collections and retries the protected request", async () => {
    const authorizer = createAuthorizer();
    const rest = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue([]);
    const service = createDiffService({ authorizer, executor: { rest } });

    await expect(service.load(input())).rejects.toThrow("GitHub unavailable");
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });
    await expect(service.load(input())).resolves.toMatchObject({
      complete: true,
    });

    expect(rest).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used responses by actual serialized byte size", async () => {
    const content = "x".repeat(1_024);
    const largeFile = file("large.ts", {
      patch: `@@ -1 +1 @@\n-${content}\n+${content}`,
    });
    const sample = await fetchPullDiff(
      request({ rest: async () => [largeFile] }),
    );
    const cacheBytes = Buffer.byteLength(JSON.stringify(sample), "utf8") + 32;
    const authorizer = createAuthorizer();
    const rest = vi.fn(async () => [largeFile]);
    const service = createDiffService({
      authorizer,
      cacheBytes,
      executor: { rest },
    });

    await service.load(input({ number: 1 }));
    await service.load(input({ number: 2 }));
    await service.load(input({ number: 1 }));

    expect(rest).toHaveBeenCalledTimes(3);
  });
});
