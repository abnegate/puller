import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mergePull,
  resetApiActionTokenForTests,
} from "../../src/api";
import { createRequestListener } from "../http.mjs";
import { createMergeService } from "../merge.mjs";

const BASE = "1234567890abcdef1234567890abcdef12345678";
const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const NUMBER = 7;
const REPOSITORY = "owner/repo";
const TOKEN = "merge-client-e2e-token";
const originalFetch = globalThis.fetch;
const servers = [];

const pullUrl = `https://github.com/${REPOSITORY}/pull/${NUMBER}`;

function readyPull() {
  return {
    available: true,
    authored: true,
    complete: true,
    headRefOid: HEAD,
    number: NUMBER,
    open: true,
    pull: {
      comments: [
        {
          author: "greptile-apps",
          body: `Confidence Score: 5/5\nLast reviewed commit: ${HEAD}`,
          createdAt: "2026-07-21T00:00:00Z",
          updatedAt: "2026-07-21T00:00:00Z",
          url: `${pullUrl}#issuecomment-1`,
        },
      ],
      commentsComplete: true,
      headRefOid: HEAD,
      number: NUMBER,
      repository: REPOSITORY,
      repositoryUrl: `https://github.com/${REPOSITORY}`,
      reviewThreads: [],
      threadsComplete: true,
      title: "Ready change",
      unresolvedThreads: [],
      updatedAt: "2026-07-21T00:00:00Z",
      url: pullUrl,
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
    },
    repository: REPOSITORY,
    repositoryUrl: `https://github.com/${REPOSITORY}`,
    state: "OPEN",
    url: pullUrl,
    viewerLogin: "viewer",
  };
}

function conflictingPull() {
  return {
    baseRefName: "main",
    baseRefOid: BASE,
    headRefName: "feature",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: REPOSITORY },
    headRepositoryOwner: { login: "owner" },
    isCrossRepository: false,
    maintainerCanModify: true,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    number: NUMBER,
    state: "OPEN",
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
    url: pullUrl,
  };
}

async function listen(mergeService) {
  let listener;
  const server = createServer((request, response) =>
    listener(request, response),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  listener = createRequestListener({
    actionToken: TOKEN,
    executionEnabled: true,
    fallback: (_request, response) => {
      response.statusCode = 404;
      response.end();
    },
    mergeService,
    trustedOrigin: origin,
  });
  const running = {
    close: () => new Promise((resolve) => server.close(resolve)),
    origin,
  };
  servers.push(running);
  return running;
}

function routeFetch(origin) {
  globalThis.fetch = (input, init = {}) => {
    const target =
      typeof input === "string" && input.startsWith("/")
        ? `${origin}${input}`
        : input;
    const headers = new Headers(init.headers);
    headers.set("Origin", origin);
    return originalFetch(target, { ...init, headers });
  };
}

afterEach(async () => {
  resetApiActionTokenForTests();
  globalThis.fetch = originalFetch;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("merge client and server contract", () => {
  it("parses a successful response from the real merge service and HTTP listener", async () => {
    const executor = {
      action: vi.fn(async () => undefined),
    };
    const server = await listen(
      createMergeService({
        executor,
        loadPull: async () => readyPull(),
      }),
    );
    routeFetch(server.origin);
    resetApiActionTokenForTests();

    await expect(
      mergePull({
        agent: "claude",
        expectedHeadRefOid: HEAD,
        number: NUMBER,
        repository: REPOSITORY,
      }),
    ).resolves.toEqual({
      mergeCommitOid: null,
      merged: true,
      number: NUMBER,
      repository: REPOSITORY,
      url: pullUrl,
    });
    expect(executor.action).toHaveBeenCalledOnce();
  });

  it("parses a conflict-repair action with nested agent identity", async () => {
    const repairManager = {
      enqueue: vi.fn(() => ({
        accepted: true,
        agent: "claude",
        deduplicated: false,
        id: "repair-1",
        state: "repair_queued",
        token: "A".repeat(43),
      })),
    };
    const server = await listen(
      createMergeService({
        executor: {
          action: vi.fn(async () => {
            throw new Error("merge conflict");
          }),
          json: vi.fn(async () => conflictingPull()),
        },
        loadPull: async () => readyPull(),
        repairManager,
      }),
    );
    routeFetch(server.origin);
    resetApiActionTokenForTests();

    await expect(
      mergePull({
        agent: "claude",
        expectedHeadRefOid: HEAD,
        number: NUMBER,
        repository: REPOSITORY,
      }),
    ).resolves.toEqual({
      action: {
        agent: "claude",
        deduplicated: false,
        id: "repair-1",
        state: "repair_queued",
        token: "A".repeat(43),
        type: "repair_queued",
      },
      headRefOid: HEAD,
      merged: false,
      number: NUMBER,
      repository: REPOSITORY,
      url: pullUrl,
    });
    expect(repairManager.enqueue).toHaveBeenCalledOnce();
  });
});
