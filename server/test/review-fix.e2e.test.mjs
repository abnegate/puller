// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { execFile as executeFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  access,
  appendFile,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeRunManager, createRunCoordinator } from "../claude.mjs";
import { createRequestListener } from "../http.mjs";
import { createWorkspaceResolver, WorkspaceError } from "../workspace.mjs";
import { removeTrackedFixtures } from "./fixtures.mjs";
import PullRow from "../../src/components/PullRow";
import { EMPTY_VIEWED_FILES } from "../../src/diffs";
import { resetActionTokenForTests } from "../../src/fixes";
import { PullRowContinuityProvider } from "../../src/row-continuity";
import {
  groupPulls,
  IDLE_RUN_STATE,
  isRunActive,
  usePullRuns,
} from "../../src/runs";
import { createMemoryRunTranscriptStore } from "../../src/run-transcripts";
import { createPullsResponse } from "../../src/test/fixtures";

const execFile = promisify(executeFile);
const BRANCH = "fix/review";
const REPOSITORY = "owner/repo";
const NUMBER = 7;
const TOKEN = "review-fix-e2e-token";
const RESOLVER_REVIEW_CLEANUP_TIMEOUT = 5_000;
const MANAGER_REVIEW_CLEANUP_TIMEOUT = 6_000;
const REVIEW_SETTLEMENT_TIMEOUT = 10_000;
const TWO_RUN_E2E_TIMEOUT = REVIEW_SETTLEMENT_TIMEOUT * 2 + 10_000;
const temporary = new Set();
const managers = [];
const openChildren = new Set();
const servers = [];
const originalFetch = globalThis.fetch;
let childPid = 12_345;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function git(cwd, ...arguments_) {
  return await execFile("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function gitHead(cwd, reference = "HEAD") {
  const result = await git(cwd, "rev-parse", reference);
  return result.stdout.trim().toLowerCase();
}

async function remoteHead(remote) {
  const result = await execFile(
    "git",
    ["--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`],
    { encoding: "utf8" },
  );
  return result.stdout.trim().toLowerCase();
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "puller-review-e2e-"));
  temporary.add(root);
  const repositories = join(root, "repositories");
  const source = join(repositories, "repo");
  const linked = join(repositories, "linked");
  const remote = join(root, "remote.git");
  const reviewRoot = join(root, "reviews");
  await mkdir(repositories, { recursive: true });
  await execFile("git", ["init", "--bare", remote]);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await git(source, "config", "user.email", "review@example.test");
  await git(source, "config", "user.name", "Review Fixture");
  await writeFile(join(source, "example.js"), "export const value = 1;\n");
  await git(source, "add", "example.js");
  await git(source, "commit", "-m", "base");
  const base = await gitHead(source);
  await git(source, "switch", "-c", BRANCH);
  await writeFile(join(source, "example.js"), "export const value = 2;\n");
  await git(source, "add", "example.js");
  await git(source, "commit", "-m", "pull request");
  const head = await gitHead(source);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main", BRANCH);
  await git(source, "switch", "main");
  await git(source, "worktree", "add", linked, BRANCH);
  await git(
    source,
    "remote",
    "set-url",
    "origin",
    `git@github.com:${REPOSITORY}.git`,
  );
  await writeFile(join(source, "example.js"), "dirty primary checkout\n");

  const commands = [];
  const run = async (file, arguments_, options) => {
    const original = [...arguments_];
    commands.push(original);
    const rewritten = [...arguments_];
    const fetch = rewritten.indexOf("fetch");
    const push = rewritten.indexOf("push");
    const shouldRewrite =
      fetch >= 0 || (push >= 0 && rewritten.includes("--dry-run"));
    if (shouldRewrite) {
      const origin = rewritten.indexOf("origin", Math.max(fetch, push) + 1);
      if (origin >= 0) rewritten[origin] = remote;
    }
    return await execFile(file, rewritten, options);
  };

  return {
    base,
    commands,
    head,
    linked,
    remote,
    repositories,
    reviewRoot,
    root,
    run,
    source,
  };
}

function authorization(base, head) {
  return {
    authored: true,
    authorLogin: "viewer",
    available: true,
    baseRefOid: base,
    complete: true,
    headRefName: BRANCH,
    headRefOid: head,
    headRepository: REPOSITORY,
    isCrossRepository: false,
    number: NUMBER,
    open: true,
    repository: REPOSITORY,
    state: "OPEN",
    url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
    viewerLogin: "viewer",
    viewerPermission: "WRITE",
  };
}

function diff(base, head) {
  return {
    baseRefOid: base,
    complete: true,
    files: [
      {
        additions: 1,
        binary: false,
        blobUrl: `https://github.com/${REPOSITORY}/blob/${head}/src/example.js`,
        changes: 2,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,1 +1,1 @@",
            lines: [
              {
                content: "export const value = 1;",
                kind: "deletion",
                newLine: null,
                oldLine: 1,
              },
              {
                content: "export const value = 2;",
                kind: "addition",
                newLine: 2,
                oldLine: null,
              },
            ],
            newLines: 1,
            newStart: 2,
            oldLines: 1,
            oldStart: 1,
          },
        ],
        path: "src/example.js",
        previousPath: null,
        rawUrl: `https://github.com/${REPOSITORY}/raw/${head}/src/example.js`,
        status: "modified",
        truncated: false,
      },
    ],
    headRefOid: head,
    number: NUMBER,
    repository: REPOSITORY,
    warning: null,
  };
}

function pull(base, head) {
  const ready = createPullsResponse().ready[0];
  return {
    ...ready,
    baseRefOid: base,
    headRefOid: head,
    number: NUMBER,
    repository: REPOSITORY,
    repositoryUrl: `https://github.com/${REPOSITORY}`,
    url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
  };
}

function child() {
  const process = new EventEmitter();
  childPid += 1;
  process.pid = childPid;
  process.closed = false;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn((signal = "SIGTERM") => {
    closeChild(process, null, signal);
    return true;
  });
  openChildren.add(process);
  return process;
}

function closeChild(process, code, signal) {
  if (process.closed) return;
  process.closed = true;
  if (!process.stdout.writableEnded) process.stdout.end();
  if (!process.stderr.writableEnded) process.stderr.end();
  openChildren.delete(process);
  process.emit("close", code, signal);
}

function terminateChild(pid, signal) {
  const process = [...openChildren].find(
    (candidate) => candidate.pid === Math.abs(pid),
  );
  if (!process) return;
  closeChild(process, null, signal);
}

function reviewChannel() {
  const events = [];
  let close;
  return {
    events,
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

function reviewRequest(repository) {
  return {
    agent: "claude",
    expectedBaseRefOid: repository.base,
    expectedHeadRefOid: repository.head,
    feedback: {
      body: "Keep this value synchronized.",
      line: 2,
      path: "src/example.js",
      side: "RIGHT",
    },
    message: "Keep this value synchronized.",
    number: NUMBER,
    repository: REPOSITORY,
    source: "review",
  };
}

function reviewDiffService(repository) {
  const loaded = diff(repository.base, repository.head);
  return {
    invalidate: vi.fn(),
    loadAuthorized: vi.fn(async () => ({
      authorization: {
        authorLogin: "viewer",
        baseRefOid: repository.base,
        headRefOid: repository.head,
        number: NUMBER,
        repository: REPOSITORY,
        url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
        viewerLogin: "viewer",
      },
      diff: loaded,
    })),
  };
}

function Harness({ pullRequest, transcriptStore }) {
  const runs = usePullRuns([pullRequest], undefined, {
    authoritative: true,
    transcriptStore,
  });
  const groups = groupPulls([pullRequest], runs.states);
  const run = runs.states.get(pullRequest.url) ?? IDLE_RUN_STATE;
  const variant = groups.progress.length
    ? "progress"
    : groups.ready.length
      ? "ready"
      : "blocked";
  const label =
    variant === "progress"
      ? "In progress"
      : variant === "ready"
        ? "Ready"
        : "Not ready";

  return React.createElement(
    PullRowContinuityProvider,
    null,
    React.createElement(
      "section",
      { "data-current-section": label },
      React.createElement("h2", null, label),
      React.createElement(
        "output",
        {
          "aria-label": `Active ${isRunActive(run) ? 1 : 0}`,
        },
        `Active ${isRunActive(run) ? 1 : 0}`,
      ),
      React.createElement(
        "ul",
        null,
        React.createElement(PullRow, {
          artifactEpoch: 1,
          cancelRun: runs.cancel,
          clearReviewRetry: runs.clearReviewRetry,
          loadTranscript: runs.loadTranscript,
          movement: null,
          onToggleViewed: () => undefined,
          pull: pullRequest,
          run,
          setRunMessage: runs.setMessage,
          startRun: runs.start,
          variant,
          viewerLogin: "viewer",
          viewedFiles: EMPTY_VIEWED_FILES,
        }),
      ),
    ),
  );
}

async function listen(options) {
  let listener;
  const server = createServer((request, response) =>
    listener(request, response),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  listener = createRequestListener({
    ...options,
    fallback: (_request, response) => {
      response.statusCode = 404;
      response.end();
    },
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

async function reviewLifecycleState(manager, coordinator, reviewRoot) {
  let reviewEntries;
  try {
    reviewEntries = await readdir(reviewRoot);
  } catch (error) {
    reviewEntries = [`<${error?.code ?? error?.message ?? "unavailable"}>`];
  }
  return {
    coordinatorRuns: coordinator.activeCount(),
    coordinatorWorkspaces: coordinator.activeWorkspaceCount(),
    managerRuns: manager.activeCount(),
    managerWorkspaces: manager.activeWorkspaceCount(),
    reviewEntries,
    section:
      document
        .querySelector("[data-current-section]")
        ?.getAttribute("data-current-section") ?? "<missing>",
    uiActive: document.querySelector("output")?.textContent ?? "<missing>",
  };
}

async function waitForReviewSettlement(manager, coordinator, reviewRoot) {
  let state = await reviewLifecycleState(manager, coordinator, reviewRoot);
  await waitFor(
    async () => {
      state = await reviewLifecycleState(manager, coordinator, reviewRoot);
      expect(state).toEqual({
        coordinatorRuns: 0,
        coordinatorWorkspaces: 0,
        managerRuns: 0,
        managerWorkspaces: 0,
        reviewEntries: [],
        section: "Ready",
        uiActive: "Active 0",
      });
    },
    {
      interval: 50,
      onTimeout: (error) =>
        new Error(
          `The review run did not settle after its ${MANAGER_REVIEW_CLEANUP_TIMEOUT}ms manager cleanup bound. Last lifecycle state: ${JSON.stringify(state)}\n${error.message}`,
        ),
      timeout: REVIEW_SETTLEMENT_TIMEOUT,
    },
  );
}

async function finishClaude(
  process,
  workspace,
  remote,
  {
    change = "export const fixed = true;\n",
    commit = "fix review feedback",
    output = "Implemented the requested review fix.",
  } = {},
) {
  process.stdout.write('{"type":"system","subtype":"init"}\n');
  process.stdout.write(
    `${JSON.stringify({
      event: {
        delta: { text: output, type: "text_delta" },
        type: "content_block_delta",
      },
      type: "stream_event",
    })}\n`,
  );
  await appendFile(join(workspace, "example.js"), change);
  await git(workspace, "add", "example.js");
  await git(workspace, "commit", "-m", commit);
  const next = await gitHead(workspace);
  await git(workspace, "push", remote, `HEAD:refs/heads/${BRANCH}`);
  await git(workspace, "update-ref", `refs/remotes/origin/${BRANCH}`, next);
  process.stdout.write(
    '{"type":"result","subtype":"success","is_error":false}\n',
  );
  closeChild(process, 0, null);
  return next;
}

afterEach(async () => {
  cleanup();
  resetActionTokenForTests();
  globalThis.fetch = originalFetch;
  const failures = [];
  const settle = async (label, operations) => {
    const results = await Promise.allSettled(operations);
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(
          new Error(`${label} did not settle.`, { cause: result.reason }),
        );
      }
    }
  };
  await settle(
    "Claude run manager shutdown",
    managers.splice(0).map((manager) => manager.shutdown()),
  );
  for (const process of [...openChildren]) {
    closeChild(process, null, "SIGTERM");
  }
  await settle(
    "HTTP server shutdown",
    servers.splice(0).map((server) => server.close()),
  );
  await settle("Temporary fixture cleanup", [removeTrackedFixtures(temporary)]);
  vi.restoreAllMocks();
  if (failures.length > 0) {
    throw new AggregateError(failures, "Review E2E teardown failed.");
  }
});

afterAll(async () => {
  await removeTrackedFixtures(temporary);
});

describe("review fix end to end", () => {
  it(
    "retries a failed preflight, archives two isolated normal-push runs newest first, and cleans them up",
    async () => {
      const repository = await createGitFixture();
      const actualResolver = createWorkspaceResolver({
        environment: process.env,
        reviewCleanupTimeout: RESOLVER_REVIEW_CLEANUP_TIMEOUT,
        reviewRoot: repository.reviewRoot,
        roots: [repository.repositories],
        run: repository.run,
      });
      let resolutions = 0;
      const resolver = {
        ...actualResolver,
        async resolveReview(input) {
          resolutions += 1;
          if (resolutions === 1) {
            throw new WorkspaceError(
              "First preflight failed.",
              "review_workspace_test_failure",
            );
          }
          return await actualResolver.resolveReview(input);
        },
      };
      const preflight = deferred();
      let authorizationLoads = 0;
      const loadReviewAuthorization = vi.fn(async () => {
        authorizationLoads += 1;
        if (authorizationLoads === 1) await preflight.promise;
        return authorization(
          repository.base,
          await remoteHead(repository.remote),
        );
      });
      const diffService = {
        invalidate: vi.fn(),
        load: vi.fn(async () =>
          diff(repository.base, await remoteHead(repository.remote)),
        ),
        loadAuthorized: vi.fn(async () => {
          const head = await remoteHead(repository.remote);
          return {
            authorization: {
              authorLogin: "viewer",
              baseRefOid: repository.base,
              headRefOid: head,
              number: NUMBER,
              repository: REPOSITORY,
              url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
              viewerLogin: "viewer",
            },
            diff: diff(repository.base, head),
          };
        }),
      };
      const processes = [child(), child()];
      const spawned = [deferred(), deferred()];
      let spawnIndex = 0;
      const spawn = vi.fn((executable, arguments_, options) => {
        const index = spawnIndex;
        spawnIndex += 1;
        spawned[index].resolve({ arguments: arguments_, executable, options });
        return processes[index];
      });
      const coordinator = createRunCoordinator();
      let runSequence = 0;
      const manager = createClaudeRunManager({
        cache: { get: vi.fn() },
        coordinator,
        createId: () => `review-fix-e2e-${(runSequence += 1)}`,
        diffService,
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        },
        kill: terminateChild,
        killGrace: MANAGER_REVIEW_CLEANUP_TIMEOUT,
        loadPull: vi.fn(),
        loadReviewAuthorization,
        refreshReadiness: vi.fn(),
        reviewCleanupTimeout: MANAGER_REVIEW_CLEANUP_TIMEOUT,
        resolver,
        spawn,
      });
      managers.push(manager);
      const server = await listen({
        actionToken: TOKEN,
        cache: { get: vi.fn() },
        diffService,
        executionEnabled: true,
        runManager: manager,
      });
      routeFetch(server.origin);
      resetActionTokenForTests();

      const transcriptStore = createMemoryRunTranscriptStore();
      const view = render(
        React.createElement(Harness, {
          pullRequest: pull(repository.base, repository.head),
          transcriptStore,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: /Files changed/i }));
      await screen.findByRole("region", {
        name: `Files changed for ${REPOSITORY} pull request ${NUMBER}`,
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: "Give Claude feedback on new line 2",
        }),
      );
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Keep this value synchronized." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

      await screen.findByRole("button", { name: "Preparing review fix" });
      expect(
        screen.getByRole("heading", { name: "Ready" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Another Claude Code run is already active/i),
      ).not.toBeInTheDocument();
      expect(spawn).not.toHaveBeenCalled();

      preflight.resolve();
      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "First preflight failed.",
      );
      expect(screen.getByRole("textbox")).toHaveValue(
        "Keep this value synchronized.",
      );
      expect(
        screen.getByRole("heading", { name: "Ready" }),
      ).toBeInTheDocument();
      expect(spawn).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));
      const invocation = await spawned[0].promise;
      expect(spawn).toHaveBeenCalledOnce();
      expect(invocation.executable).toBe("claude");
      expect(invocation.arguments.slice(0, 5)).toEqual([
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
      ]);
      expect(invocation.arguments).toContain("--dangerously-skip-permissions");
      const prompt = invocation.arguments.at(-1);
      expect(prompt).toContain("Keep this value synchronized.");
      expect(prompt).toContain("src/example.js");
      expect(prompt).toContain(repository.base);
      expect(prompt).toContain(repository.head);
      expect(prompt).toContain("normal non-force push");
      expect(invocation.options.cwd).not.toBe(repository.source);
      expect(invocation.options.cwd).not.toBe(repository.linked);
      expect(
        invocation.options.cwd.startsWith(
          await realpath(repository.reviewRoot),
        ),
      ).toBe(true);

      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "In progress" }),
        ).toBeInTheDocument(),
      );
      expect(manager.activeCount()).toBe(1);
      expect(manager.activeWorkspaceCount()).toBe(1);
      expect(coordinator.activeCount()).toBe(1);
      expect(coordinator.activeWorkspaceCount()).toBe(1);
      expect(screen.getByLabelText("Active 1")).toBeInTheDocument();

      processes[0].stdout.write(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working on the selected lines."}}}\n',
      );
      processes[0].stdout.write(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Edit"}}}\n',
      );
      await screen.findByText(/Working on the selected lines\./);

      const next = await finishClaude(
        processes[0],
        invocation.options.cwd,
        repository.remote,
      );
      await waitForReviewSettlement(
        manager,
        coordinator,
        repository.reviewRoot,
      );
      expect(manager.activeWorkspaceCount()).toBe(0);
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);
      expect(screen.getByLabelText("Active 0")).toBeInTheDocument();
      expect(screen.queryByRole("log")).not.toBeInTheDocument();
      expect(
        screen.getByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).toHaveValue("Keep this value synchronized.");

      const filesChangedAfterFirstRun = screen.getByRole("button", {
        name: "Files changed",
      });
      if (filesChangedAfterFirstRun.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(filesChangedAfterFirstRun);
      }
      expect(
        await screen.findByRole("button", {
          name: "Give Claude feedback on new line 2",
        }),
      ).toHaveAttribute("aria-pressed", "true");

      const firstHistoryTrigger = screen.getByRole("button", {
        name: /Previous fixes/,
      });
      expect(firstHistoryTrigger).toHaveAccessibleName("Previous fixes, 1 run");
      expect(firstHistoryTrigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Completed")).not.toBeInTheDocument();

      fireEvent.click(firstHistoryTrigger);

      const firstHistory = screen.getByRole("region", {
        name: `Previous fixes for ${REPOSITORY} pull request ${NUMBER}`,
      });
      expect(
        firstHistory.querySelectorAll("[data-run-history-entry]"),
      ).toHaveLength(1);
      expect(
        firstHistory.querySelector("[data-run-history-entry]"),
      ).toHaveAttribute("data-run-history-entry", "review-fix-e2e-1");
      expect(firstHistory).toHaveTextContent("Claude review fix");
      expect(firstHistory).toHaveTextContent("Completed");
      expect(firstHistory).toHaveTextContent("Keep this value synchronized.");
      expect(
        firstHistory.querySelector("[data-run-history-transcript]"),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(firstHistory).getByRole("button", {
          name: /Show transcript/,
        }),
      );
      await waitFor(() =>
        expect(
          firstHistory.querySelector("[data-run-history-transcript]"),
        ).toBeInTheDocument(),
      );
      expect(
        firstHistory.querySelector("[data-run-history-transcript]")
          ?.textContent,
      ).toBe(
        "Working on the selected lines.\n" +
          "[tool] Edit — started\n" +
          "[diagnostic] Claude Code started.\n" +
          "Implemented the requested review fix.",
      );
      fireEvent.click(firstHistoryTrigger);
      expect(firstHistoryTrigger).toHaveAttribute("aria-expanded", "false");

      expect(await remoteHead(repository.remote)).toBe(next);
      expect(next).not.toBe(repository.head);
      await expect(
        execFile(
          "git",
          [
            "--git-dir",
            repository.remote,
            "merge-base",
            "--is-ancestor",
            repository.head,
            next,
          ],
          { encoding: "utf8" },
        ),
      ).resolves.toBeDefined();
      expect(await readdir(repository.reviewRoot)).toHaveLength(0);

      view.rerender(
        React.createElement(Harness, {
          pullRequest: pull(repository.base, next),
          transcriptStore,
        }),
      );
      expect(
        screen.getByRole("heading", { name: "Ready" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Active 0")).toBeInTheDocument();
      const filesChangedBeforeSecondRun = screen.getByRole("button", {
        name: "Files changed",
      });
      if (
        filesChangedBeforeSecondRun.getAttribute("aria-expanded") !== "true"
      ) {
        fireEvent.click(filesChangedBeforeSecondRun);
      }
      const secondGutter = await screen.findByRole("button", {
        name: "Give Claude feedback on new line 2",
      });
      expect(secondGutter).toHaveAttribute("aria-pressed", "false");
      expect(
        screen.queryByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).not.toBeInTheDocument();
      fireEvent.click(secondGutter);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Address the follow-up review feedback." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

      const secondInvocation = await spawned[1].promise;
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(secondInvocation.executable).toBe("claude");
      expect(secondInvocation.arguments.slice(0, 5)).toEqual([
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
      ]);
      expect(secondInvocation.arguments).toContain(
        "--dangerously-skip-permissions",
      );
      const secondPrompt = secondInvocation.arguments.at(-1);
      expect(secondPrompt).toContain("Address the follow-up review feedback.");
      expect(secondPrompt).toContain("src/example.js");
      expect(secondPrompt).toContain(repository.base);
      expect(secondPrompt).toContain(next);
      expect(secondPrompt).toContain("normal non-force push");
      expect(secondInvocation.options.cwd).not.toBe(invocation.options.cwd);
      expect(secondInvocation.options.cwd).not.toBe(repository.source);
      expect(secondInvocation.options.cwd).not.toBe(repository.linked);
      expect(
        secondInvocation.options.cwd.startsWith(
          await realpath(repository.reviewRoot),
        ),
      ).toBe(true);

      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "In progress" }),
        ).toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Active 1")).toBeInTheDocument();
      expect(manager.activeCount()).toBe(1);
      expect(manager.activeWorkspaceCount()).toBe(1);
      expect(coordinator.activeCount()).toBe(1);
      expect(coordinator.activeWorkspaceCount()).toBe(1);

      processes[1].stdout.write(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working on the follow-up lines."}}}\n',
      );
      processes[1].stdout.write(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}}\n',
      );
      await screen.findByText(/Working on the follow-up lines\./);

      const latest = await finishClaude(
        processes[1],
        secondInvocation.options.cwd,
        repository.remote,
        {
          change: "export const followup = true;\n",
          commit: "fix follow-up review feedback",
          output: "Implemented the follow-up review fix.",
        },
      );
      await waitForReviewSettlement(
        manager,
        coordinator,
        repository.reviewRoot,
      );
      expect(manager.activeWorkspaceCount()).toBe(0);
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);

      view.rerender(
        React.createElement(Harness, {
          pullRequest: pull(repository.base, latest),
          transcriptStore,
        }),
      );
      expect(screen.getByLabelText("Active 0")).toBeInTheDocument();
      expect(screen.queryByRole("log")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).not.toBeInTheDocument();

      const historyTrigger = screen.getByRole("button", {
        name: /Previous fixes/,
      });
      expect(historyTrigger).toHaveAccessibleName("Previous fixes, 2 runs");
      expect(historyTrigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(historyTrigger);

      const history = screen.getByRole("region", {
        name: `Previous fixes for ${REPOSITORY} pull request ${NUMBER}`,
      });
      const entries = [...history.querySelectorAll("[data-run-history-entry]")];
      expect(entries).toHaveLength(2);
      expect(
        entries.map((entry) => entry.getAttribute("data-run-history-entry")),
      ).toEqual(["review-fix-e2e-2", "review-fix-e2e-1"]);
      expect(
        history.querySelectorAll("[data-run-history-transcript]"),
      ).toHaveLength(0);
      for (const entry of entries) {
        fireEvent.click(
          within(entry).getByRole("button", { name: /Show transcript/ }),
        );
      }
      await waitFor(() =>
        expect(
          history.querySelectorAll("[data-run-history-transcript]"),
        ).toHaveLength(2),
      );
      const transcripts = [
        ...history.querySelectorAll("[data-run-history-transcript]"),
      ];
      expect(transcripts.map((transcript) => transcript.textContent)).toEqual([
        "Working on the follow-up lines.\n" +
          "[tool] Read — started\n" +
          "[diagnostic] Claude Code started.\n" +
          "Implemented the follow-up review fix.",
        "Working on the selected lines.\n" +
          "[tool] Edit — started\n" +
          "[diagnostic] Claude Code started.\n" +
          "Implemented the requested review fix.",
      ]);
      expect(entries[0]).toHaveTextContent(
        "Address the follow-up review feedback.",
      );
      expect(entries[1]).toHaveTextContent("Keep this value synchronized.");

      expect(await remoteHead(repository.remote)).toBe(latest);
      expect(latest).not.toBe(next);
      await expect(
        execFile(
          "git",
          [
            "--git-dir",
            repository.remote,
            "merge-base",
            "--is-ancestor",
            next,
            latest,
          ],
          { encoding: "utf8" },
        ),
      ).resolves.toBeDefined();
      expect(await readdir(repository.reviewRoot)).toHaveLength(0);
      expect(
        repository.commands.some(
          (arguments_) =>
            arguments_.includes("fetch") && arguments_.includes("origin"),
        ),
      ).toBe(true);
      expect(
        repository.commands.some(
          (arguments_) =>
            arguments_.includes("push") &&
            arguments_.includes("--dry-run") &&
            arguments_.includes("origin"),
        ),
      ).toBe(true);
      expect(loadReviewAuthorization).toHaveBeenCalledTimes(10);
      expect(diffService.invalidate).toHaveBeenCalledTimes(2);
      expect(diffService.invalidate).toHaveBeenNthCalledWith(1, {
        number: NUMBER,
        repository: REPOSITORY,
      });
      expect(diffService.invalidate).toHaveBeenNthCalledWith(2, {
        number: NUMBER,
        repository: REPOSITORY,
      });
    },
    TWO_RUN_E2E_TIMEOUT,
  );

  it(
    "restores accepted review feedback after failure, retries in a fresh worktree, and archives both transcripts",
    async () => {
      const repository = await createGitFixture();
      const resolver = createWorkspaceResolver({
        environment: process.env,
        reviewCleanupTimeout: RESOLVER_REVIEW_CLEANUP_TIMEOUT,
        reviewRoot: repository.reviewRoot,
        roots: [repository.repositories],
        run: repository.run,
      });
      const loadReviewAuthorization = vi.fn(async () =>
        authorization(repository.base, await remoteHead(repository.remote)),
      );
      const diffService = {
        invalidate: vi.fn(),
        load: vi.fn(async () =>
          diff(repository.base, await remoteHead(repository.remote)),
        ),
        loadAuthorized: vi.fn(async () => {
          const head = await remoteHead(repository.remote);
          return {
            authorization: {
              authorLogin: "viewer",
              baseRefOid: repository.base,
              headRefOid: head,
              number: NUMBER,
              repository: REPOSITORY,
              url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
              viewerLogin: "viewer",
            },
            diff: diff(repository.base, head),
          };
        }),
      };
      const processes = [child(), child()];
      const spawned = [deferred(), deferred()];
      let spawnIndex = 0;
      const spawn = vi.fn((executable, arguments_, options) => {
        const index = spawnIndex;
        spawnIndex += 1;
        spawned[index].resolve({ arguments: arguments_, executable, options });
        return processes[index];
      });
      const coordinator = createRunCoordinator();
      let runSequence = 0;
      const manager = createClaudeRunManager({
        cache: { get: vi.fn() },
        coordinator,
        createId: () => `review-retry-e2e-${(runSequence += 1)}`,
        diffService,
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        },
        kill: terminateChild,
        killGrace: MANAGER_REVIEW_CLEANUP_TIMEOUT,
        loadPull: vi.fn(),
        loadReviewAuthorization,
        refreshReadiness: vi.fn(),
        reviewCleanupTimeout: MANAGER_REVIEW_CLEANUP_TIMEOUT,
        resolver,
        spawn,
      });
      managers.push(manager);
      const server = await listen({
        actionToken: TOKEN,
        cache: { get: vi.fn() },
        diffService,
        executionEnabled: true,
        runManager: manager,
      });
      routeFetch(server.origin);
      resetActionTokenForTests();

      const transcriptStore = createMemoryRunTranscriptStore();
      const view = render(
        React.createElement(Harness, {
          pullRequest: pull(repository.base, repository.head),
          transcriptStore,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Files changed" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Give Claude feedback on new line 2",
        }),
      );
      const draft = "  Keep this value synchronized exactly.  ";
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: draft },
      });
      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));

      const firstInvocation = await spawned[0].promise;
      await screen.findByRole("heading", { name: "In progress" });
      expect(firstInvocation.options.cwd).not.toBe(repository.source);
      expect(firstInvocation.options.cwd).not.toBe(repository.linked);
      expect(firstInvocation.arguments).toContain(
        "--dangerously-skip-permissions",
      );
      expect(firstInvocation.arguments.at(-1)).toContain(
        "Keep this value synchronized exactly.",
      );
      processes[0].stdout.write('{"type":"system","subtype":"init"}\n');
      processes[0].stdout.write(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Tried the exact review change."}}}\n',
      );
      closeChild(processes[0], 1, null);

      await waitForReviewSettlement(
        manager,
        coordinator,
        repository.reviewRoot,
      );
      expect(manager.activeWorkspaceCount()).toBe(0);
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);
      expect(await remoteHead(repository.remote)).toBe(repository.head);
      expect(await readdir(repository.reviewRoot)).toHaveLength(0);

      const files = screen.getByRole("button", { name: "Files changed" });
      if (files.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(files);
      }
      expect(
        await screen.findByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).toHaveValue(draft);
      expect(
        screen.getByRole("button", {
          name: "Give Claude feedback on new line 2",
        }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The review fix failed.",
      );

      const failedHistoryTrigger = screen.getByRole("button", {
        name: "Previous fixes, 1 run",
      });
      fireEvent.click(failedHistoryTrigger);
      const failedHistory = screen.getByRole("region", {
        name: `Previous fixes for ${REPOSITORY} pull request ${NUMBER}`,
      });
      expect(failedHistory).toHaveTextContent("Failed");
      expect(
        failedHistory.querySelector("[data-run-history-transcript]"),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(failedHistory).getByRole("button", {
          name: /Show transcript/,
        }),
      );
      await waitFor(() =>
        expect(
          failedHistory.querySelector("[data-run-history-transcript]"),
        ).toHaveTextContent("Tried the exact review change."),
      );
      fireEvent.click(failedHistoryTrigger);

      fireEvent.click(screen.getByRole("button", { name: "Run review fix" }));
      const secondInvocation = await spawned[1].promise;
      await screen.findByRole("heading", { name: "In progress" });
      expect(secondInvocation.options.cwd).not.toBe(
        firstInvocation.options.cwd,
      );
      expect(secondInvocation.arguments.at(-1)).toContain(
        "Keep this value synchronized exactly.",
      );
      expect(
        screen.getByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).toHaveValue(draft);

      const latest = await finishClaude(
        processes[1],
        secondInvocation.options.cwd,
        repository.remote,
        {
          change: "export const retried = true;\n",
          commit: "fix retried review feedback",
          output: "Implemented the retried review fix.",
        },
      );
      await waitForReviewSettlement(
        manager,
        coordinator,
        repository.reviewRoot,
      );
      expect(manager.activeWorkspaceCount()).toBe(0);
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);
      expect(screen.getByLabelText("Active 0")).toBeInTheDocument();

      view.rerender(
        React.createElement(Harness, {
          pullRequest: pull(repository.base, latest),
          transcriptStore,
        }),
      );
      const filesAfterSuccess = screen.getByRole("button", {
        name: "Files changed",
      });
      if (filesAfterSuccess.getAttribute("aria-expanded") !== "true") {
        fireEvent.click(filesAfterSuccess);
      }
      expect(
        screen.queryByRole("textbox", {
          name: "Claude feedback on new line 2",
        }),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByRole("button", {
          name: "Give Claude feedback on new line 2",
        }),
      ).toHaveAttribute("aria-pressed", "false");

      const historyTrigger = screen.getByRole("button", {
        name: "Previous fixes, 2 runs",
      });
      fireEvent.click(historyTrigger);
      const history = screen.getByRole("region", {
        name: `Previous fixes for ${REPOSITORY} pull request ${NUMBER}`,
      });
      const entries = [...history.querySelectorAll("[data-run-history-entry]")];
      expect(
        entries.map((entry) => entry.getAttribute("data-run-history-entry")),
      ).toEqual(["review-retry-e2e-2", "review-retry-e2e-1"]);
      expect(entries[0]).toHaveTextContent("Completed");
      expect(entries[1]).toHaveTextContent("Failed");
      expect(history).toHaveTextContent(
        "Keep this value synchronized exactly.",
      );
      expect(
        history.querySelectorAll("[data-run-history-transcript]"),
      ).toHaveLength(0);
      for (const entry of entries) {
        fireEvent.click(
          within(entry).getByRole("button", { name: /Show transcript/ }),
        );
      }
      await waitFor(() =>
        expect(
          history.querySelectorAll("[data-run-history-transcript]"),
        ).toHaveLength(2),
      );
      expect(
        entries[0].querySelector("[data-run-history-transcript]"),
      ).toHaveTextContent("Implemented the retried review fix.");
      expect(
        entries[1].querySelector("[data-run-history-transcript]"),
      ).toHaveTextContent("Tried the exact review change.");

      expect(await remoteHead(repository.remote)).toBe(latest);
      expect(latest).not.toBe(repository.head);
      await expect(
        execFile(
          "git",
          [
            "--git-dir",
            repository.remote,
            "merge-base",
            "--is-ancestor",
            repository.head,
            latest,
          ],
          { encoding: "utf8" },
        ),
      ).resolves.toBeDefined();
      expect(await readdir(repository.reviewRoot)).toHaveLength(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(diffService.invalidate).toHaveBeenCalledOnce();
    },
    TWO_RUN_E2E_TIMEOUT,
  );

  it("bounds partial-provision cleanup and releases manager reservations when removal never settles", async () => {
    const repository = await createGitFixture();
    const removeReviewDirectory = vi.fn(() => new Promise(() => undefined));
    const run = vi.fn(async (file, arguments_, options) => {
      if (arguments_.includes("fetch")) throw new Error("fetch failed");
      return await repository.run(file, arguments_, options);
    });
    const resolver = createWorkspaceResolver({
      environment: process.env,
      removeReviewDirectory,
      reviewCleanupTimeout: 10,
      reviewRoot: repository.reviewRoot,
      roots: [repository.repositories],
      run,
    });
    const coordinator = createRunCoordinator({ limit: 1 });
    const diffService = reviewDiffService(repository);
    const spawn = vi.fn();
    const manager = createClaudeRunManager({
      cache: { get: vi.fn() },
      coordinator,
      diffService,
      loadPull: vi.fn(),
      loadReviewAuthorization: vi.fn(async () =>
        authorization(repository.base, repository.head),
      ),
      refreshReadiness: vi.fn(),
      resolver,
      spawn,
    });
    managers.push(manager);

    await expect(
      manager.start(reviewRequest(repository), reviewChannel().value),
    ).rejects.toMatchObject({
      code: "review_workspace_cleanup_failed",
      message: expect.not.stringContaining(repository.root),
    });
    expect(removeReviewDirectory).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.activeCount()).toBe(0);
    expect(manager.activeWorkspaceCount()).toBe(0);
    expect(coordinator.activeCount()).toBe(0);
    expect(coordinator.activeWorkspaceCount()).toBe(0);
  }, 30_000);

  it("reports an identity-safe cleanup diagnostic and releases reservations without deleting a replacement", async () => {
    const repository = await createGitFixture();
    const resolver = createWorkspaceResolver({
      environment: process.env,
      reviewRoot: repository.reviewRoot,
      roots: [repository.repositories],
      run: repository.run,
    });
    const coordinator = createRunCoordinator({ limit: 1 });
    const diffService = reviewDiffService(repository);
    const fakeProcess = child();
    let invocation;
    const spawn = vi.fn((_executable, _arguments, options) => {
      invocation = options;
      return fakeProcess;
    });
    const manager = createClaudeRunManager({
      cache: { get: vi.fn() },
      coordinator,
      diffService,
      loadPull: vi.fn(),
      loadReviewAuthorization: vi.fn(async () =>
        authorization(repository.base, repository.head),
      ),
      refreshReadiness: vi.fn(),
      resolver,
      spawn,
    });
    managers.push(manager);
    const channel = reviewChannel();
    const started = await manager.start(
      reviewRequest(repository),
      channel.value,
    );
    const displaced = `${invocation.cwd}-displaced`;
    await rename(invocation.cwd, displaced);
    await mkdir(invocation.cwd, { mode: 0o700 });
    const sentinel = join(invocation.cwd, "sentinel");
    await writeFile(sentinel, "keep\n");

    closeChild(fakeProcess, 1, null);
    await started.done;

    expect(channel.events).toContainEqual({
      text: expect.stringContaining(
        "The isolated review workspace could not be removed",
      ),
      type: "diagnostic",
    });
    expect(JSON.stringify(channel.events)).not.toContain(repository.root);
    expect(channel.events.at(-1)).toEqual({
      message: "Claude Code exited with an error.",
      type: "error",
    });
    expect(manager.activeCount()).toBe(0);
    expect(manager.activeWorkspaceCount()).toBe(0);
    expect(coordinator.activeCount()).toBe(0);
    expect(coordinator.activeWorkspaceCount()).toBe(0);
    await expect(access(sentinel)).resolves.toBeUndefined();
    await expect(access(displaced)).resolves.toBeUndefined();
  }, 30_000);
});
