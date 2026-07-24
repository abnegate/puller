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
  "Review verification failed after the agent exited successfully. Its push may have succeeded. Refresh the pull request before retrying.";

function input(overrides = {}) {
  return {
    agent: "claude",
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
  const spawn = overrides.spawn ?? vi.fn(() => process);
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
    cleanup: vi.fn(async () => undefined),
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
    ...(overrides.reviewCleanupTimeout === undefined
      ? {}
      : { reviewCleanupTimeout: overrides.reviewCleanupTimeout }),
    ...(overrides.reportDiagnostic === undefined
      ? {}
      : { reportDiagnostic: overrides.reportDiagnostic }),
    ...(overrides.prepareCodex === undefined
      ? {}
      : { prepareCodex: overrides.prepareCodex }),
    ...(overrides.git === undefined ? {} : { git: overrides.git }),
    ...(overrides.runtime === undefined ? {} : { runtime: overrides.runtime }),
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
    workspace,
  };
}

describe("review Claude runs", () => {
  it("lets Codex edit while Puller commits and normally pushes the review fix", async () => {
    const process = child();
    process.stdin = new PassThrough();
    vi.spyOn(process.stdin, "end");
    const cleanup = vi.fn(async () => undefined);
    const prepareCodex = vi.fn(async () => ({
      args: ["exec", "--json", "-"],
      cleanup,
      command: "/opt/homebrew/bin/codex",
      cwd: "/protected/control",
      environment: {},
      prompt: "trusted review prompt",
    }));
    let statuses = 0;
    const git = vi.fn(async (_command, arguments_) => {
      if (arguments_.includes("rev-parse")) {
        return { stderr: "", stdout: `${HEAD}\n` };
      }
      if (arguments_.includes("status")) {
        statuses += 1;
        return {
          stderr: "",
          stdout: statuses === 1 ? " M src/example.js\n" : "",
        };
      }
      return { stderr: "", stdout: "" };
    });
    const running = fixture({ child: process, git, prepareCodex });
    const output = stream();
    const started = await running.manager.start(
      input({ agent: "codex" }),
      output.value,
    );

    expect(prepareCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "review",
        target: "/trusted/workspace",
      }),
    );
    expect(process.stdin.end).toHaveBeenCalledWith("trusted review prompt");
    process.stdout.write(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}\n',
    );
    process.stdout.write('{"type":"turn.completed"}\n');
    process.emit("close", 0, null);
    await started.done;

    expect(output.events.at(-1)).toEqual({ type: "complete", exitCode: 0 });
    expect(
      git.mock.calls.some(
        ([, arguments_]) =>
          arguments_.includes("push") &&
          arguments_.includes("HEAD:refs/heads/fix/review"),
      ),
    ).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

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
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_SSH_COMMAND:
        "ssh -oBatchMode=yes -oConnectTimeout=15 -oStrictHostKeyChecking=yes",
      GIT_TERMINAL_PROMPT: "0",
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
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
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
    const cleanup = vi.fn(async () => undefined);
    const resolver = {
      clear: vi.fn(),
      resolve: vi.fn(),
      resolveReview: vi.fn(async () => ({
        branch: "fix/review",
        cleanup,
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
    expect(cleanup).toHaveBeenCalledOnce();
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
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("cleans a provisioned workspace when final preflight authorization fails and allows an immediate retry", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const loadReviewAuthorization = vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof(HEAD, { headRefName: "other/branch" }))
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof(NEXT));
    const running = fixture({ coordinator, loadReviewAuthorization });

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({ code: "review_identity_changed" });
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(coordinator.activeCount()).toBe(0);

    const retry = await running.manager.start(input(), stream().value);
    running.process.emit("close", 0, null);
    await retry.done;
    expect(running.spawn).toHaveBeenCalledOnce();
    expect(running.workspace.cleanup).toHaveBeenCalledTimes(2);
    expect(coordinator.activeCount()).toBe(0);
  });

  it("cleans a provisioned workspace when process startup throws", async () => {
    const spawn = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const running = fixture({ spawn });

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toThrow("spawn failed");
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(running.manager.activeCount()).toBe(0);
    expect(running.manager.activeWorkspaceCount()).toBe(0);
  });

  it("surfaces a path-redacted cleanup rejection after preflight and releases every reservation", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const spawn = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const running = fixture({ coordinator, spawn });
    running.workspace.cleanup.mockRejectedValueOnce(
      new Error("rm /private/tmp/puller-review-secret failed"),
    );

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({
      code: "review_workspace_cleanup_failed",
      message: expect.not.stringContaining("/private/tmp"),
    });
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(running.manager.activeCount()).toBe(0);
    expect(running.manager.activeWorkspaceCount()).toBe(0);
    expect(coordinator.activeCount()).toBe(0);
    expect(coordinator.activeWorkspaceCount()).toBe(0);
  });

  it("reports terminal cleanup rejection instead of treating the review run as successful", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const running = fixture({ coordinator });
    running.workspace.cleanup.mockRejectedValueOnce(
      new Error("rm /private/tmp/puller-review-secret failed"),
    );
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);

    running.process.emit("close", 0, null);
    await started.done;

    expect(channel.events.at(-1)).toEqual({
      message:
        "The agent finished, but Puller could not remove its isolated review workspace. Its push may have succeeded. The run reservation was released.",
      type: "error",
    });
    expect(channel.events).not.toContainEqual({
      type: "complete",
      exitCode: 0,
    });
    expect(coordinator.activeCount()).toBe(0);
  });

  it("bounds terminal cleanup when the filesystem operation never settles", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = createRunCoordinator({ limit: 1 });
      const running = fixture({
        coordinator,
        reviewCleanupTimeout: 10,
      });
      running.workspace.cleanup.mockImplementationOnce(
        () => new Promise(() => undefined),
      );
      const channel = stream();
      const started = await running.manager.start(input(), channel.value);

      running.process.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(10);
      await started.done;

      expect(channel.events.at(-1)).toMatchObject({
        message: expect.stringContaining(
          "could not remove its isolated review workspace",
        ),
        type: "error",
      });
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for review verification before cleaning a terminal workspace", async () => {
    let releaseVerification;
    const verification = new Promise((resolve) => {
      releaseVerification = resolve;
    });
    const running = fixture({
      resolver: {
        clear: vi.fn(),
        resolve: vi.fn(),
        resolveReview: vi.fn(async () => ({
          branch: "fix/review",
          cleanup: vi.fn(async () => undefined),
          cwd: "/trusted/workspace",
          headRefOid: HEAD,
          remote: "origin",
          repository: "owner/repo",
        })),
        verifyReview: vi.fn(async () => {
          await verification;
          return { headRefOid: NEXT };
        }),
      },
    });
    const started = await running.manager.start(input(), stream().value);
    running.process.emit("close", 0, null);

    await vi.waitFor(() =>
      expect(running.resolver.verifyReview).toHaveBeenCalledOnce(),
    );
    const proof = await running.resolver.resolveReview.mock.results[0].value;
    expect(proof.cleanup).not.toHaveBeenCalled();
    releaseVerification();
    await started.done;
    expect(proof.cleanup).toHaveBeenCalledOnce();
  });

  it("cleans once when client cancellation and child termination race", async () => {
    const running = fixture();
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);

    channel.close();
    running.process.emit("error", new Error("child failed while closing"));
    running.process.emit("close", null, "SIGTERM");
    await started.done;

    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(running.manager.activeCount()).toBe(0);
  });

  it("cleans a provisioned workspace when final preflight authorization times out", async () => {
    const coordinator = createRunCoordinator({ limit: 1 });
    const loadReviewAuthorization = vi
      .fn()
      .mockResolvedValueOnce(proof())
      .mockResolvedValueOnce(proof())
      .mockImplementationOnce(() => new Promise(() => undefined));
    const running = fixture({
      coordinator,
      loadReviewAuthorization,
      reviewPreflightTimeout: 10,
    });

    await expect(
      running.manager.start(input(), stream().value),
    ).rejects.toMatchObject({ code: "review_preflight_timeout" });
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(running.spawn).not.toHaveBeenCalled();
    expect(coordinator.activeCount()).toBe(0);
  });

  it("cleans a review workspace after a nonzero child exit", async () => {
    const running = fixture();
    const channel = stream();
    const started = await running.manager.start(input(), channel.value);

    running.process.emit("close", 1, null);
    await started.done;

    expect(channel.events.at(-1)).toEqual({
      message: "Claude Code exited with an error.",
      type: "error",
    });
    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
  });

  it("cleans a review workspace after its runtime limit", async () => {
    vi.useFakeTimers();
    try {
      const running = fixture({ runtime: 10 });
      const channel = stream();
      const started = await running.manager.start(input(), channel.value);

      await vi.advanceTimersByTimeAsync(10);
      expect(channel.events.at(-1)).toEqual({
        message: "Claude Code exceeded the run time limit.",
        type: "limit",
      });
      running.process.emit("close", null, "SIGTERM");
      await started.done;
      expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans a review workspace during manager shutdown", async () => {
    const running = fixture();
    const started = await running.manager.start(input(), stream().value);

    const shutdown = running.manager.shutdown();
    running.process.emit("close", null, "SIGTERM");
    await shutdown;
    await started.done;

    expect(running.workspace.cleanup).toHaveBeenCalledOnce();
    expect(running.manager.activeCount()).toBe(0);
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
