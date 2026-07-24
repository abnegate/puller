import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTaskManager, validateTaskStartInput } from "../task.mjs";

const OID = "abcdef0123456789abcdef0123456789abcdef01";
const ID = "task_12345678";
const temporary = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directories() {
  const root = await mkdtemp(join(tmpdir(), "puller-task-"));
  temporary.push(root);
  const source = join(root, "source");
  const stateRoot = join(root, "state");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(source);
  return { root, source, stateRoot, worktreeRoot };
}

function childProcess() {
  const child = new EventEmitter();
  child.pid = 8123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function input(overrides = {}) {
  return {
    agent: "claude",
    id: ID,
    repository: "owner/repo",
    base: "main",
    prompt: "Add the compact task launcher and test it.",
    ...overrides,
  };
}

async function waitFor(manager, phase) {
  const task = manager.list().find((candidate) => candidate.id === ID);
  if (task?.phase === phase) return task;
  for await (const event of manager.subscribe(ID)) {
    if (event.type === "task" && event.task.phase === phase) return event.task;
  }
  throw new Error(`Task did not reach ${phase}`);
}

function harness({
  codexChanges = false,
  createFails = false,
  createWaitsForAbort = false,
  crossRepository = false,
  listPull = false,
  pullHead = OID,
  pushFails = false,
} = {}) {
  const deferred = [];
  const order = [];
  const child = childProcess();
  const catalog = {
    options: vi.fn(async () => ({
      repositories: [],
      updatedAt: "2026-07-22T00:00:00.000Z",
    })),
    resolve: vi.fn(),
  };
  const reservation = {
    reserveWorkspace: vi.fn(),
    release: vi.fn(),
  };
  const scheduler = {
    reserveQueued: vi.fn(async () => {
      order.push("scheduler");
      return reservation;
    }),
  };
  let statusCalls = 0;
  const run = vi.fn(async (executable, args, options = {}) => {
    order.push(`${executable}:${args.slice(0, 3).join(" ")}`);
    if (executable === "git" && args.includes("show-ref")) {
      const error = new Error("missing");
      error.code = 1;
      throw error;
    }
    if (executable === "git" && args.includes("ls-remote")) {
      const error = new Error("missing");
      error.code = 2;
      throw error;
    }
    if (executable === "git" && args.includes("worktree")) {
      await mkdir(args.at(-2), { recursive: true });
    }
    if (executable === "git" && args.includes("rev-parse"))
      return { stdout: `${OID}\n`, stderr: "" };
    if (codexChanges && executable === "git" && args.includes("status")) {
      statusCalls += 1;
      return {
        stdout: statusCalls === 1 ? " M src/example.js\0" : "",
        stderr: "",
      };
    }
    if (executable === "git" && args.includes("push") && pushFails)
      throw new Error("remote branch appeared");
    if (executable === "gh" && args.includes("create")) {
      order.push("create-pr");
      if (createWaitsForAbort) {
        await new Promise((resolve, reject) => {
          const aborted = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (options.signal?.aborted) aborted();
          else
            options.signal?.addEventListener("abort", aborted, { once: true });
        });
      }
      if (createFails) throw new Error("response lost");
      return { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "" };
    }
    if (executable === "gh" && args.includes("view")) {
      const branch =
        args.find((argument) => argument.startsWith("puller/")) ?? order.branch;
      return {
        stdout: JSON.stringify({
          baseRefName: "main",
          body: `<!-- puller-task:${ID} -->`,
          headRefName: branch,
          headRefOid: pullHead,
          isCrossRepository: crossRepository,
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/owner/repo/pull/42",
        }),
        stderr: "",
      };
    }
    if (executable === "gh" && args.includes("list")) {
      return {
        stdout: JSON.stringify(
          listPull
            ? [
                {
                  baseRefName: "main",
                  body: `<!-- puller-task:${ID} -->`,
                  headRefName: order.branch,
                  headRefOid: pullHead,
                  isCrossRepository: crossRepository,
                  isDraft: true,
                  number: 42,
                  state: "OPEN",
                  url: "https://github.com/owner/repo/pull/42",
                },
              ]
            : [],
        ),
        stderr: "",
      };
    }
    const branchIndex = args.indexOf("-b");
    if (branchIndex >= 0) order.branch = args[branchIndex + 1];
    return { stdout: "", stderr: "" };
  });
  const spawn = vi.fn(() => {
    order.push("spawn");
    return child;
  });
  return {
    catalog,
    child,
    deferred,
    order,
    reservation,
    run,
    scheduler,
    spawn,
  };
}

describe("new task manager", () => {
  it("runs a Codex task, requires turn completion, and lets Puller publish it", async () => {
    const paths = await directories();
    const test = harness({ codexChanges: true });
    test.child.stdin = new PassThrough();
    vi.spyOn(test.child.stdin, "end");
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const codexCleanup = vi.fn(async () => undefined);
    const prepareCodex = vi.fn(async () => ({
      args: ["exec", "--json", "-"],
      cleanup: codexCleanup,
      command: "/opt/homebrew/bin/codex",
      cwd: "/protected/control",
      environment: {},
      prompt: "trusted task prompt",
    }));
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      prepareCodex,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input({ agent: "codex" }));
    test.deferred.shift()();
    await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());
    expect(test.spawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/codex",
      ["exec", "--json", "-"],
      expect.objectContaining({ cwd: "/protected/control" }),
    );
    expect(test.child.stdin.end).toHaveBeenCalledWith("trusted task prompt");
    test.child.stdout.write(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}\n',
    );
    test.child.stdout.write('{"type":"turn.completed"}\n');
    test.child.emit("close", 0, null);
    await expect(waitFor(manager, "completed")).resolves.toMatchObject({
      agent: "codex",
      phase: "completed",
    });
    expect(
      test.run.mock.calls.some(
        ([executable, args]) =>
          executable === "git" &&
          args.includes("commit") &&
          args.includes("feat: Add the compact task launcher and test it."),
      ),
    ).toBe(true);
    expect(
      test.run.mock.calls.some(
        ([executable, args]) =>
          executable === "git" &&
          args.includes("push") &&
          args.some((argument) =>
            String(argument).startsWith("HEAD:refs/heads/puller/"),
          ),
      ),
    ).toBe(true);
    expect(codexCleanup).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("escalates a cancelled Codex task from SIGINT through SIGTERM to SIGKILL", async () => {
    const paths = await directories();
    const test = harness();
    test.child.stdin = new PassThrough();
    const timers = [];
    const kill = vi.fn();
    const codexCleanup = vi.fn(async () => undefined);
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      clearTimer: vi.fn((timer) => {
        if (timer) timer.cleared = true;
      }),
      defer: (callback) => test.deferred.push(callback),
      kill,
      killGrace: 5,
      prepareCodex: vi.fn(async () => ({
        args: ["exec", "--json", "-"],
        cleanup: codexCleanup,
        command: "/opt/homebrew/bin/codex",
        cwd: "/protected/control",
        environment: {},
        prompt: "trusted task prompt",
      })),
      setTimer(callback, delay) {
        const timer = { callback, cleared: false, delay, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input({ agent: "codex" }));
    test.deferred.shift()();
    await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());

    await manager.cancel(ID);
    expect(kill.mock.calls.map(([, signal]) => signal)).toEqual(["SIGINT"]);
    timers.findLast((timer) => timer.delay === 5).callback();
    expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
      "SIGINT",
      "SIGTERM",
    ]);
    timers.findLast((timer) => timer.delay === 5).callback();
    expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
      "SIGINT",
      "SIGTERM",
      "SIGKILL",
    ]);

    test.child.emit("close", null, "SIGKILL");
    await vi.waitFor(() => expect(codexCleanup).toHaveBeenCalledOnce());
    await manager.close();
  });

  it("creates and confirms a draft PR before scheduling a dangerous one-shot Claude process", async () => {
    const paths = await directories();
    const test = harness();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "git@github.com:owner/repo.git",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      environment: { GH_TOKEN: "test-token", PATH: "/usr/bin" },
      kill: vi.fn(),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    const queued = await manager.start(input());
    expect(queued).toMatchObject({
      id: ID,
      phase: "queued",
      repository: "owner/repo",
    });
    expect(test.spawn).not.toHaveBeenCalled();
    test.deferred.shift()();

    const running = await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());
    expect(running.pullRequest).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    expect(test.order.indexOf("create-pr")).toBeLessThan(
      test.order.indexOf("scheduler"),
    );
    expect(test.order.indexOf("scheduler")).toBeLessThan(
      test.order.indexOf("spawn"),
    );
    expect(test.scheduler.reserveQueued).toHaveBeenCalledWith(
      expect.objectContaining({ key: `task:${ID}` }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const [executable, arguments_, options] = test.spawn.mock.calls[0];
    expect(executable).toBe("claude");
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
    expect(arguments_).toContain("--dangerously-skip-permissions");
    expect(arguments_.at(-1)).toContain(
      "Do not create another branch, worktree, pull request, or release.",
    );
    expect(options).toMatchObject({
      cwd: running.worktree,
      detached: true,
      shell: false,
    });
    expect(options.env).toMatchObject({ GH_TOKEN: "test-token" });
    const commit = test.run.mock.calls.find(
      ([executable, args]) => executable === "git" && args.includes("commit"),
    );
    const push = test.run.mock.calls.find(
      ([executable, args]) => executable === "git" && args.includes("push"),
    );
    expect(commit?.[1]).toEqual(
      expect.arrayContaining([
        "core.hooksPath=/dev/null",
        "commit.gpgSign=false",
        "--no-verify",
      ]),
    );
    const reference = `refs/heads/${running.branch}`;
    expect(push?.[1]).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      running.worktree,
      "push",
      "--no-verify",
      "--set-upstream",
      `--force-with-lease=${reference}:`,
      "origin",
      `${reference}:${reference}`,
    ]);
    expect(push?.[2].env).toMatchObject({
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    });

    test.child.stdout.write(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Implemented." },
        },
      })}\n`,
    );
    test.child.emit("close", 0, null);
    await waitFor(manager, "completed");
    const replay = [];
    for await (const event of manager.subscribe(ID)) replay.push(event);
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: "output",
        stream: "stdout",
        text: "Implemented.",
      }),
    );
    await manager.close();
    expect(
      JSON.parse(await readFile(join(paths.stateRoot, `${ID}.json`), "utf8")),
    ).toMatchObject({
      task: { phase: "completed", pullRequest: { number: 42 } },
    });
  });

  it("persists running before spawn and releases its reservation when that manifest write fails", async () => {
    const paths = await directories();
    const test = harness();
    const phases = [];
    const write = vi.fn(async (path, content, options) => {
      const phase = JSON.parse(content).task.phase;
      phases.push(phase);
      if (phase === "running") throw new Error("disk unavailable");
      return writeFile(path, content, options);
    });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
      write,
    });
    await manager.start(input());
    test.deferred.shift()();

    await expect(waitFor(manager, "failed")).resolves.toMatchObject({
      error: "The task could not be prepared.",
    });
    expect(phases).toContain("running");
    expect(test.spawn).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(test.reservation.release).toHaveBeenCalledOnce(),
    );
    await manager.close();
  });

  it("does not spawn when cancellation arrives during the durable running transition", async () => {
    const paths = await directories();
    const test = harness();
    let continueWrite;
    let runningWrite;
    const blocked = new Promise((resolveBlocked) => {
      runningWrite = resolveBlocked;
    });
    const write = vi.fn(async (path, content, options) => {
      if (JSON.parse(content).task.phase === "running") {
        runningWrite();
        await new Promise((resolveWrite) => {
          continueWrite = resolveWrite;
        });
      }
      return writeFile(path, content, options);
    });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
      write,
    });
    await manager.start(input());
    test.deferred.shift()();
    await blocked;

    const cancellation = manager.cancel(ID);
    continueWrite();
    await expect(cancellation).resolves.toMatchObject({ phase: "cancelled" });
    expect(test.spawn).not.toHaveBeenCalled();
    expect(test.reservation.release).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("terminates and awaits a spawned child when listener setup fails", async () => {
    const paths = await directories();
    const test = harness();
    test.child.stdout.on = vi.fn(() => {
      throw new Error("listener failed");
    });
    const kill = vi.fn((_pid, signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => test.child.emit("close", null, signal));
      }
    });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      kill,
      killGrace: 5,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();

    await expect(waitFor(manager, "failed")).resolves.toMatchObject({
      error: "Claude Code could not be started.",
    });
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGKILL");
    expect(test.reservation.release).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("retains the reservation after a child error until close confirms exit", async () => {
    const paths = await directories();
    const test = harness();
    const kill = vi.fn();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      kill,
      killGrace: 1_000,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());

    test.child.emit("error", new Error("spawn error"));
    await expect(waitFor(manager, "failed")).resolves.toBeDefined();
    expect(test.reservation.release).not.toHaveBeenCalled();
    test.child.emit("close", null, "SIGTERM");
    await vi.waitFor(() =>
      expect(test.reservation.release).toHaveBeenCalledOnce(),
    );
    await manager.close();
  });

  it("does not open a PR when the create-only remote branch push loses its race", async () => {
    const paths = await directories();
    const test = harness({ pushFails: true });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();

    await expect(waitFor(manager, "failed")).resolves.toBeDefined();
    const push = test.run.mock.calls.find(
      ([executable, args]) => executable === "git" && args.includes("push"),
    );
    const branch = manager.list()[0].branch;
    const reference = `refs/heads/${branch}`;
    expect(push?.[1]).toEqual(
      expect.arrayContaining([
        `--force-with-lease=${reference}:`,
        `${reference}:${reference}`,
      ]),
    );
    expect(test.order).not.toContain("create-pr");
    expect(test.scheduler.reserveQueued).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
    await manager.close();
  });

  it("reconciles an ambiguous successful PR creation by exact branch and task marker", async () => {
    const paths = await directories();
    const test = harness({ createFails: true, listPull: true });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo.git",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();

    await expect(waitFor(manager, "running")).resolves.toMatchObject({
      pullRequest: { number: 42 },
    });
    expect(
      test.run.mock.calls.some(
        ([executable, args]) => executable === "gh" && args.includes("list"),
      ),
    ).toBe(true);
    await manager.close();
  });

  it("reattaches the same normalized request and rejects identifier reuse with different input", async () => {
    const paths = await directories();
    const test = harness();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    const first = await manager.start(input());
    expect(first.agent).toBe("claude");
    await expect(
      manager.start(input({ repository: "OWNER/REPO" })),
    ).resolves.toEqual(first);
    await expect(
      manager.start(input({ prompt: "A different task" })),
    ).rejects.toMatchObject({
      status: 409,
      code: "task_id_conflict",
    });
    await expect(
      manager.start(input({ agent: "codex" })),
    ).rejects.toMatchObject({
      status: 409,
      code: "task_id_conflict",
    });
    expect(test.deferred).toHaveLength(1);
  });

  it("reserves a task identifier before asynchronous validation so concurrent starts coalesce", async () => {
    const paths = await directories();
    const test = harness();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    const first = manager.start(input());
    const duplicate = manager.start(input({ repository: "OWNER/REPO" }));
    await expect(
      manager.start(input({ prompt: "Conflicting task" })),
    ).rejects.toMatchObject({
      code: "task_id_conflict",
      status: 409,
    });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ id: ID, phase: "queued" }),
      expect.objectContaining({ id: ID, phase: "queued" }),
    ]);
    expect(manager.list()).toHaveLength(1);
    expect(test.deferred).toHaveLength(1);
    await manager.close();
  });

  it("does not schedule a task whose initial repository validation overlaps shutdown", async () => {
    const paths = await directories();
    const test = harness();
    let resolveRepository;
    test.catalog.resolve.mockReturnValue(
      new Promise((resolveValue) => {
        resolveRepository = resolveValue;
      }),
    );
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    const starting = manager.start(input());
    await vi.waitFor(() => expect(test.catalog.resolve).toHaveBeenCalledOnce());
    expect(manager.list()).toEqual([
      expect.objectContaining({ phase: "queued" }),
    ]);
    const closing = manager.close();
    resolveRepository({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });

    await expect(starting).rejects.toMatchObject({
      code: "shutting_down",
      status: 503,
    });
    await closing;
    expect(manager.list()).toEqual([
      expect.objectContaining({ phase: "failed" }),
    ]);
    expect(test.deferred).toHaveLength(0);
  });

  it.each([
    { crossRepository: false, pullHead: "1".repeat(40) },
    { crossRepository: true, pullHead: OID },
  ])(
    "refuses to schedule Claude when the draft PR does not prove the pushed head",
    async (proof) => {
      const paths = await directories();
      const test = harness(proof);
      test.catalog.resolve.mockResolvedValue({
        cwd: paths.source,
        origin: "https://github.com/owner/repo",
        repository: "owner/repo",
      });
      const manager = createTaskManager({
        ...test,
        defer: (callback) => test.deferred.push(callback),
        stateRoot: paths.stateRoot,
        worktreeRoot: paths.worktreeRoot,
      });
      await manager.start(input());
      test.deferred.shift()();

      await expect(waitFor(manager, "failed")).resolves.toMatchObject({
        error: "The draft pull request could not be confirmed.",
      });
      expect(test.scheduler.reserveQueued).not.toHaveBeenCalled();
      expect(test.spawn).not.toHaveBeenCalled();
      await manager.close();
    },
  );

  it("reconciles a confirmed PR before completing cancellation of an ambiguous create", async () => {
    const paths = await directories();
    const test = harness({ createWaitsForAbort: true, listPull: true });
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();
    await waitFor(manager, "opening-pr");

    await expect(manager.cancel(ID)).resolves.toMatchObject({
      phase: "cancelled",
      pullRequest: { number: 42 },
    });
    expect(test.scheduler.reserveQueued).not.toHaveBeenCalled();
    expect(test.spawn).not.toHaveBeenCalled();
    await manager.close();
  });

  it("disconnects subscribers without cancelling and preserves PR/worktree artifacts on cancellation", async () => {
    const paths = await directories();
    const test = harness();
    const kill = vi.fn();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      kill,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    const disconnected = new AbortController();
    const iterator = manager
      .subscribe(ID, { signal: disconnected.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    disconnected.abort();
    await iterator.next();
    expect(manager.list()[0].phase).toBe("queued");

    test.deferred.shift()();
    const running = await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());
    await manager.cancel(ID);
    expect(manager.list()[0]).toMatchObject({
      phase: "cancelled",
      pullRequest: { number: 42 },
      worktree: running.worktree,
    });
    await expect(stat(running.worktree)).resolves.toBeDefined();
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGTERM");
    expect(
      test.run.mock.calls.some(
        ([executable, args]) =>
          executable === "git" &&
          (args.includes("remove") || args.includes("reset")),
      ),
    ).toBe(false);
    expect(
      test.run.mock.calls.some(
        ([executable, args]) =>
          executable === "gh" &&
          (args.includes("close") || args.includes("delete")),
      ),
    ).toBe(false);
  });

  it("keeps forced termination armed after cancellation and escalates shutdown", async () => {
    const paths = await directories();
    const test = harness();
    const kill = vi.fn();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      kill,
      killGrace: 5,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();
    await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());

    await manager.cancel(ID);
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGKILL");
    await manager.close();
  });

  it("waits through the kill grace and marks a running task failed on shutdown", async () => {
    const paths = await directories();
    const test = harness();
    const kill = vi.fn();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      kill,
      killGrace: 5,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();
    await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());

    await manager.close();
    expect(manager.list()[0]).toMatchObject({
      error: "The server stopped before this task completed.",
      phase: "failed",
    });
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-test.child.pid, "SIGKILL");
  });

  it("redacts secrets and worktree paths that span streamed Claude deltas", async () => {
    const paths = await directories();
    const test = harness();
    test.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const manager = createTaskManager({
      ...test,
      defer: (callback) => test.deferred.push(callback),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await manager.start(input());
    test.deferred.shift()();
    const running = await waitFor(manager, "running");
    await vi.waitFor(() => expect(test.spawn).toHaveBeenCalledOnce());
    const pieces = [
      "token=ghp_abcdefgh",
      `ijklmnopqrstuv ${running.worktree.slice(0, 8)}`,
      running.worktree.slice(8),
    ];
    for (const text of pieces) {
      test.child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        })}\n`,
      );
    }
    test.child.emit("close", 0, null);
    await waitFor(manager, "completed");

    const replay = [];
    for await (const event of manager.subscribe(ID)) replay.push(event);
    const text = replay
      .filter((event) => event.type === "output")
      .map((event) => event.text)
      .join("");
    expect(text).toContain("[secret]");
    expect(text).toContain("[workspace]");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(text).not.toContain(running.worktree);
    await manager.close();
  });

  it("bounds unterminated output lines and reports runtime expiry distinctly", async () => {
    const paths = await directories();
    const lineTest = harness();
    lineTest.catalog.resolve.mockResolvedValue({
      cwd: paths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const lineManager = createTaskManager({
      ...lineTest,
      defer: (callback) => lineTest.deferred.push(callback),
      lineLimit: 64,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    await lineManager.start(input());
    lineTest.deferred.shift()();
    await waitFor(lineManager, "running");
    await vi.waitFor(() => expect(lineTest.spawn).toHaveBeenCalledOnce());
    lineTest.child.stdout.write("x".repeat(65));
    lineTest.child.emit("close", null, "SIGTERM");
    await expect(waitFor(lineManager, "failed")).resolves.toMatchObject({
      error: "Claude Code exceeded the per-line output limit.",
    });
    await lineManager.close();

    const runtimePaths = await directories();
    const runtimeTest = harness();
    runtimeTest.catalog.resolve.mockResolvedValue({
      cwd: runtimePaths.source,
      origin: "https://github.com/owner/repo",
      repository: "owner/repo",
    });
    const runtimeManager = createTaskManager({
      ...runtimeTest,
      defer: (callback) => runtimeTest.deferred.push(callback),
      killGrace: 5,
      runtime: 5,
      stateRoot: runtimePaths.stateRoot,
      worktreeRoot: runtimePaths.worktreeRoot,
    });
    await runtimeManager.start(input());
    runtimeTest.deferred.shift()();
    await waitFor(runtimeManager, "running");
    await vi.waitFor(() => expect(runtimeTest.spawn).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 8));
    runtimeTest.child.emit("close", null, "SIGTERM");
    await expect(waitFor(runtimeManager, "failed")).resolves.toMatchObject({
      error: "Claude Code exceeded the runtime limit.",
    });
    await runtimeManager.close();
  });

  it("recovers persisted active tasks as failed without deleting their artifacts", async () => {
    const paths = await directories();
    const worktree = join(paths.worktreeRoot, "preserved");
    await mkdir(paths.stateRoot, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const canonicalWorktree = await realpath(worktree);
    const createdAt = "2026-07-22T00:00:00.000Z";
    await writeFile(
      join(paths.stateRoot, `${ID}.json`),
      JSON.stringify({
        version: 1,
        input: {
          ...input(),
          agent: undefined,
          title: "Add the compact task launcher and test it.",
        },
        task: {
          ...input(),
          agent: undefined,
          branch: "puller/task-12345678",
          createdAt,
          phase: "running",
          pullRequest: {
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
          },
          title: "Add the compact task launcher and test it.",
          updatedAt: createdAt,
          worktree,
        },
        events: [],
      }),
    );
    const manager = createTaskManager({
      catalog: { options: vi.fn(), resolve: vi.fn() },
      now: () => new Date("2026-07-22T01:00:00.000Z"),
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    expect(manager.list()).toEqual([
      expect.objectContaining({
        agent: "claude",
        id: ID,
        phase: "failed",
        error: "The server restarted before this task completed.",
        pullRequest: {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
        },
        worktree: canonicalWorktree,
      }),
    ]);
    await expect(stat(worktree)).resolves.toBeDefined();
    await manager.close();
  });

  it("round-trips a persisted version 2 Codex task", async () => {
    const paths = await directories();
    await mkdir(paths.stateRoot, { recursive: true });
    const createdAt = "2026-07-22T00:00:00.000Z";
    const persistedInput = {
      ...input({ agent: "codex" }),
      title: "Add the compact task launcher and test it.",
    };
    await writeFile(
      join(paths.stateRoot, `${ID}.json`),
      JSON.stringify({
        version: 2,
        input: persistedInput,
        task: {
          agent: "codex",
          base: persistedInput.base,
          createdAt,
          id: persistedInput.id,
          phase: "completed",
          repository: persistedInput.repository,
          title: persistedInput.title,
          updatedAt: createdAt,
        },
        events: [],
      }),
    );
    const manager = createTaskManager({
      catalog: { options: vi.fn(), resolve: vi.fn() },
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });
    expect(manager.list()).toEqual([
      expect.objectContaining({
        agent: "codex",
        id: ID,
        phase: "completed",
      }),
    ]);
    await manager.close();
  });

  it("boundedly reconciles an interrupted PR opening by exact marker and head", async () => {
    const paths = await directories();
    const worktree = join(paths.worktreeRoot, "recover-pr");
    await mkdir(paths.stateRoot, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const canonicalWorktree = await realpath(worktree);
    const createdAt = "2026-07-22T00:00:00.000Z";
    const branch = "puller/task-12345678";
    await writeFile(
      join(paths.stateRoot, `${ID}.json`),
      JSON.stringify({
        version: 1,
        input: {
          ...input(),
          title: "Add the compact task launcher and test it.",
        },
        task: {
          ...input(),
          branch,
          createdAt,
          headRefOid: OID,
          phase: "opening-pr",
          title: "Add the compact task launcher and test it.",
          updatedAt: createdAt,
          worktree: canonicalWorktree,
        },
        events: [],
      }),
    );
    let resolvePull;
    const pull = new Promise((resolveValue) => {
      resolvePull = resolveValue;
    });
    const run = vi.fn(async (executable, args, options) => {
      expect(executable).toBe("gh");
      expect(args).toContain("list");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return pull;
    });
    const pullResult = {
      stdout: JSON.stringify([
        {
          baseRefName: "main",
          body: `<!-- puller-task:${ID} -->`,
          headRefName: branch,
          headRefOid: OID,
          isCrossRepository: false,
          isDraft: true,
          number: 42,
          state: "OPEN",
          url: "https://github.com/owner/repo/pull/42",
        },
      ]),
      stderr: "",
    };
    const manager = createTaskManager({
      catalog: { options: vi.fn(), resolve: vi.fn() },
      now: () => new Date("2026-07-22T01:00:00.000Z"),
      recoveryTimeout: 100,
      run,
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    expect(manager.list()).toEqual([
      expect.objectContaining({
        phase: "failed",
        worktree: canonicalWorktree,
      }),
    ]);
    expect(manager.list()[0]).not.toHaveProperty("pullRequest");
    const events = [];
    const streaming = (async () => {
      for await (const event of manager.subscribe(ID)) events.push(event);
    })();
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          task: expect.objectContaining({ phase: "failed" }),
          type: "task",
        }),
      ),
    );
    resolvePull(pullResult);
    await streaming;

    const reconciled = events.filter(
      (event) => event.type === "task" && event.task.pullRequest,
    );
    expect(reconciled).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({
          pullRequest: {
            number: 42,
            url: "https://github.com/owner/repo/pull/42",
          },
        }),
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(stat(worktree)).resolves.toBeDefined();
    await manager.close();
    expect(
      JSON.parse(await readFile(join(paths.stateRoot, `${ID}.json`), "utf8")),
    ).toMatchObject({ task: { phase: "failed", pullRequest: { number: 42 } } });
  });

  it("quarantines a manifest whose persisted worktree escapes canonically", async () => {
    const paths = await directories();
    const outside = join(paths.root, "outside");
    const escape = join(paths.worktreeRoot, "escape");
    await Promise.all([
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.worktreeRoot, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(outside, escape, "dir");
    const createdAt = "2026-07-22T00:00:00.000Z";
    await writeFile(
      join(paths.stateRoot, `${ID}.json`),
      JSON.stringify({
        version: 1,
        input: {
          ...input(),
          title: "Add the compact task launcher and test it.",
        },
        task: {
          ...input(),
          branch: "puller/task-12345678",
          createdAt,
          headRefOid: OID,
          phase: "running",
          title: "Add the compact task launcher and test it.",
          updatedAt: createdAt,
          worktree: escape,
        },
        events: [],
      }),
    );
    const manager = createTaskManager({
      catalog: { options: vi.fn(), resolve: vi.fn() },
      stateRoot: paths.stateRoot,
      worktreeRoot: paths.worktreeRoot,
    });

    expect(manager.list()).toEqual([]);
    await expect(
      stat(join(paths.stateRoot, `${ID}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(paths.stateRoot, "quarantine"))).toEqual([
      expect.stringMatching(new RegExp(`^${ID}\\.json\\.`)),
    ]);
    await expect(stat(outside)).resolves.toBeDefined();
    await manager.close();
  });
});

describe("task input validation", () => {
  it("rejects traversal-shaped repositories, unsafe refs, invalid ids, and oversized prompts", () => {
    expect(() =>
      validateTaskStartInput(input({ repository: "../repo" })),
    ).toThrow();
    expect(() => validateTaskStartInput(input({ base: "--help" }))).toThrow();
    expect(() =>
      validateTaskStartInput(input({ id: "../../escape" })),
    ).toThrow();
    expect(() =>
      validateTaskStartInput(input({ prompt: "x".repeat(33 * 1024) })),
    ).toThrow();
  });
});
