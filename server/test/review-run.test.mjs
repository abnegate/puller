import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  claudeArguments,
  createClaudeRunManager,
  createRunCoordinator,
  reviewClaudeArguments,
  validateRunInput,
} from "../claude.mjs";

const BASE = "1234567890abcdef1234567890abcdef12345678";
const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const NEXT = "fedcba9876543210fedcba9876543210fedcba98";
const VERIFICATION_FAILURE =
  "Review verification failed after Claude Code exited successfully. Its push may have succeeded. Refresh the pull request before retrying.";

function input(overrides = {}) {
  return {
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    feedback: {
      body: "Handle the nil case.",
      line: 2,
      path: "src/example.js",
      side: "RIGHT",
    },
    message: "Handle the nil case.",
    number: 7,
    repository: "owner/repo",
    source: "review",
    ...overrides,
  };
}

function proof(headRefOid = HEAD, overrides = {}) {
  return {
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
    ...overrides,
  };
}

function loaded(overrides = {}) {
  const authorization = {
    authorLogin: "viewer",
    baseRefOid: BASE,
    headRefOid: HEAD,
    number: 7,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/7",
    viewerLogin: "viewer",
  };
  return {
    authorization,
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
                  newLine: 2,
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
    ...overrides,
  };
}

function child() {
  const value = new EventEmitter();
  value.pid = 123;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = vi.fn();
  return value;
}

function stream() {
  const events = [];
  let close;
  return {
    events,
    close: () => close?.(),
    value: {
      closed: () => false,
      onClose: (listener) => {
        close = listener;
        return () => {
          close = null;
        };
      },
      onceDrain: () => () => undefined,
      write: (event) => {
        events.push(event);
        return true;
      },
    },
  };
}

function fixture(overrides = {}) {
  const process = overrides.child ?? child();
  const spawn = vi.fn(() => process);
  const loadReviewAuthorization =
    overrides.loadReviewAuthorization ??
    vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof(NEXT));
  const diffService = overrides.diffService ?? {
    invalidate: vi.fn(),
    loadAuthorized: vi.fn(async () => loaded()),
  };
  const workspace = {
    branch: "fix/review",
    cwd: "/trusted/workspace",
    headRefOid: HEAD,
    remote: "origin",
    repository: "owner/repo",
  };
  const resolver = overrides.resolver ?? {
    clear: vi.fn(),
    resolve: vi.fn(),
    resolveReview: vi.fn(async () => workspace),
    verifyReview: vi.fn(async () => ({ ...workspace, headRefOid: NEXT })),
  };
  const refreshReadiness = overrides.refreshReadiness ?? vi.fn();
  const manager = createClaudeRunManager({
    cache: { get: vi.fn() },
    canonicalize: vi.fn(async (value) => value),
    createId: () => "review-run",
    createTemporary: vi.fn(async () => "/private/tmp/review-run"),
    diffService,
    environment: {
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      CUSTOM_SECRET: "custom-secret",
      DATABASE_URL: "mysql://secret@database/app",
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "github-token",
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    },
    loadPull: vi.fn(),
    loadReviewAuthorization,
    refreshReadiness,
    ...(overrides.coordinator === undefined
      ? {}
      : { coordinator: overrides.coordinator }),
    ...(overrides.reviewPreflightTimeout === undefined
      ? {}
      : { reviewPreflightTimeout: overrides.reviewPreflightTimeout }),
    removeTemporary: vi.fn(async () => undefined),
    resolver,
    spawn,
  });
  return {
    diffService,
    loadReviewAuthorization,
    manager,
    process,
    refreshReadiness,
    resolver,
    spawn,
  };
}

describe("review Claude runs", () => {
  it("uses dangerous permissions only for review runs", () => {
    const review = reviewClaudeArguments("prompt");
    const fix = claudeArguments(
      "prompt",
      "/trusted/workspace",
      "/private/tmp/run",
      {},
    );
    expect(review).toContain("--dangerously-skip-permissions");
    expect(fix).not.toContain("--dangerously-skip-permissions");
    expect(fix).toContain("--safe-mode");
    for (const arguments_ of [review, fix]) {
      expect(arguments_.slice(0, 5)).toEqual([
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
      ]);
      expect(
        arguments_.filter((argument) => argument === "--verbose"),
      ).toHaveLength(1);
      expect(arguments_.indexOf("--verbose")).toBeLessThan(
        arguments_.indexOf("--"),
      );
    }
  });

  it("accepts the exact source review contract", () => {
    expect(validateRunInput(input())).toMatchObject(input());
  });

  it("accepts a ready PR, proves the anchor, and completes only after exact push verification", async () => {
    const running = fixture();
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);

    expect(running.spawn).toHaveBeenCalledOnce();
    const [executable, args, options] = running.spawn.mock.calls[0];
    expect(executable).toBe("claude");
    expect(args.slice(0, 5)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    expect(args.filter((argument) => argument === "--verbose")).toHaveLength(1);
    expect(args.indexOf("--verbose")).toBeLessThan(args.indexOf("--"));
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.at(-1)).toContain("Handle the nil case.");
    expect(args.at(-1)).toContain("normal non-force push");
    expect(options.env).toEqual({
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      ENABLE_TOOL_SEARCH: "false",
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      TEMP: "/private/tmp/review-run",
      TMP: "/private/tmp/review-run",
      TMPDIR: "/private/tmp/review-run",
    });

    running.process.emit("close", 0, null);
    await started.done;

    expect(running.resolver.verifyReview).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix/review" }),
      {
        expectedHeadRefOid: HEAD,
        signal: expect.any(AbortSignal),
      },
    );
    expect(running.loadReviewAuthorization).toHaveBeenCalledTimes(4);
    expect(running.diffService.invalidate).toHaveBeenCalledWith({
      number: 7,
      repository: "owner/repo",
    });
    expect(running.refreshReadiness).toHaveBeenCalledOnce();
    expect(channel.events.at(-1)).toEqual({ type: "complete", exitCode: 0 });
  });

  it("rejects stale or truncated anchors before spawning Claude", async () => {
    const stale = fixture({
      diffService: {
        invalidate: vi.fn(),
        loadAuthorized: vi.fn(async () =>
          loaded({
            diff: {
              ...loaded().diff,
              files: [{ ...loaded().diff.files[0], truncated: true }],
            },
          }),
        ),
      },
    });
    await expect(
      stale.manager.start(input(), stream().value),
    ).rejects.toMatchObject({ code: "review_anchor_unavailable" });
    expect(stale.spawn).not.toHaveBeenCalled();
  });

  it("warns that a push may have succeeded when local post-push proof fails", async () => {
    const resolver = {
      clear: vi.fn(),
      resolve: vi.fn(),
      resolveReview: vi.fn(async () => ({
        branch: "fix/review",
        cwd: "/trusted/workspace",
        headRefOid: HEAD,
        remote: "origin",
        repository: "owner/repo",
      })),
      verifyReview: vi.fn(async () => {
        throw Object.assign(new Error("not descendant"), {
          code: "review_commit_not_descendant",
          status: 409,
        });
      }),
    };
    const running = fixture({ resolver });
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);
    running.process.emit("close", 0, null);
    await started.done;

    expect(
      channel.events.filter(({ type }) =>
        ["complete", "error", "cancelled", "limit"].includes(type),
      ),
    ).toEqual([{ message: VERIFICATION_FAILURE, type: "error" }]);
    expect(running.loadReviewAuthorization).toHaveBeenCalledTimes(3);
    expect(running.refreshReadiness).not.toHaveBeenCalled();
  });

  it("warns that a push may have succeeded when GitHub post-push proof fails", async () => {
    const loadReviewAuthorization = vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockRejectedValueOnce(new Error("GitHub unavailable"));
    const running = fixture({ loadReviewAuthorization });
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);
    running.process.emit("close", 0, null);
    await started.done;

    expect(running.resolver.verifyReview).toHaveBeenCalledOnce();
    expect(loadReviewAuthorization).toHaveBeenCalledTimes(4);
    expect(
      channel.events.filter(({ type }) =>
        ["complete", "error", "cancelled", "limit"].includes(type),
      ),
    ).toEqual([{ message: VERIFICATION_FAILURE, type: "error" }]);
    expect(running.refreshReadiness).not.toHaveBeenCalled();
  });

  it("aborts pending authorization immediately when the client closes", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    let signal;
    const loadReviewAuthorization = vi.fn((_input, value) => {
      signal = value;
      return new Promise(() => undefined);
    });
    const running = fixture({ coordinator, loadReviewAuthorization });
    const channel = stream();
    const starting = running.manager.start(input(), channel.value);
    await vi.waitFor(() =>
      expect(loadReviewAuthorization).toHaveBeenCalledOnce(),
    );

    channel.close();
    await expect(starting).rejects.toMatchObject({
      code: "client_closed",
      status: 499,
    });
    expect(signal.aborted).toBe(true);
    expect(running.manager.activeCount()).toBe(0);
    expect(running.manager.activeWorkspaceCount()).toBe(0);
    expect(coordinator.activeCount()).toBe(0);
    expect(coordinator.activeWorkspaceCount()).toBe(0);
    expect(running.spawn).not.toHaveBeenCalled();
  });

  it("bounds the complete review preflight even when a dependency ignores abort", async () => {
    const running = fixture({
      loadReviewAuthorization: vi.fn(() => new Promise(() => undefined)),
      reviewPreflightTimeout: 10,
    });
    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({
      code: "review_preflight_timeout",
      status: 504,
    });
    expect(running.manager.activeCount()).toBe(0);
    expect(running.manager.activeWorkspaceCount()).toBe(0);
    expect(running.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["permission", { viewerPermission: "READ" }],
    [
      "fork repository",
      { headRepository: "contributor/repo", isCrossRepository: true },
    ],
    ["head repository", { headRepository: "other/repo" }],
    ["open state", { open: false, state: "CLOSED" }],
  ])("rejects %s drift after diff proof", async (_name, change) => {
    const loadReviewAuthorization = vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof(HEAD, change));
    const running = fixture({ loadReviewAuthorization });

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    expect(running.resolver.resolveReview).not.toHaveBeenCalled();
    expect(running.spawn).not.toHaveBeenCalled();
    expect(running.manager.activeCount()).toBe(0);
  });

  it("rechecks full branch identity after workspace push preflight", async () => {
    const loadReviewAuthorization = vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof(HEAD, { headRefName: "other/branch" }));
    const running = fixture({ loadReviewAuthorization });

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({ code: "review_identity_changed", status: 409 });
    expect(running.resolver.resolveReview).toHaveBeenCalledOnce();
    expect(running.spawn).not.toHaveBeenCalled();
    expect(running.manager.activeCount()).toBe(0);
    expect(running.manager.activeWorkspaceCount()).toBe(0);
  });
});
