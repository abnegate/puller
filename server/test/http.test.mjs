import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SnapshotError } from "../cache.mjs";
import { CheckLogsError } from "../check-logs.mjs";
import {
  ActionError,
  createClaudeRunManager,
  createRunCoordinator,
  validateRunInput,
} from "../claude.mjs";
import { DiffError } from "../diff.mjs";
import { GRAPHQL_MAX_BUFFER } from "../github.mjs";
import { TaskError } from "../task.mjs";
import {
  assertProductionBuild,
  createRequestListener,
  createStaticHandler,
} from "../http.mjs";
import { resolveServerOptions, start } from "../index.mjs";

const temporary = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "authored-pulls-"));
  temporary.push(path);
  return path;
}

async function listen(listener) {
  const server = createServer(listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function freePort() {
  const running = await listen((_request, response) => response.end());
  const port = Number(new URL(running.origin).port);
  await running.close();
  return port;
}

async function listenAt(listener, port) {
  const server = createServer(listener);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function apiServer(options) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const running = await listenAt(
    createRequestListener({
      ...options,
      trustedOrigin: origin,
    }),
    port,
  );
  return running;
}

async function rawStatus(origin, path) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function rawResponse(
  origin,
  path,
  { headers = {}, method = "GET" } = {},
) {
  const url = new URL(origin);
  return await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers,
        host: url.hostname,
        method,
        path,
        port: url.port,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode,
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function eventually(assertion) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function emptyGraphql() {
  return Promise.resolve({
    search: {
      issueCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
}

function snapshot() {
  return {
    query: "is:pr author:@me state:open archived:false sort:updated-desc",
    generatedAt: "2026-07-17T00:00:00.000Z",
    stale: false,
    partial: false,
    warnings: [],
    counts: { total: 0, ready: 0, notReady: 0 },
    ready: [],
    notReady: [],
  };
}

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const BASE = "1234567890abcdef1234567890abcdef12345678";

function diff() {
  return {
    baseRefOid: BASE,
    complete: true,
    files: [],
    headRefOid: HEAD,
    number: 7,
    repository: "owner/repo",
    warning: null,
  };
}

function commits() {
  return {
    baseRefOid: BASE,
    commits: [
      {
        authorLogin: "viewer",
        authorName: "Viewer",
        authoredAt: "2026-07-24T00:00:00.000Z",
        message: "Commit",
        sha: HEAD,
        url: `https://github.com/owner/repo/commit/${HEAD}`,
      },
    ],
    complete: true,
    count: 1,
    headRefOid: HEAD,
    number: 7,
    repository: "owner/repo",
    warning: null,
  };
}

function commitDiff() {
  return {
    ...diff(),
    commitSha: HEAD,
  };
}

function releaseOptions() {
  return {
    generatedAt: "2026-07-21T00:00:00.000Z",
    repositoriesUpdatedAt: "2026-07-21T00:00:00.000Z",
    repositories: [
      {
        latestTag: "v1.2.3",
        nextTag: "v1.2.4",
        repository: "owner/repo",
        repositoryUrl: "https://github.com/owner/repo",
      },
    ],
    tagsUpdatedAt: "2026-07-21T00:00:00.000Z",
    viewerLogin: "viewer",
    warnings: [],
  };
}

function releasePreview() {
  return {
    baseTag: "v1.2.3",
    body: "* Released fix by @viewer in https://github.com/owner/repo/pull/7",
    digest: "a".repeat(64),
    name: "Generated v1.2.4",
    pulls: [
      {
        number: 7,
        title: "Released fix",
        url: "https://github.com/owner/repo/pull/7",
      },
    ],
    repository: "owner/repo",
    tag: "v1.2.4",
    targetOid: HEAD,
  };
}

function recentReleases() {
  return {
    generatedAt: "2026-07-21T00:00:00.000Z",
    partial: false,
    releases: [],
    warnings: [],
  };
}

function releasePipelines() {
  return {
    generatedAt: "2026-07-21T00:00:00.000Z",
    releases: [],
  };
}

function freshReadyPull() {
  return {
    authorLogin: "viewer",
    authored: true,
    available: true,
    complete: true,
    headRefOid: HEAD,
    number: 7,
    open: true,
    pull: {
      ci: {
        checks: [],
        complete: true,
        failed: 0,
        passed: 0,
        running: 0,
        state: "none",
        total: 0,
        unknown: 0,
      },
      comments: [
        {
          author: "greptile-apps",
          body: `Confidence Score: 5/5\nLast reviewed commit: ${HEAD}`,
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
          url: "https://github.com/owner/repo/pull/7#issuecomment-1",
        },
      ],
      commentsComplete: true,
      headRefOid: HEAD,
      number: 7,
      repository: "owner/repo",
      repositoryUrl: "https://github.com/owner/repo",
      reviewThreads: [],
      state: "OPEN",
      threadsComplete: true,
      title: "Ready change",
      unresolvedThreads: [],
      updatedAt: "2026-07-21T00:00:00.000Z",
      url: "https://github.com/owner/repo/pull/7",
    },
    repository: "owner/repo",
    repositoryUrl: "https://github.com/owner/repo",
    state: "OPEN",
    url: "https://github.com/owner/repo/pull/7",
    viewerLogin: "viewer",
  };
}

describe("API endpoint", () => {
  it("returns normalized data with no-store and no CORS header", async () => {
    const cache = { get: vi.fn(async () => snapshot()) };
    const running = await apiServer({
      cache,
      fallback: (_request, response) => response.end("client"),
    });

    const response = await fetch(`${running.origin}/api/pulls`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    await expect(response.json()).resolves.toEqual(snapshot());
    await running.close();
  });

  it("protects framing headers from downstream replacement or removal", async () => {
    const running = await listen(
      createRequestListener({
        cache: { get: vi.fn(async () => snapshot()) },
        fallback: (_request, response) => {
          response.setHeader("Content-Security-Policy", "frame-ancestors *");
          response.removeHeader("X-Frame-Options");
          response.writeHead(200, {
            "Content-Security-Policy": "frame-ancestors https://evil.invalid",
            "X-Frame-Options": "SAMEORIGIN",
          });
          response.end("client");
        },
      }),
    );

    const response = await fetch(`${running.origin}/client`);
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    await running.close();
  });

  it("maps refresh=1 to a manual cache bypass", async () => {
    const cache = { get: vi.fn(async () => snapshot()) };
    const running = await apiServer({
      cache,
      fallback: (_request, response) => response.end(),
    });

    await fetch(`${running.origin}/api/pulls?refresh=1`);
    expect(cache.get).toHaveBeenCalledWith({ refresh: true });
    await running.close();
  });

  it("primes release repositories after fresh authentication without delaying the pull response", async () => {
    const gate = new Promise(() => undefined);
    const value = { ...snapshot(), viewerLogin: "viewer" };
    const releaseService = { primeRepositories: vi.fn(() => gate) };
    const running = await apiServer({
      cache: { get: vi.fn(async () => value) },
      releaseService,
      fallback: (_request, response) => response.end(),
    });

    const response = await fetch(`${running.origin}/api/pulls`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(value);
    expect(releaseService.primeRepositories).toHaveBeenCalledOnce();
    expect(releaseService.primeRepositories).toHaveBeenCalledWith(value);
    await running.close();
  });

  it("does not prime release repositories from stale or viewerless pull snapshots", async () => {
    const values = [
      { ...snapshot(), stale: true, viewerLogin: "viewer" },
      snapshot(),
      { ...snapshot(), viewerLogin: "   " },
      { viewerLogin: "viewer" },
    ];
    const releaseService = { primeRepositories: vi.fn(async () => undefined) };
    const running = await apiServer({
      cache: { get: vi.fn(async () => values.shift()) },
      releaseService,
      fallback: (_request, response) => response.end(),
    });

    for (let index = 0; index < 4; index += 1) {
      expect((await fetch(`${running.origin}/api/pulls`)).status).toBe(200);
    }
    expect(releaseService.primeRepositories).not.toHaveBeenCalled();
    await running.close();
  });

  it("swallows a background repository-prime rejection after returning pulls", async () => {
    const releaseService = {
      primeRepositories: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const running = await apiServer({
      cache: {
        get: vi.fn(async () => ({ ...snapshot(), viewerLogin: "viewer" })),
      },
      releaseService,
      fallback: (_request, response) => response.end(),
    });

    expect((await fetch(`${running.origin}/api/pulls`)).status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(releaseService.primeRepositories).toHaveBeenCalledOnce();
    await running.close();
  });

  it("returns correct statuses for unsupported API methods and paths", async () => {
    const cache = { get: vi.fn(async () => snapshot()) };
    const running = await apiServer({
      cache,
      fallback: (_request, response) => response.end(),
    });

    const method = await fetch(`${running.origin}/api/pulls`, {
      method: "POST",
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect((await fetch(`${running.origin}/api/missing`)).status).toBe(404);
    await running.close();
  });

  it("does not expose unexpected server error details", async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new Error("ghp_super_secret");
      }),
    };
    const running = await apiServer({
      cache,
      fallback: (_request, response) => response.end(),
    });

    const body = await (await fetch(`${running.origin}/api/pulls`)).text();
    expect(body).toContain("gh auth status");
    expect(body).not.toContain("ghp_super_secret");
    await running.close();
  });

  it("returns actionable normalized initial cache errors", async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new SnapshotError(
          "Run gh auth status, then gh auth login if needed.",
        );
      }),
    };
    const running = await apiServer({
      cache,
      fallback: (_request, response) => response.end(),
    });

    const response = await fetch(`${running.origin}/api/pulls`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("gh auth login");
    await running.close();
  });
});

describe("local action API", () => {
  async function actionServer(runManager, executionEnabled = true) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const running = await listenAt(
      createRequestListener({
        cache: { get: vi.fn(async () => snapshot()) },
        runManager,
        actionToken: "process-token",
        trustedOrigin: origin,
        executionEnabled,
        fallback: (_request, response) => response.end("client"),
      }),
      port,
    );
    return running;
  }

  it("returns the per-process action token only for the exact trusted host", async () => {
    const running = await actionServer({ start: vi.fn(), cancel: vi.fn() });
    const response = await fetch(`${running.origin}/api/actions/token`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ token: "process-token" });

    const untrusted = await fetch(`${running.origin}/api/actions/token`, {
      headers: { Origin: "http://evil.invalid" },
    });
    expect(untrusted.status).toBe(403);
    await running.close();
  });

  it("requires JSON, the exact Origin and Host, and the action token", async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() };
    const running = await actionServer(runManager);
    const body = JSON.stringify({
      repository: "owner/repo",
      number: 1,
      expectedHeadRefOid: "a".repeat(40),
      message: "fix",
    });

    for (const headers of [
      { "Content-Type": "application/json", Origin: running.origin },
      {
        "Content-Type": "application/json",
        Origin: "http://evil.invalid",
        "X-Action-Token": "process-token",
      },
      {
        "Content-Type": "application/json",
        Origin: running.origin,
        "X-Action-Token": "wrong",
      },
    ]) {
      const response = await fetch(`${running.origin}/api/claude/runs`, {
        method: "POST",
        headers,
        body,
      });
      expect(response.status).toBe(403);
    }
    expect(runManager.start).not.toHaveBeenCalled();

    const media = await fetch(`${running.origin}/api/claude/runs`, {
      method: "POST",
      headers: {
        Origin: running.origin,
        "X-Action-Token": "process-token",
        "Content-Type": "text/plain",
      },
      body,
    });
    expect(media.status).toBe(415);
    await running.close();
  });

  it("streams NDJSON start and terminal events and forwards the parsed body", async () => {
    const runManager = {
      start: vi.fn(async (body, channel) => {
        channel.write({
          type: "start",
          runId: "one",
          repository: body.repository,
          number: body.number,
        });
        channel.write({ type: "diagnostic", text: "Claude Code started." });
        channel.write({ type: "complete", exitCode: 0 });
      }),
      cancel: vi.fn(),
    };
    const running = await actionServer(runManager);
    const body = {
      repository: "owner/repo",
      number: 1,
      expectedHeadRefOid: "a".repeat(40),
      message: "",
      source: "auto",
      triggers: [
        {
          kind: "issue_comment",
          id: "issue-comment-1",
          updatedAt: "2026-07-22T00:00:00Z",
        },
      ],
    };
    const response = await fetch(`${running.origin}/api/claude/runs`, {
      method: "POST",
      headers: {
        Origin: running.origin,
        "X-Action-Token": "process-token",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.text()).trim().split("\n").map(JSON.parse)).toEqual([
      { type: "start", runId: "one", repository: "owner/repo", number: 1 },
      { type: "diagnostic", text: "Claude Code started." },
      { type: "complete", exitCode: 0 },
    ]);
    expect(runManager.start.mock.calls[0][0]).toEqual({
      ...body,
      agent: "claude",
    });
    await running.close();
  });

  it("keeps the legacy route Claude-only and forwards explicit providers through the neutral route", async () => {
    const runManager = {
      start: vi.fn(async (value, channel) => {
        const input = validateRunInput(value);
        channel.write({
          type: "start",
          agent: input.agent,
          runId: `${input.agent}-run`,
          repository: input.repository,
          number: input.number,
        });
        channel.write({ type: "complete", exitCode: 0 });
      }),
      cancel: vi.fn(async () => true),
    };
    const running = await actionServer(runManager);
    const headers = {
      Origin: running.origin,
      "X-Action-Token": "process-token",
      "Content-Type": "application/json",
    };
    const base = {
      repository: "owner/repo",
      number: 1,
      expectedHeadRefOid: "a".repeat(40),
      message: "fix",
    };

    const neutral = await fetch(`${running.origin}/api/agents/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...base, agent: "codex" }),
    });
    expect(neutral.status).toBe(200);
    expect(
      (await neutral.text()).trim().split("\n").map(JSON.parse)[0],
    ).toEqual(expect.objectContaining({ agent: "codex" }));

    const legacy = await fetch(`${running.origin}/api/claude/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...base, agent: "codex" }),
    });
    expect(legacy.status).toBe(200);
    expect((await legacy.text()).trim().split("\n").map(JSON.parse)[0]).toEqual(
      expect.objectContaining({ agent: "claude" }),
    );
    expect(runManager.start.mock.calls[0][0]).toMatchObject({
      agent: "codex",
    });
    expect(runManager.start.mock.calls[1][0]).toMatchObject({
      agent: "claude",
    });

    const grok = await fetch(`${running.origin}/api/agents/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...base, agent: "grok" }),
    });
    expect(grok.status).toBe(200);
    expect((await grok.text()).trim().split("\n").map(JSON.parse)[0]).toEqual(
      expect.objectContaining({ agent: "grok" }),
    );
    expect(runManager.start.mock.calls[2][0]).toMatchObject({
      agent: "grok",
    });

    for (const value of [{ ...base }, { ...base, agent: "other" }]) {
      const response = await fetch(`${running.origin}/api/agents/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });
      expect(response.status).toBe(400);
    }

    for (const path of [
      "/api/agents/runs/codex-run",
      "/api/claude/runs/claude-run",
    ]) {
      expect(
        (
          await fetch(`${running.origin}${path}`, {
            method: "DELETE",
            headers: {
              Origin: running.origin,
              "X-Action-Token": "process-token",
            },
          })
        ).status,
      ).toBe(204);
    }
    expect(runManager.cancel).toHaveBeenCalledTimes(2);
    await running.close();
  });

  it("reports a disconnect to a run that registers its close listener late", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const disconnected = vi.fn();
    const runManager = {
      start: vi.fn(async (_body, channel) => {
        await gate;
        channel.onClose(disconnected);
      }),
      cancel: vi.fn(),
    };
    const running = await actionServer(runManager);
    const url = new URL(running.origin);
    const body = JSON.stringify({
      repository: "owner/repo",
      number: 1,
      expectedHeadRefOid: "a".repeat(40),
      message: "fix",
    });
    const outgoing = request({
      host: url.hostname,
      port: url.port,
      path: "/api/claude/runs",
      method: "POST",
      headers: {
        "Content-Length": Buffer.byteLength(body),
        "Content-Type": "application/json",
        Origin: running.origin,
        "X-Action-Token": "process-token",
      },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);

    await eventually(() => expect(runManager.start).toHaveBeenCalledOnce());
    outgoing.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await eventually(() => expect(disconnected).toHaveBeenCalledOnce());
    await running.close();
  });

  it("aborts real review preflight over HTTP, releases its reservation, cleans its workspace, and retries immediately", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const cleanups = [];
    const children = [];
    let authorizations = 0;
    const reviewProof = (headRefOid = HEAD) => ({
      authored: true,
      authorLogin: "viewer",
      available: true,
      baseRefOid: BASE,
      complete: true,
      headRefName: "fix/review",
      headRefOid,
      headRepository: "owner/repo",
      isCrossRepository: false,
      number: 7,
      open: true,
      repository: "owner/repo",
      state: "OPEN",
      url: "https://github.com/owner/repo/pull/7",
      viewerLogin: "viewer",
      viewerPermission: "WRITE",
    });
    const loadReviewAuthorization = vi.fn((_input, signal) => {
      authorizations += 1;
      if (authorizations === 3) {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return Promise.resolve(
        reviewProof(authorizations === 7 ? "f".repeat(40) : HEAD),
      );
    });
    const diffService = {
      invalidate: vi.fn(),
      loadAuthorized: vi.fn(async () => ({
        authorization: {
          authorLogin: "viewer",
          baseRefOid: BASE,
          headRefOid: HEAD,
          number: 7,
          repository: "owner/repo",
          url: "https://github.com/owner/repo/pull/7",
          viewerLogin: "viewer",
        },
        diff: {
          baseRefOid: BASE,
          complete: true,
          files: [
            {
              hunks: [
                {
                  lines: [
                    {
                      content: "changed",
                      kind: "addition",
                      newLine: 1,
                      oldLine: null,
                    },
                  ],
                },
              ],
              path: "src/example.js",
              truncated: false,
            },
          ],
          headRefOid: HEAD,
          number: 7,
          repository: "owner/repo",
        },
      })),
    };
    const resolver = {
      clear: vi.fn(),
      resolve: vi.fn(),
      resolveReview: vi.fn(async () => {
        const cleanup = vi.fn(async () => undefined);
        cleanups.push(cleanup);
        return {
          branch: "fix/review",
          cleanup,
          cwd: `/trusted/review-${cleanups.length}`,
          headRefOid: HEAD,
          remote: "origin",
          repository: "owner/repo",
        };
      }),
      verifyReview: vi.fn(async (workspace) => ({
        ...workspace,
        headRefOid: "f".repeat(40),
      })),
    };
    const spawn = vi.fn(() => {
      const childProcess = new EventEmitter();
      childProcess.pid = 321;
      childProcess.stdout = new PassThrough();
      childProcess.stderr = new PassThrough();
      childProcess.kill = vi.fn();
      children.push(childProcess);
      return childProcess;
    });
    const runManager = createClaudeRunManager({
      cache: { get: vi.fn() },
      canonicalize: vi.fn(async (value) => value),
      coordinator,
      createId: () => "review-http-run",
      createTemporary: vi.fn(async () => "/private/tmp/review-http-run"),
      diffService,
      loadPull: vi.fn(),
      loadReviewAuthorization,
      removeTemporary: vi.fn(async () => undefined),
      resolver,
      spawn,
    });
    const running = await actionServer(runManager);
    const url = new URL(running.origin);
    const body = JSON.stringify({
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      feedback: {
        body: "Handle the edge case.",
        line: 1,
        path: "src/example.js",
        side: "RIGHT",
      },
      message: "",
      number: 7,
      repository: "owner/repo",
      source: "review",
    });
    const headers = {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json",
      Origin: running.origin,
      "X-Action-Token": "process-token",
    };
    const outgoing = request({
      headers,
      host: url.hostname,
      method: "POST",
      path: "/api/claude/runs",
      port: url.port,
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);

    await eventually(() =>
      expect(loadReviewAuthorization).toHaveBeenCalledTimes(3),
    );
    outgoing.destroy();
    await eventually(() => expect(cleanups[0]).toHaveBeenCalledOnce());
    await eventually(() => expect(coordinator.activeCount()).toBe(0));
    expect(spawn).not.toHaveBeenCalled();

    const retry = await fetch(`${running.origin}/api/claude/runs`, {
      body,
      headers: {
        "Content-Type": "application/json",
        Origin: running.origin,
        "X-Action-Token": "process-token",
      },
      method: "POST",
    });
    expect(retry.status).toBe(200);
    expect(spawn).toHaveBeenCalledOnce();
    children[0].emit("close", 0, null);
    const events = (await retry.text()).trim().split("\n").map(JSON.parse);
    expect(events[0]).toMatchObject({
      runId: "review-http-run",
      type: "start",
    });
    expect(events.at(-1)).toEqual({ exitCode: 0, type: "complete" });
    await eventually(() => expect(cleanups[1]).toHaveBeenCalledOnce());
    expect(coordinator.activeCount()).toBe(0);
    await running.close();
  });

  it("caps the body before starting a run and cancels idempotently", async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() };
    const running = await actionServer(runManager);
    const headers = {
      Origin: running.origin,
      "X-Action-Token": "process-token",
      "Content-Type": "application/json",
    };
    const oversized = await fetch(`${running.origin}/api/claude/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(runManager.start).not.toHaveBeenCalled();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${running.origin}/api/claude/runs/run-1`, {
        method: "DELETE",
        headers: { Origin: running.origin, "X-Action-Token": "process-token" },
      });
      expect(response.status).toBe(204);
    }
    expect(runManager.cancel).toHaveBeenCalledTimes(2);
    await running.close();
  });

  it("disables execution on externally bound servers without the second opt-in", async () => {
    const runManager = { start: vi.fn(), cancel: vi.fn() };
    const running = await actionServer(runManager, false);
    const response = await fetch(`${running.origin}/api/claude/runs`, {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(runManager.start).not.toHaveBeenCalled();
    await running.close();
  });
});

describe("new task API", () => {
  const options = {
    repositories: [
      {
        base: "main",
        branches: ["main", "1.9.x"],
        repository: "owner/repo",
      },
    ],
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  const task = {
    agent: "claude",
    base: "main",
    branch: "puller/task-one",
    id: "task-one-123",
    prompt: "Add the feature",
    repository: "owner/repo",
    state: "running",
  };

  function manager(overrides = {}) {
    return {
      cancel: vi.fn(async () => ({ ...task, state: "cancelled" })),
      list: vi.fn(() => [task]),
      options: vi.fn(async () => options),
      start: vi.fn(async () => task),
      subscribe: vi.fn(() =>
        (async function* events() {
          yield { sequence: 1, task, type: "snapshot" };
          yield { sequence: 2, text: "Claude started.", type: "output" };
        })(),
      ),
      ...overrides,
    };
  }

  async function taskServer(taskManager, executionEnabled = true) {
    return await apiServer({
      actionToken: "process-token",
      cache: { get: vi.fn(async () => snapshot()) },
      executionEnabled,
      fallback: (_request, response) => response.end("client"),
      taskManager,
    });
  }

  function headers(origin, contentType = "application/json") {
    return {
      "Content-Type": contentType,
      Origin: origin,
      "X-Action-Token": "process-token",
    };
  }

  it("loads cached repository options and task runs without mutation authorization", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager);

    const optionResponse = await fetch(`${running.origin}/api/tasks/options`);
    const listResponse = await fetch(`${running.origin}/api/tasks/runs`);

    expect(optionResponse.status).toBe(200);
    expect(optionResponse.headers.get("cache-control")).toBe("no-store");
    await expect(optionResponse.json()).resolves.toEqual(options);
    await expect(listResponse.json()).resolves.toEqual([task]);
    expect(taskManager.options).toHaveBeenCalledOnce();
    expect(taskManager.list).toHaveBeenCalledOnce();
    expect(taskManager.start).not.toHaveBeenCalled();
    await running.close();
  });

  it("starts a task with a stable client identity and returns its initial state", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager);
    const body = {
      agent: "claude",
      base: "main",
      id: "task-one-123",
      prompt: "Add the feature",
      repository: "owner/repo",
    };
    const response = await fetch(`${running.origin}/api/tasks/runs`, {
      body: JSON.stringify(body),
      headers: headers(running.origin),
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(task);
    expect(taskManager.start).toHaveBeenCalledWith(body);
    await running.close();
  });

  it("protects task mutations and rejects malformed bodies before task setup", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager);
    const valid = JSON.stringify({
      agent: "claude",
      base: "main",
      id: "task-one-123",
      prompt: "Add it",
      repository: "owner/repo",
    });

    for (const requestOptions of [
      {
        body: valid,
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      { body: valid, headers: headers("http://evil.invalid"), method: "POST" },
      {
        body: valid,
        headers: headers(running.origin, "text/plain"),
        method: "POST",
      },
      {
        body: JSON.stringify({ id: "task-one-123", repository: "owner/repo" }),
        headers: headers(running.origin),
        method: "POST",
      },
    ]) {
      expect(
        (await fetch(`${running.origin}/api/tasks/runs`, requestOptions))
          .status,
      ).toBe(
        requestOptions.headers["Content-Type"] === "text/plain"
          ? 415
          : requestOptions.headers.Origin === running.origin
            ? 400
            : 403,
      );
    }
    expect(taskManager.start).not.toHaveBeenCalled();
    await running.close();
  });

  it("replays task events after a validated cursor as NDJSON", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager);
    const response = await fetch(
      `${running.origin}/api/tasks/runs/task-one-123/events?after=7`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect((await response.text()).trim().split("\n").map(JSON.parse)).toEqual([
      { sequence: 1, task, type: "snapshot" },
      { sequence: 2, text: "Claude started.", type: "output" },
    ]);
    expect(taskManager.subscribe).toHaveBeenCalledWith("task-one-123", {
      after: 7,
      signal: expect.any(AbortSignal),
    });

    for (const suffix of [
      "?after=-1",
      "?after=1.5",
      "?after=1&after=2",
      "?cursor=1",
    ]) {
      expect(
        (
          await fetch(
            `${running.origin}/api/tasks/runs/task-one-123/events${suffix}`,
          )
        ).status,
      ).toBe(400);
    }
    expect(taskManager.subscribe).toHaveBeenCalledOnce();
    await running.close();
  });

  it("aborts only the event subscription when its client disconnects", async () => {
    let subscriptionSignal;
    const taskManager = manager({
      subscribe: vi.fn((_id, { signal }) => {
        subscriptionSignal = signal;
        return (async function* events() {
          yield { sequence: 1, task, type: "snapshot" };
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        })();
      }),
    });
    const running = await taskServer(taskManager);
    const controller = new AbortController();
    const response = await fetch(
      `${running.origin}/api/tasks/runs/task-one-123/events`,
      { signal: controller.signal },
    );
    await response.body.getReader().read();
    controller.abort();

    await eventually(() => expect(subscriptionSignal.aborted).toBe(true));
    expect(taskManager.cancel).not.toHaveBeenCalled();
    await running.close();
  });

  it("cancels idempotently and preserves safe task error statuses", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager);
    const response = await fetch(
      `${running.origin}/api/tasks/runs/task-one-123`,
      {
        headers: headers(running.origin),
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(taskManager.cancel).toHaveBeenCalledWith("task-one-123");
    await running.close();

    const missingManager = manager({
      subscribe: vi.fn(() => {
        throw new TaskError(
          404,
          "task_not_found",
          "The task run was not found.",
        );
      }),
    });
    const missing = await taskServer(missingManager);
    const missingResponse = await fetch(
      `${missing.origin}/api/tasks/runs/missing-task/events`,
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      code: "task_not_found",
      error: "The task run was not found.",
    });
    await missing.close();

    const conflictManager = manager({
      start: vi.fn(async () => {
        throw new TaskError(
          409,
          "task_id_conflict",
          "This task identifier belongs to another request.",
        );
      }),
    });
    const conflict = await taskServer(conflictManager);
    const conflictResponse = await fetch(`${conflict.origin}/api/tasks/runs`, {
      body: JSON.stringify({
        agent: "claude",
        base: "main",
        id: "task-one-123",
        prompt: "Add it",
        repository: "owner/repo",
      }),
      headers: headers(conflict.origin),
      method: "POST",
    });
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toEqual({
      code: "task_id_conflict",
      error: "This task identifier belongs to another request.",
    });
    await conflict.close();
  });

  it("uses the existing execution-disabled response for task mutations", async () => {
    const taskManager = manager();
    const running = await taskServer(taskManager, false);
    const response = await fetch(`${running.origin}/api/tasks/runs`, {
      body: JSON.stringify({
        agent: "claude",
        base: "main",
        id: "task-one-123",
        prompt: "Add it",
        repository: "owner/repo",
      }),
      headers: headers(running.origin),
      method: "POST",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "execution_disabled",
    });
    expect(taskManager.start).not.toHaveBeenCalled();
    await running.close();
  });
});

describe("GitHub operations API", () => {
  function services(overrides = {}) {
    return {
      checkLogsService: {
        load: vi.fn(
          async ({ headRefOid, jobId, number, repository, runId }) => ({
            cached: false,
            fetchedAt: "2026-07-21T05:00:00.000Z",
            headRefOid,
            jobId,
            log: "failed output",
            number,
            repository,
            runId,
          }),
        ),
      },
      commitsService: {
        load: vi.fn(async () => commits()),
        loadCommitDiff: vi.fn(async () => commitDiff()),
      },
      diffService: {
        load: vi.fn(async () => diff()),
      },
      mergeService: {
        merge: vi.fn(async ({ repository, number }) => ({
          mergeCommitOid: null,
          merged: true,
          number,
          repository,
          url: `https://github.com/${repository}/pull/${number}`,
        })),
      },
      reviewCommentService: {
        create: vi.fn(async (input) => ({
          comment: {
            body: input.body,
            commitId: input.expectedHeadRefOid,
            id: 901,
            line: input.line,
            path: input.path,
            side: input.side,
            ...(input.startLine === undefined
              ? {}
              : {
                  startLine: input.startLine,
                  startSide: input.startSide,
                }),
            url: `https://github.com/${input.repository}/pull/${input.number}#discussion_r901`,
          },
          current: true,
        })),
      },
      repairManager: {
        cancelObserved: vi.fn(async ({ id, number, repository }) => ({
          type: "snapshot",
          actionId: id,
          repository,
          number,
          headRefOid: HEAD,
          state: "cancelled",
          updatedAt: "2026-07-21T06:00:00.000Z",
          output: "",
          terminal: true,
        })),
        watch: vi.fn(async ({ id, number, repository }, channel) => {
          channel.write({
            type: "snapshot",
            actionId: id,
            repository,
            number,
            headRefOid: HEAD,
            state: "repair_running",
            updatedAt: "2026-07-21T05:59:00.000Z",
            output: "",
            terminal: false,
          });
          channel.write({
            type: "state",
            actionId: id,
            repository,
            number,
            headRefOid: HEAD,
            state: "ready",
            updatedAt: "2026-07-21T06:00:00.000Z",
            commit: BASE,
            terminal: true,
          });
        }),
      },
      releaseService: {
        create: vi.fn(async ({ repository, tag }) => ({
          id: "release-1",
          name: tag,
          publishedAt: "2026-07-21T00:00:00.000Z",
          repository,
          tag,
          url: `https://github.com/${repository}/releases/tag/${tag}`,
        })),
        getOptions: vi.fn(async () => releaseOptions()),
        getPipelines: vi.fn(async () => releasePipelines()),
        getRecent: vi.fn(async () => recentReleases()),
        preview: vi.fn(async () => releasePreview()),
      },
      releaseVerificationManager: {
        cancel: vi.fn(),
        start: vi.fn(async (body, channel) => {
          channel.write({
            type: "batch-start",
            batchId: "batch-1",
            pulls: [],
            ...body,
          });
          channel.write({
            type: "complete",
            batchId: "batch-1",
            totals: { complete: 0, error: 0, existing: 0, total: 0 },
          });
        }),
      },
      verificationManager: {
        cancel: vi.fn(),
        start: vi.fn(async (body, channel) => {
          channel.write({ type: "start", runId: "verify-1", ...body });
          channel.write({ type: "complete", exitCode: 0 });
        }),
      },
      ...overrides,
    };
  }

  async function operationServer(overrides = {}, executionEnabled = true) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const configured = services(overrides);
    const cache = { get: vi.fn(async () => snapshot()) };
    const runManager = { start: vi.fn(), cancel: vi.fn() };
    const running = await listenAt(
      createRequestListener({
        cache,
        runManager,
        actionToken: "process-token",
        trustedOrigin: origin,
        executionEnabled,
        fallback: (_request, response) => response.end("client"),
        ...configured,
      }),
      port,
    );
    return { ...running, ...configured, cache, runManager };
  }

  function actionHeaders(origin, contentType = "application/json") {
    return {
      "Content-Type": contentType,
      Origin: origin,
      "X-Action-Token": "process-token",
    };
  }

  it("rejects hostile Host or Origin on every API read before invoking a service", async () => {
    const running = await operationServer();
    const paths = [
      "/api/pulls",
      `/api/pulls/owner/repo/7/commits?base=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/commits/${HEAD}?base=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      "/api/releases/options",
      "/api/releases/pipelines",
      "/api/releases/recent",
      "/api/actions/token",
    ];
    for (const path of paths) {
      const response = await fetch(`${running.origin}${path}`, {
        headers: { Origin: "http://evil.invalid" },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        code: "untrusted_origin",
        error: "Untrusted request origin.",
      });
    }

    const hostileHost = await rawResponse(running.origin, "/api/pulls", {
      headers: { Host: "evil.invalid" },
    });
    expect(hostileHost.status).toBe(403);
    expect(JSON.parse(hostileHost.body)).toEqual({
      code: "untrusted_origin",
      error: "Untrusted request origin.",
    });
    expect(running.cache.get).not.toHaveBeenCalled();
    expect(running.checkLogsService.load).not.toHaveBeenCalled();
    expect(running.diffService.load).not.toHaveBeenCalled();
    expect(running.releaseService.getOptions).not.toHaveBeenCalled();
    expect(running.releaseService.getPipelines).not.toHaveBeenCalled();
    expect(running.releaseService.getRecent).not.toHaveBeenCalled();
    await running.close();
  });

  it("rejects cross-site Fetch Metadata before invoking any API read", async () => {
    const running = await operationServer();
    const paths = [
      "/api/pulls",
      `/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      "/api/releases/options",
      "/api/releases/pipelines",
      "/api/releases/recent",
      "/api/actions/token",
    ];

    for (const path of paths) {
      const response = await fetch(`${running.origin}${path}`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        code: "untrusted_origin",
        error: "Untrusted request origin.",
      });
    }

    expect(running.cache.get).not.toHaveBeenCalled();
    expect(running.checkLogsService.load).not.toHaveBeenCalled();
    expect(running.diffService.load).not.toHaveBeenCalled();
    expect(running.releaseService.getOptions).not.toHaveBeenCalled();
    expect(running.releaseService.getPipelines).not.toHaveBeenCalled();
    expect(running.releaseService.getRecent).not.toHaveBeenCalled();
    await running.close();
  });

  it("preserves same-origin Fetch Metadata and non-browser API reads", async () => {
    const running = await operationServer();
    const sameOrigin = await fetch(`${running.origin}/api/pulls`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    const commandLine = await fetch(`${running.origin}/api/pulls`);

    expect(sameOrigin.status).toBe(200);
    expect(commandLine.status).toBe(200);
    expect(running.cache.get).toHaveBeenCalledTimes(2);
    await running.close();
  });

  it("loads failed check logs with exact string identities and no action token", async () => {
    const running = await operationServer();
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/checks/12345678901234567890/jobs/98765432109876543210/logs?baseRefOid=${BASE.toUpperCase()}&headRefOid=${HEAD.toUpperCase()}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      cached: false,
      fetchedAt: "2026-07-21T05:00:00.000Z",
      headRefOid: HEAD,
      jobId: "98765432109876543210",
      log: "failed output",
      number: 7,
      repository: "owner/repo",
      runId: "12345678901234567890",
    });
    expect(running.checkLogsService.load).toHaveBeenCalledWith(
      {
        baseRefOid: BASE,
        headRefOid: HEAD,
        jobId: "98765432109876543210",
        number: 7,
        repository: "owner/repo",
        runId: "12345678901234567890",
      },
      expect.any(AbortSignal),
    );
    await running.close();
  });

  it("rejects malformed failed-check paths, queries, and methods before service execution", async () => {
    const running = await operationServer();
    const invalid = [
      `/api/pulls/owner/repo/7/checks/run-1/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/0/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/01/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/${"1".repeat(21)}/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/job-1/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?headRefOid=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}&extra=1`,
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&baseRefOid=${BASE}&headRefOid=${HEAD}`,
    ];
    for (const path of invalid) {
      expect((await fetch(`${running.origin}${path}`)).status).toBe(400);
    }
    const method = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      { method: "POST" },
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect(running.checkLogsService.load).not.toHaveBeenCalled();
    await running.close();
  });

  it("preserves safe failed-check authorization errors and redacts unexpected failures", async () => {
    const missing = await operationServer({
      checkLogsService: {
        load: vi.fn(async () => {
          throw new CheckLogsError("not_found");
        }),
      },
    });
    const path = `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`;
    const missingResponse = await fetch(`${missing.origin}${path}`);
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      code: "not_found",
      error: "Failed check logs were not found.",
    });
    await missing.close();

    const failed = await operationServer({
      checkLogsService: {
        load: vi.fn(async () => {
          throw new Error("stderr ghp_secret /Users/private");
        }),
      },
    });
    const failedResponse = await fetch(`${failed.origin}${path}`);
    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.text()).not.toMatch(
      /ghp_secret|\/Users\/private/,
    );
    await failed.close();
  });

  it("rejects hostile Host or Origin before any mutation is authorized", async () => {
    const running = await operationServer();
    const paths = [
      ["/api/claude/runs", "POST"],
      ["/api/pulls/owner/repo/7/merge", "POST"],
      ["/api/pulls/owner/repo/7/comments", "POST"],
      ["/api/releases", "POST"],
      ["/api/releases/verifications", "POST"],
      ["/api/releases/verifications/batch-1", "DELETE"],
      ["/api/verifications", "POST"],
      ["/api/verifications/verify-1", "DELETE"],
    ];
    for (const [path, method] of paths) {
      const response = await fetch(`${running.origin}${path}`, {
        headers: { Origin: "http://evil.invalid" },
        method,
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "untrusted_origin",
      });
    }
    const hostileHost = await rawResponse(running.origin, "/api/releases", {
      headers: { Host: "evil.invalid" },
      method: "POST",
    });
    expect(hostileHost.status).toBe(403);
    expect(running.runManager.start).not.toHaveBeenCalled();
    expect(running.mergeService.merge).not.toHaveBeenCalled();
    expect(running.reviewCommentService.create).not.toHaveBeenCalled();
    expect(running.releaseService.create).not.toHaveBeenCalled();
    expect(running.releaseVerificationManager.start).not.toHaveBeenCalled();
    expect(running.verificationManager.start).not.toHaveBeenCalled();
    expect(running.verificationManager.cancel).not.toHaveBeenCalled();
    await running.close();
  });

  it("loads a head-pinned pull diff and forwards canonical route identity", async () => {
    const running = await operationServer();
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/diff?base=${BASE.toUpperCase()}&head=${HEAD.toUpperCase()}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(diff());
    expect(running.diffService.load).toHaveBeenCalledWith({
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      number: 7,
      repository: "owner/repo",
      signal: expect.any(AbortSignal),
    });
    await running.close();
  });

  it("loads a head-pinned commit list and an exact proven commit diff", async () => {
    const running = await operationServer();
    const query = `base=${BASE.toUpperCase()}&head=${HEAD.toUpperCase()}`;

    const list = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/commits?${query}`,
    );
    const selected = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/commits/${HEAD.toUpperCase()}?${query}`,
    );

    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual(commits());
    expect(selected.status).toBe(200);
    await expect(selected.json()).resolves.toEqual(commitDiff());
    const identity = {
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      number: 7,
      repository: "owner/repo",
      signal: expect.any(AbortSignal),
    };
    expect(running.commitsService.load).toHaveBeenCalledWith(identity);
    expect(running.commitsService.loadCommitDiff).toHaveBeenCalledWith({
      ...identity,
      commitSha: HEAD,
    });
    await running.close();
  });

  it.each([
    [
      "diff",
      `/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`,
      "diffService",
    ],
    [
      "failed logs",
      `/api/pulls/owner/repo/7/checks/123/jobs/456/logs?baseRefOid=${BASE}&headRefOid=${HEAD}`,
      "checkLogsService",
    ],
  ])(
    "aborts %s service work when the HTTP client disconnects",
    async (_label, path, key) => {
      let signal;
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      const load = vi.fn((value, directSignal) => {
        const current = directSignal ?? value.signal;
        signal = current;
        return new Promise((_resolve, reject) => {
          current.addEventListener(
            "abort",
            () => {
              settle();
              reject(current.reason);
            },
            { once: true },
          );
        });
      });
      const running = await operationServer({ [key]: { load } });
      const url = new URL(running.origin);
      const outgoing = request({
        host: url.hostname,
        path,
        port: url.port,
      });
      outgoing.on("error", () => undefined);
      outgoing.end();

      await eventually(() => expect(load).toHaveBeenCalledOnce());
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      outgoing.destroy();
      await settled;
      expect(signal.aborted).toBe(true);
      await running.close();
    },
  );

  it("loads release options and maps only refresh=1 to cache bypasses", async () => {
    const running = await operationServer();
    await expect(
      (await fetch(`${running.origin}/api/releases/options`)).json(),
    ).resolves.toEqual(releaseOptions());
    await expect(
      (await fetch(`${running.origin}/api/releases/recent?refresh=1`)).json(),
    ).resolves.toEqual(recentReleases());
    await expect(
      (await fetch(`${running.origin}/api/releases/pipelines`)).json(),
    ).resolves.toEqual(releasePipelines());
    await expect(
      (
        await fetch(`${running.origin}/api/releases/pipelines?discover=1`)
      ).json(),
    ).resolves.toEqual(releasePipelines());
    await expect(
      (
        await fetch(`${running.origin}/api/releases/pipelines?refresh=1`)
      ).json(),
    ).resolves.toEqual(releasePipelines());
    await fetch(`${running.origin}/api/releases/options?refresh=1`);
    expect(running.releaseService.getOptions).toHaveBeenNthCalledWith(1, {
      refresh: false,
    });
    expect(running.releaseService.getOptions).toHaveBeenNthCalledWith(2, {
      refresh: true,
    });
    expect(running.releaseService.getRecent).toHaveBeenCalledWith({
      refresh: true,
    });
    expect(running.releaseService.getPipelines).toHaveBeenNthCalledWith(1, {
      discover: false,
      refresh: false,
    });
    expect(running.releaseService.getPipelines).toHaveBeenNthCalledWith(2, {
      discover: true,
      refresh: false,
    });
    expect(running.releaseService.getPipelines).toHaveBeenNthCalledWith(3, {
      discover: false,
      refresh: true,
    });
    await running.close();
  });

  it("merges through the fresh-gated service using route-owned identity", async () => {
    const running = await operationServer();
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/merge`,
      {
        body: JSON.stringify({
          agent: "claude",
          expectedHeadRefOid: HEAD,
        }),
        headers: actionHeaders(running.origin),
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mergeCommitOid: null,
      merged: true,
      number: 7,
      repository: "owner/repo",
      url: "https://github.com/owner/repo/pull/7",
    });
    expect(running.mergeService.merge).toHaveBeenCalledWith({
      agent: "claude",
      expectedHeadRefOid: HEAD,
      number: 7,
      repository: "owner/repo",
    });
    await running.close();
  });

  it("does not expose the retired direct GitHub review-comment mutation", async () => {
    const running = await operationServer();
    const path = `${running.origin}/api/pulls/owner/repo/7/comments`;
    const response = await fetch(path, {
      body: JSON.stringify({ body: "Do not post this." }),
      headers: actionHeaders(running.origin),
      method: "POST",
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      code: "not_found",
      error: "API endpoint not found.",
    });
    expect(running.reviewCommentService.create).not.toHaveBeenCalled();
    await running.close();
  });

  it("creates a generated-notes release through the release service", async () => {
    const running = await operationServer();
    const body = {
      expectedLatestTag: "v1.2.3",
      prerelease: false,
      preview: releasePreview(),
      repository: "owner/repo",
      tag: "v1.2.4",
    };
    const response = await fetch(`${running.origin}/api/releases`, {
      body: JSON.stringify(body),
      headers: actionHeaders(running.origin),
      method: "POST",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "release-1",
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    expect(running.releaseService.create).toHaveBeenCalledWith(body);
    await running.close();
  });

  it("authorizes and forwards exact release preview requests", async () => {
    const running = await operationServer();
    const body = {
      expectedLatestTag: "v1.2.3",
      repository: "owner/repo",
      tag: "v1.2.4",
    };
    const response = await fetch(`${running.origin}/api/releases/preview`, {
      body: JSON.stringify(body),
      headers: actionHeaders(running.origin),
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(releasePreview());
    expect(running.releaseService.preview).toHaveBeenCalledWith(body);

    const unauthorized = await fetch(`${running.origin}/api/releases/preview`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: running.origin,
      },
      method: "POST",
    });
    expect(unauthorized.status).toBe(403);
    expect(running.releaseService.preview).toHaveBeenCalledTimes(1);

    const extra = await fetch(`${running.origin}/api/releases/preview`, {
      body: JSON.stringify({ ...body, extra: true }),
      headers: actionHeaders(running.origin),
      method: "POST",
    });
    expect(extra.status).toBe(400);
    expect(running.releaseService.preview).toHaveBeenCalledTimes(1);
    await running.close();
  });

  it("forwards pre-release creation and rejects incomplete or extra release input", async () => {
    const running = await operationServer();
    const prerelease = {
      expectedLatestTag: "v1.2.3",
      prerelease: true,
      preview: { ...releasePreview(), tag: "v1.2.4-rc.1" },
      repository: "owner/repo",
      tag: "v1.2.4-rc.1",
    };
    const created = await fetch(`${running.origin}/api/releases`, {
      body: JSON.stringify(prerelease),
      headers: actionHeaders(running.origin),
      method: "POST",
    });
    expect(created.status).toBe(201);
    expect(running.releaseService.create).toHaveBeenCalledWith(prerelease);

    for (const body of [
      {
        expectedLatestTag: "v1.2.3",
        repository: "owner/repo",
        tag: "v1.2.4",
      },
      {
        expectedLatestTag: "v1.2.3",
        extra: true,
        prerelease: false,
        repository: "owner/repo",
        tag: "v1.2.4",
      },
    ]) {
      const response = await fetch(`${running.origin}/api/releases`, {
        body: JSON.stringify(body),
        headers: actionHeaders(running.origin),
        method: "POST",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(running.releaseService.create).toHaveBeenCalledTimes(1);
    await running.close();
  });

  it("streams exact repair snapshots and live output without echoing its action token", async () => {
    const token = "R".repeat(43);
    const repairManager = {
      cancelObserved: vi.fn(),
      watch: vi.fn(async (identity, channel) => {
        expect(identity).toEqual({
          id: "repair-1",
          number: 7,
          repository: "owner/repo",
          token,
        });
        channel.write({
          type: "snapshot",
          actionId: "repair-1",
          repository: "owner/repo",
          number: 7,
          headRefOid: HEAD,
          state: "repair_running",
          updatedAt: "2026-07-21T05:59:00.000Z",
          output: '<script>\n{"raw":true}',
          terminal: false,
        });
        channel.write({
          type: "output",
          actionId: "repair-1",
          repository: "owner/repo",
          number: 7,
          headRefOid: HEAD,
          text: "\nline\u2028next",
        });
        channel.write({
          type: "state",
          actionId: "repair-1",
          repository: "owner/repo",
          number: 7,
          headRefOid: HEAD,
          state: "ready",
          updatedAt: "2026-07-21T06:00:00.000Z",
          commit: BASE,
          terminal: true,
        });
      }),
    };
    const running = await operationServer({ repairManager });
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/repairs/repair-1`,
      {
        headers: { Origin: running.origin, "X-Action-Token": token },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const raw = await response.text();
    const events = raw.trim().split("\n").map(JSON.parse);
    expect(events).toHaveLength(3);
    expect(events[0].output).toBe('<script>\n{"raw":true}');
    expect(events[1].text).toBe("\nline\u2028next");
    expect(events.at(-1)).toMatchObject({ state: "ready", terminal: true });
    expect(raw).not.toContain(token);
    await running.close();
  });

  it("authenticates exact repair cancellation and returns only its terminal snapshot", async () => {
    const token = "R".repeat(43);
    const running = await operationServer();
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/repairs/repair-1`,
      {
        headers: { Origin: running.origin, "X-Action-Token": token },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actionId: "repair-1",
      state: "cancelled",
      terminal: true,
    });
    expect(running.repairManager.cancelObserved).toHaveBeenCalledWith({
      id: "repair-1",
      number: 7,
      repository: "owner/repo",
      token,
    });
    await running.close();
  });

  it("fails repair observation closed for missing, invalid, or foreign action credentials", async () => {
    const repairManager = {
      cancelObserved: vi.fn(),
      watch: vi.fn(async ({ token }) => {
        if (token !== "R".repeat(43)) {
          throw new ActionError(
            404,
            "repair_not_found",
            "The conflict repair action was not found.",
          );
        }
      }),
    };
    const running = await operationServer({ repairManager });
    const path = `${running.origin}/api/pulls/owner/repo/7/repairs/repair-1`;
    expect((await fetch(path)).status).toBe(403);
    const invalid = await fetch(path, {
      headers: { Origin: running.origin, "X-Action-Token": "bad" },
    });
    expect(invalid.status).toBe(404);
    await expect(invalid.json()).resolves.toEqual({
      code: "repair_not_found",
      error: "The conflict repair action was not found.",
    });
    await running.close();
  });

  it("returns a repair token only from an authorized merge acceptance response", async () => {
    const token = "R".repeat(43);
    const mergeService = {
      merge: vi.fn(async () => ({
        action: {
          agent: "claude",
          deduplicated: false,
          id: "repair-1",
          state: "repair_queued",
          token,
          type: "repair_queued",
        },
        headRefOid: HEAD,
        merged: false,
        number: 7,
        repository: "owner/repo",
        url: "https://github.com/owner/repo/pull/7",
      })),
    };
    const running = await operationServer({ mergeService });
    const path = `${running.origin}/api/pulls/owner/repo/7/merge`;
    const unauthorized = await fetch(path, {
      body: JSON.stringify({
        agent: "claude",
        expectedHeadRefOid: HEAD,
      }),
      headers: { "Content-Type": "application/json", Origin: running.origin },
      method: "POST",
    });
    expect(unauthorized.status).toBe(403);
    expect(mergeService.merge).not.toHaveBeenCalled();

    const accepted = await fetch(path, {
      body: JSON.stringify({
        agent: "claude",
        expectedHeadRefOid: HEAD,
      }),
      headers: actionHeaders(running.origin),
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      action: { id: "repair-1", token },
      merged: false,
    });
    expect(mergeService.merge).toHaveBeenCalledOnce();
    await running.close();
  });

  it("streams and cancels release verification through the dedicated manager", async () => {
    const running = await operationServer();
    const body = {
      agent: "claude",
      headSha: HEAD,
      pullNumber: 7,
      pullUrl: "https://github.com/owner/repo/pull/7",
      releaseId: "release-1",
      repository: "owner/repo",
      tag: "v1.2.4",
    };
    const response = await fetch(`${running.origin}/api/verifications`, {
      body: JSON.stringify(body),
      headers: actionHeaders(running.origin),
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.text()).trim().split("\n").map(JSON.parse)).toEqual([
      { type: "start", runId: "verify-1", ...body },
      { type: "complete", exitCode: 0 },
    ]);
    const cancelled = await fetch(
      `${running.origin}/api/verifications/verify-1`,
      {
        headers: {
          Origin: running.origin,
          "X-Action-Token": "process-token",
        },
        method: "DELETE",
      },
    );
    expect(cancelled.status).toBe(204);
    expect(running.verificationManager.cancel).toHaveBeenCalledWith("verify-1");
    await running.close();
  });

  it("streams and cancels a server-owned whole-release verification batch", async () => {
    const running = await operationServer();
    const body = {
      agent: "claude",
      releaseId: "10",
      repository: "owner/repo",
      tag: "v1.2.4",
    };
    const response = await fetch(
      `${running.origin}/api/releases/verifications`,
      {
        body: JSON.stringify(body),
        headers: actionHeaders(running.origin),
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect((await response.text()).trim().split("\n").map(JSON.parse)).toEqual([
      { type: "batch-start", batchId: "batch-1", pulls: [], ...body },
      {
        type: "complete",
        batchId: "batch-1",
        totals: { complete: 0, error: 0, existing: 0, total: 0 },
      },
    ]);
    expect(running.releaseVerificationManager.start).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ write: expect.any(Function) }),
    );
    const cancelled = await fetch(
      `${running.origin}/api/releases/verifications/batch-1`,
      {
        headers: { Origin: running.origin, "X-Action-Token": "process-token" },
        method: "DELETE",
      },
    );
    expect(cancelled.status).toBe(204);
    expect(running.releaseVerificationManager.cancel).toHaveBeenCalledWith(
      "batch-1",
    );
    await running.close();
  });

  it.each([
    [`/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`, "POST", "GET"],
    [
      `/api/pulls/owner/repo/7/commits?base=${BASE}&head=${HEAD}`,
      "POST",
      "GET",
    ],
    [
      `/api/pulls/owner/repo/7/commits/${HEAD}?base=${BASE}&head=${HEAD}`,
      "POST",
      "GET",
    ],
    ["/api/pulls/owner/repo/7/merge", "GET", "POST"],
    ["/api/releases/options", "POST", "GET"],
    ["/api/releases/pipelines", "POST", "GET"],
    ["/api/releases/recent", "POST", "GET"],
    ["/api/releases", "GET", "POST"],
    ["/api/releases/verifications", "GET", "POST"],
    ["/api/releases/verifications/batch-1", "POST", "DELETE"],
    ["/api/verifications", "GET", "POST"],
    ["/api/verifications/verify-1", "POST", "DELETE"],
  ])(
    "returns a route-specific Allow header for %s",
    async (path, method, allow) => {
      const running = await operationServer();
      const response = await fetch(`${running.origin}${path}`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      await running.close();
    },
  );

  it("rejects malformed paths, queries, and exact-body contract violations", async () => {
    const running = await operationServer();
    const invalidDiffs = [
      "/api/pulls/owner/repo/7/diff",
      `/api/pulls/owner/repo/7/diff?head=${HEAD}`,
      `/api/pulls/owner/repo/7/diff?base=${BASE}`,
      `/api/pulls/owner/repo/7/diff?base=invalid&head=${HEAD}`,
      `/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}&extra=1`,
      `/api/pulls/owner/repo/7/diff?base=${BASE}&base=${BASE}&head=${HEAD}`,
      `/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}&head=${HEAD}`,
    ];
    for (const path of invalidDiffs) {
      expect((await fetch(`${running.origin}${path}`)).status).toBe(400);
    }
    expect(
      (
        await fetch(
          `${running.origin}/api/pulls/owner%2Frepo/name/7/diff?base=${BASE}&head=${HEAD}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${running.origin}/api/pulls/owner/repo/07/diff?base=${BASE}&head=${HEAD}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${running.origin}/api/releases/recent?refresh=0`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${running.origin}/api/releases/pipelines?refresh=0`))
        .status,
    ).toBe(400);
    expect(
      (await fetch(`${running.origin}/api/releases/pipelines?discover=0`))
        .status,
    ).toBe(400);
    const merge = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/merge`,
      {
        body: JSON.stringify({
          expectedHeadRefOid: HEAD,
          repository: "other/repo",
        }),
        headers: actionHeaders(running.origin),
        method: "POST",
      },
    );
    expect(merge.status).toBe(400);
    const comment = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/comments?retry=1`,
      {
        body: JSON.stringify({
          body: "Comment body",
          expectedBaseRefOid: BASE,
          expectedHeadRefOid: HEAD,
          extra: true,
          line: 4,
          path: "src/example.ts",
          side: "RIGHT",
        }),
        headers: actionHeaders(running.origin),
        method: "POST",
      },
    );
    expect(comment.status).toBe(404);
    expect(running.diffService.load).not.toHaveBeenCalled();
    expect(running.mergeService.merge).not.toHaveBeenCalled();
    expect(running.reviewCommentService.create).not.toHaveBeenCalled();
    await running.close();
  });

  it("requires JSON and authorization before any mutation or verification starts", async () => {
    const running = await operationServer();
    const releaseBody = JSON.stringify({
      expectedLatestTag: "v1.2.3",
      prerelease: false,
      preview: releasePreview(),
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    const unauthorized = await fetch(`${running.origin}/api/releases`, {
      body: releaseBody,
      headers: { "Content-Type": "application/json", Origin: running.origin },
      method: "POST",
    });
    expect(unauthorized.status).toBe(403);
    const media = await fetch(`${running.origin}/api/releases`, {
      body: releaseBody,
      headers: actionHeaders(running.origin, "text/plain"),
      method: "POST",
    });
    expect(media.status).toBe(415);
    expect(running.releaseService.create).not.toHaveBeenCalled();
    await running.close();

    const disabled = await operationServer({}, false);
    const blocked = await fetch(
      `${disabled.origin}/api/pulls/owner/repo/7/merge`,
      {
        body: JSON.stringify({
          agent: "claude",
          expectedHeadRefOid: HEAD,
        }),
        headers: actionHeaders(disabled.origin),
        method: "POST",
      },
    );
    expect(blocked.status).toBe(403);
    expect(disabled.mergeService.merge).not.toHaveBeenCalled();
    await disabled.close();
  });

  it("preserves safe action errors and redacts unexpected service failures", async () => {
    const mergeService = {
      merge: vi.fn(async () => {
        throw new ActionError(
          409,
          "head_changed",
          "The pull request head changed.",
        );
      }),
    };
    const running = await operationServer({ mergeService });
    const action = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/merge`,
      {
        body: JSON.stringify({
          agent: "claude",
          expectedHeadRefOid: HEAD,
        }),
        headers: actionHeaders(running.origin),
        method: "POST",
      },
    );
    expect(action.status).toBe(409);
    await expect(action.json()).resolves.toEqual({
      code: "head_changed",
      error: "The pull request head changed.",
    });
    await running.close();

    const failed = await operationServer({
      diffService: {
        load: vi.fn(async () => {
          throw new Error("token=ghp_super_secret /Users/private");
        }),
      },
    });
    const response = await fetch(
      `${failed.origin}/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`,
    );
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("ghp_super_secret");
    expect(text).not.toContain("/Users/private");
    await failed.close();
  });

  it("maps a stale diff head without weakening the service status or code", async () => {
    const running = await operationServer({
      diffService: {
        load: vi.fn(async () => {
          throw new DiffError("stale");
        }),
      },
    });
    const response = await fetch(
      `${running.origin}/api/pulls/owner/repo/7/diff?base=${BASE}&head=${HEAD}`,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "stale_head",
    });
    await running.close();
  });
});

describe("production static serving", () => {
  it("serves assets and uses the SPA fallback for navigation", async () => {
    const dist = await directory();
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "index.html"), "<main>app shell</main>");
    await writeFile(join(dist, "assets", "app.js"), "window.ready = true");
    const running = await listen(createStaticHandler({ distPath: dist }));

    const asset = await fetch(`${running.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await asset.text()).toBe("window.ready = true");

    const navigation = await fetch(`${running.origin}/pulls/ready`);
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await navigation.text()).toContain("app shell");
    await running.close();
  });

  it("does not use the SPA fallback for missing assets", async () => {
    const dist = await directory();
    await writeFile(join(dist, "index.html"), "<main>app shell</main>");
    const running = await listen(createStaticHandler({ distPath: dist }));

    expect((await fetch(`${running.origin}/assets/missing.js`)).status).toBe(
      404,
    );
    expect((await fetch(`${running.origin}/missing.css`)).status).toBe(404);
    await running.close();
  });

  it("rejects traversal and symlinks outside dist", async () => {
    const root = await directory();
    const dist = join(root, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "index.html"), "<main>safe</main>");
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(dist, "leak.txt"));
    const running = await listen(createStaticHandler({ distPath: dist }));

    expect(await rawStatus(running.origin, "/%2e%2e/secret.txt")).toBe(400);
    expect((await fetch(`${running.origin}/leak.txt`)).status).toBe(404);
    await running.close();
  });

  it("fails clearly when the production build is missing", async () => {
    const dist = await directory();
    await expect(assertProductionBuild(dist)).rejects.toThrow(
      "Run pnpm build before pnpm start",
    );
  });
});

describe("server startup", () => {
  it("defaults to loopback and requires explicit external opt-in", () => {
    expect(resolveServerOptions({})).toEqual({ host: "127.0.0.1", port: 5173 });
    expect(() => resolveServerOptions({ HOST: "0.0.0.0" })).toThrow(
      "ALLOW_EXTERNAL=1",
    );
    expect(
      resolveServerOptions({
        HOST: "0.0.0.0",
        ALLOW_EXTERNAL: "1",
        PORT: "8080",
      }),
    ).toEqual({ host: "0.0.0.0", port: 8080 });
  });

  it("runs the API and Vite middleware in one development server", async () => {
    const port = await freePort();
    const closeVite = vi.fn(async () => undefined);
    const createVite = vi.fn(async () => ({
      middlewares: (_request, response) => response.end("vite client"),
      close: closeVite,
    }));
    const running = await start({
      mode: "development",
      environment: { PORT: String(port) },
      createVite,
      graphql: emptyGraphql,
    });

    const client = await fetch(`http://127.0.0.1:${port}/`);
    expect(await client.text()).toBe("vite client");
    expect(client.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(client.headers.get("x-content-type-options")).toBe("nosniff");
    expect(client.headers.get("x-frame-options")).toBe("DENY");
    const api = await fetch(`http://127.0.0.1:${port}/api/pulls`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    expect(createVite.mock.calls[0][0]).toMatchObject({
      appType: "spa",
      server: { middlewareMode: { server: running.server } },
    });
    await running.close();
    expect(closeVite).toHaveBeenCalledOnce();
  });

  it("keeps one shared executor while reserving 50 MiB for GraphQL responses", async () => {
    const port = await freePort();
    const graphql = vi.fn(emptyGraphql);
    const executor = {
      action: vi.fn(),
      graphql,
      json: vi.fn(),
      output: vi.fn(),
      rest: vi.fn(),
    };
    const running = await start({
      mode: "development",
      environment: { PORT: String(port) },
      createVite: async () => ({
        middlewares: (_request, response) => response.end("client"),
        close: vi.fn(async () => undefined),
      }),
      executor,
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/pulls`);

    expect(response.status).toBe(200);
    expect(running.executor).toBe(executor);
    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[0][2]).toEqual({
      maxBuffer: GRAPHQL_MAX_BUFFER,
      signal: undefined,
    });
    await running.close();
  });

  it("shuts down active runs before closing the client server", async () => {
    const port = await freePort();
    const order = [];
    const manager = {
      start: vi.fn(),
      cancel: vi.fn(),
      shutdown: vi.fn(async () => {
        order.push("runs");
      }),
    };
    const running = await start({
      mode: "development",
      environment: { PORT: String(port) },
      createManager: () => manager,
      createVite: async () => ({
        middlewares: (_request, response) => response.end("client"),
        close: async () => {
          order.push("vite");
        },
      }),
      graphql: emptyGraphql,
    });

    await running.close();
    await running.close();
    expect(order).toEqual(["runs", "vite"]);
    expect(manager.shutdown).toHaveBeenCalledOnce();
  });

  it("shares one global coordinator and shuts down both Claude managers idempotently", async () => {
    const port = await freePort();
    const fix = {
      start: vi.fn(),
      cancel: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const verify = {
      start: vi.fn(),
      startQueued: vi.fn(),
      cancel: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const repair = {
      cancelObserved: vi.fn(),
      enqueue: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      watch: vi.fn(),
    };
    const task = {
      cancel: vi.fn(),
      close: vi.fn(async () => undefined),
      list: vi.fn(() => []),
      options: vi.fn(),
      start: vi.fn(),
      subscribe: vi.fn(),
    };
    const authorizer = {
      authorizeFailedCheck: vi.fn(),
      authorizePull: vi.fn(),
      authorizePullCommits: vi.fn(),
    };
    const checkLogsService = { load: vi.fn() };
    const diffService = { load: vi.fn(), loadAuthorized: vi.fn() };
    const memory = { load: vi.fn(), remember: vi.fn() };
    const createMemory = vi.fn(() => memory);
    const createAuthorization = vi.fn(() => authorizer);
    const createCheckLogs = vi.fn(() => checkLogsService);
    const createDiff = vi.fn(() => diffService);
    let fixCoordinator;
    let fixOptions;
    let repairCoordinator;
    let taskCoordinator;
    let verifyCoordinator;
    const running = await start({
      mode: "development",
      environment: { PORT: String(port) },
      createAuthorization,
      createCheckLogs,
      createDiff,
      createMemory,
      executor: {
        action: vi.fn(),
        json: vi.fn(),
        output: vi.fn(),
        rest: vi.fn(),
      },
      loader: {
        loadAuthoredPulls: vi.fn(async () => ({
          partial: false,
          pulls: [],
          viewerLogin: "viewer",
          warnings: [],
        })),
        loadCheckAuthorization: vi.fn(),
        loadPull: vi.fn(),
        loadPullAuthorization: vi.fn(),
        loadPullCommitsAuthorization: vi.fn(),
      },
      createManager: (options) => {
        fixCoordinator = options.coordinator;
        fixOptions = options;
        return fix;
      },
      createTask: ({ environment, scheduler }) => {
        expect(environment).toEqual({ PORT: String(port) });
        taskCoordinator = scheduler;
        return task;
      },
      createRepair: ({ coordinator }) => {
        repairCoordinator = coordinator;
        return repair;
      },
      createVerifier: ({ coordinator, memory: configuredMemory }) => {
        verifyCoordinator = coordinator;
        expect(configuredMemory).toBe(memory);
        return verify;
      },
      verificationMemoryRoot: "/tmp/puller-test-verification-memory",
      verificationWorkspace: { prepare: vi.fn() },
      workspaceResolver: { resolve: vi.fn(), clear: vi.fn() },
      createVite: async () => ({
        middlewares: (_request, response) => response.end("client"),
        close: vi.fn(async () => undefined),
      }),
    });

    expect(fixCoordinator).toBe(verifyCoordinator);
    expect(repairCoordinator).toBe(fixCoordinator);
    expect(taskCoordinator).toBe(fixCoordinator);
    expect(running.coordinator).toBe(fixCoordinator);
    expect(running.repairManager).toBe(repair);
    expect(running.taskManager).toBe(task);
    expect(createAuthorization).toHaveBeenCalledWith({
      loadCheckAuthorization: running.loader.loadCheckAuthorization,
      loadPullAuthorization: running.loader.loadPullAuthorization,
      loadPullCommitsAuthorization: running.loader.loadPullCommitsAuthorization,
      peek: running.cache.peek,
    });
    expect(createCheckLogs).toHaveBeenCalledWith({
      authorizer,
      executor: running.executor,
    });
    expect(createDiff).toHaveBeenCalledWith({
      authorizer,
      executor: running.executor,
    });
    expect(createMemory).toHaveBeenCalledWith({
      root: "/tmp/puller-test-verification-memory",
    });
    expect(fixOptions.diffService).toBe(diffService);
    expect(fixOptions.loadReviewAuthorization).toBe(
      running.loader.loadPullAuthorization,
    );
    expect(fixOptions.refreshReadiness).toEqual(expect.any(Function));
    expect(running.authorizer).toBe(authorizer);
    expect(running.checkLogsService).toBe(checkLogsService);
    expect(running.diffService).toBe(diffService);
    expect(running.verificationMemory).toBe(memory);
    await running.close();
    await running.close();
    expect(fix.shutdown).toHaveBeenCalledOnce();
    expect(repair.shutdown).toHaveBeenCalledOnce();
    expect(task.close).toHaveBeenCalledOnce();
    expect(verify.shutdown).toHaveBeenCalledOnce();
    expect(() =>
      running.coordinator.reserveRun({
        key: "after-close",
        duplicateCode: "duplicate",
        duplicateMessage: "duplicate",
      }),
    ).toThrow("shutting down");
  });

  it("cleans up an initialized Fix manager when verification setup fails", async () => {
    const fix = {
      start: vi.fn(),
      cancel: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    await expect(
      start({
        mode: "development",
        environment: { PORT: String(await freePort()) },
        executor: {
          action: vi.fn(),
          json: vi.fn(),
          output: vi.fn(),
          rest: vi.fn(),
        },
        loader: {
          loadAuthoredPulls: vi.fn(),
          loadCheckAuthorization: vi.fn(),
          loadPull: vi.fn(),
          loadPullAuthorization: vi.fn(),
        },
        createManager: () => fix,
        createVerifier: () => {
          throw new Error("verification setup failed");
        },
        verificationWorkspace: { prepare: vi.fn() },
        workspaceResolver: { resolve: vi.fn(), clear: vi.fn() },
        createVite: vi.fn(),
      }),
    ).rejects.toThrow("verification setup failed");
    expect(fix.shutdown).toHaveBeenCalledOnce();
  });

  it("does not turn a successful merge into a failure when snapshot refetch fails", async () => {
    const port = await freePort();
    const action = vi.fn(async () => undefined);
    const loadAuthoredPulls = vi.fn(async () => {
      throw new Error("temporary refresh failure");
    });
    const running = await start({
      mode: "development",
      environment: { PORT: String(port) },
      executor: { action, json: vi.fn(), output: vi.fn(), rest: vi.fn() },
      loader: {
        loadAuthoredPulls,
        loadCheckAuthorization: vi.fn(),
        loadPull: vi.fn(async () => freshReadyPull()),
        loadPullAuthorization: vi.fn(),
      },
      createVite: async () => ({
        middlewares: (_request, response) => response.end("client"),
        close: vi.fn(async () => undefined),
      }),
    });

    await expect(
      running.mergeService.merge({
        agent: "claude",
        expectedHeadRefOid: HEAD,
        number: 7,
        repository: "owner/repo",
      }),
    ).resolves.toMatchObject({
      merged: true,
      number: 7,
      repository: "owner/repo",
    });
    expect(action).toHaveBeenCalledOnce();
    expect(loadAuthoredPulls).toHaveBeenCalledOnce();
    await running.close();
  });

  it("closes Vite and the failed server when the development port is occupied", async () => {
    const occupied = createServer((_request, response) =>
      response.end("occupied"),
    );
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    const closeVite = vi.fn(async () => undefined);
    let attemptedServer;
    const createVite = vi.fn(async (config) => {
      attemptedServer = config.server.middlewareMode.server;
      return {
        middlewares: (_request, response) => response.end("vite client"),
        close: closeVite,
      };
    });

    try {
      await expect(
        start({
          mode: "development",
          environment: { PORT: String(address.port) },
          createVite,
          graphql: emptyGraphql,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closeVite).toHaveBeenCalledOnce();
      expect(attemptedServer.listening).toBe(false);
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  });

  it("runs the API, built client, and SPA fallback in production", async () => {
    const dist = await directory();
    await writeFile(join(dist, "index.html"), "<main>production</main>");
    const port = await freePort();
    const running = await start({
      mode: "production",
      environment: { PORT: String(port) },
      distPath: dist,
      graphql: emptyGraphql,
    });

    const client = await fetch(`http://127.0.0.1:${port}/route`);
    expect(await client.text()).toContain("production");
    expect(client.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(client.headers.get("x-frame-options")).toBe("DENY");
    const api = await fetch(`http://127.0.0.1:${port}/api/pulls`);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(api.headers.get("x-frame-options")).toBe("DENY");
    await running.close();
  });
});
