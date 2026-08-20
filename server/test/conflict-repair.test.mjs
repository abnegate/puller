import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createRunCoordinator } from "../claude.mjs";
import {
  buildConflictRepairPrompt,
  conflictRepairArguments,
  conflictRepairEnvironment,
  createConflictRepairManager,
  validateConflictFiles,
  validateConflictRepairInput,
} from "../conflict-repair.mjs";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const BASE = "1234567890abcdef1234567890abcdef12345678";
const NEXT_BASE = "234567890abcdef1234567890abcdef123456789";
const COMMIT = "34567890abcdef1234567890abcdef1234567890";
const CONFLICT_FILE = "/private/tmp/puller-conflict-checkout/src/a.js";
const input = {
  agent: "claude",
  baseRefName: "main",
  expectedBaseRefOid: BASE,
  expectedHeadRefOid: HEAD,
  headRefName: "feature",
  headRepository: "owner/repo",
  isCrossRepository: false,
  maintainerCanModify: true,
  number: 7,
  repository: "owner/repo",
};

function pull(baseRefOid = BASE, overrides = {}) {
  return {
    baseRefName: "main",
    baseRefOid,
    headRefName: "feature",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: "owner/repo" },
    headRepositoryOwner: { login: "owner" },
    isCrossRepository: false,
    maintainerCanModify: true,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    number: 7,
    repository: "owner/repo",
    state: "OPEN",
    statusCheckRollup: [
      { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
    url: "https://github.com/owner/repo/pull/7",
    ...overrides,
  };
}

function authoredPull(overrides = {}) {
  const value = pull(BASE, overrides);
  return {
    ...value,
    authored: true,
    available: true,
    complete: true,
    open: true,
    pull: value,
    viewerLogin: "viewer",
  };
}

function child() {
  const value = new EventEmitter();
  value.pid = 987_654;
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = vi.fn();
  const end = value.stdin.end.bind(value.stdin);
  value.stdin.end = vi.fn((...argumentsList) => {
    const result = end(...argumentsList);
    queueMicrotask(() => value.emit("close", 0, null));
    return result;
  });
  return value;
}

function commandRunner({ base = BASE, unresolvedAfterClaude = false } = {}) {
  const calls = [];
  let conflictReads = 0;
  const run = vi.fn(async (file, argumentsList) => {
    calls.push([file, ...argumentsList]);
    const args = argumentsList.slice(2);
    if (args[0] === "merge") {
      const error = new Error("conflict");
      error.code = 1;
      error.stdout = "";
      error.stderr = "CONFLICT";
      throw error;
    }
    if (args[0] === "diff" && args.includes("--diff-filter=U")) {
      conflictReads += 1;
      return {
        stderr: "",
        stdout:
          conflictReads === 1 || unresolvedAfterClaude ? "src/a.js\0" : "",
      };
    }
    if (args[0] === "rev-parse" && args[1] === "refs/puller/head^{commit}") {
      return { stderr: "", stdout: `${HEAD}\n` };
    }
    if (args[0] === "rev-parse" && args[1] === "refs/puller/base^{commit}") {
      return { stderr: "", stdout: `${base}\n` };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stderr: "", stdout: `${COMMIT}\n` };
    }
    return { stderr: "", stdout: "" };
  });
  return { calls, run };
}

async function waitFor(manager, id, states) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = manager.get(id);
    if (states.includes(value?.state)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Repair did not reach the expected state.");
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not become true.");
}

function observation() {
  const events = [];
  let close;
  return {
    close: () => close?.(),
    events,
    value: {
      closed: () => false,
      onClose(listener) {
        close = listener;
        return () => {
          if (close === listener) close = null;
        };
      },
      write(event) {
        events.push(event);
        return true;
      },
    },
  };
}

function context(overrides = {}) {
  const commands = overrides.commands ?? commandRunner();
  const spawned = overrides.child ?? child();
  const inspectPull = overrides.inspectPull ?? vi.fn(async () => pull());
  const executor = overrides.executor ?? { json: vi.fn(), rest: vi.fn() };
  const kill = overrides.kill ?? vi.fn();
  const states = [];
  const removed = [];
  const validateFiles =
    overrides.validateFiles ?? vi.fn(async () => [CONFLICT_FILE]);
  const spawn = overrides.spawn ?? vi.fn(() => spawned);
  const manager = createConflictRepairManager({
    coordinator: overrides.coordinator ?? createRunCoordinator({ limit: 2 }),
    createId: () => "repair-1",
    createToken: () => "A".repeat(43),
    createTemporary: (prefix) => mkdtemp(prefix),
    executor,
    ...(overrides.defaultInspectAccess
      ? {}
      : {
          inspectAccess:
            overrides.inspectAccess ??
            vi.fn(async () => ({ permissions: { push: true } })),
        }),
    inspectPull,
    loadPull: overrides.loadPull ?? vi.fn(async () => authoredPull()),
    maximumBaseRestarts: overrides.maximumBaseRestarts ?? 1,
    kill,
    killGrace: overrides.killGrace ?? 10,
    lineLimit: overrides.lineLimit ?? 1024 * 1024,
    outputLimit: overrides.outputLimit ?? 8 * 1024 * 1024,
    ...(overrides.environment ? { environment: overrides.environment } : {}),
    onState: (event) => states.push(event),
    removeTemporary: async (path) => {
      removed.push(path);
      await rm(path, { force: true, recursive: true });
    },
    run: commands.run,
    runtime: overrides.runtime ?? 30 * 60 * 1_000,
    setTimer: overrides.setTimer ?? setTimeout,
    clearTimer: overrides.clearTimer ?? clearTimeout,
    spawn,
    validateFiles,
    ...(overrides.prepareCodex ? { prepareCodex: overrides.prepareCodex } : {}),
    ...(overrides.prepareGrok ? { prepareGrok: overrides.prepareGrok } : {}),
    ...(overrides.stateRoot ? { stateRoot: overrides.stateRoot } : {}),
  });
  return {
    commands,
    executor,
    inspectPull,
    kill,
    manager,
    removed,
    spawn,
    spawned,
    states,
    validateFiles,
  };
}

describe("conflict repair policy", () => {
  it("validates exact same-repository identity and refuses forks before queueing", () => {
    expect(validateConflictRepairInput(input)).toEqual({
      agent: "claude",
      baseRefName: "main",
      expectedBaseRefOid: BASE,
      expectedHeadRefOid: HEAD,
      headRefName: "feature",
      number: 7,
      repository: "owner/repo",
    });
    expect(() =>
      validateConflictRepairInput({
        ...input,
        headRepository: "contributor/repo",
        isCrossRepository: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "fork_unsupported" }));
  });

  it("limits Claude to exact validated conflict files without broad reads, Bash, Git, or network tools", () => {
    const environment = {
      HOME: "/Users/example",
      PATH: "/usr/bin",
      SECRET_TOKEN: "secret",
    };
    const args = conflictRepairArguments(
      "/private/tmp/puller-conflict-checkout",
      "/private/tmp/puller-conflict-runtime",
      [CONFLICT_FILE],
      environment,
    );
    expect(args.slice(0, 5)).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    expect(args.filter((argument) => argument === "--verbose")).toHaveLength(1);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      `Read(${CONFLICT_FILE}),Edit(${CONFLICT_FILE})`,
    );
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("./**");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash,Write");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.sandbox).toMatchObject({
      allowUnsandboxedCommands: false,
      enabled: true,
      failIfUnavailable: true,
      network: { allowedDomains: [], deniedDomains: ["*"] },
    });
    expect(settings.sandbox.filesystem.allowWrite).toEqual([
      "/private/tmp/puller-conflict-runtime",
      CONFLICT_FILE,
    ]);
    expect(settings.sandbox.credentials.files).toContainEqual({
      mode: "deny",
      path: "/Users/example",
    });
    expect(settings.sandbox.credentials.envVars).toContainEqual({
      mode: "deny",
      name: "SECRET_TOKEN",
    });
    expect(buildConflictRepairPrompt(input, ["src/a.js"])).toContain(
      "exact listed conflicted files",
    );
    expect(() =>
      conflictRepairArguments("/checkout", "/runtime", ["relative.js"]),
    ).toThrow("Validated conflict repair paths");
    expect(() =>
      conflictRepairArguments("/checkout", "/runtime", ["/tmp/unsafe,file.js"]),
    ).toThrow("Validated conflict repair paths");
  });

  it("uses an isolated HOME and omits inherited credentials and config", () => {
    expect(
      conflictRepairEnvironment(
        {
          ANTHROPIC_API_KEY: "secret",
          CLAUDE_CONFIG_DIR: "/Users/example/.claude",
          GH_TOKEN: "secret",
          HOME: "/Users/example",
          PATH: "/usr/bin",
        },
        "/private/tmp/puller-conflict-runtime",
      ),
    ).toEqual({
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      CLAUDE_CONFIG_DIR: "/private/tmp/puller-conflict-runtime/claude",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      ENABLE_TOOL_SEARCH: "false",
      HOME: "/private/tmp/puller-conflict-runtime/home",
      PATH: "/usr/bin",
      TEMP: "/private/tmp/puller-conflict-runtime",
      TMP: "/private/tmp/puller-conflict-runtime",
      TMPDIR: "/private/tmp/puller-conflict-runtime",
      XDG_CACHE_HOME: "/private/tmp/puller-conflict-runtime/cache",
      XDG_CONFIG_HOME: "/private/tmp/puller-conflict-runtime/config",
      XDG_DATA_HOME: "/private/tmp/puller-conflict-runtime/data",
    });
  });

  it("rejects a conflicted file symlinked to a host secret", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "puller-conflict-path-"));
    const checkout = join(temporary, "checkout");
    const secret = join(temporary, "host-secret");
    try {
      await mkdir(join(checkout, "src"), { recursive: true });
      await writeFile(secret, "host credential");
      await symlink(secret, join(checkout, "src", "a.js"));
      await expect(
        validateConflictFiles(checkout, ["src/a.js"]),
      ).rejects.toMatchObject({ code: "unsafe_conflict" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  it("rejects a symlink in a conflicted file path component", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "puller-conflict-path-"));
    const checkout = join(temporary, "checkout");
    const outside = join(temporary, "outside");
    try {
      await mkdir(checkout);
      await mkdir(outside);
      await writeFile(join(outside, "a.js"), "host credential");
      await symlink(outside, join(checkout, "src"));
      await expect(
        validateConflictFiles(checkout, ["src/a.js"]),
      ).rejects.toMatchObject({ code: "unsafe_conflict" });
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  it("accepts only canonical regular conflicted files", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "puller-conflict-path-"));
    const checkout = join(temporary, "checkout");
    try {
      await mkdir(join(checkout, "src"), { recursive: true });
      await writeFile(join(checkout, "src", "a.js"), "conflict");
      const canonical = await realpath(join(checkout, "src", "a.js"));
      await expect(
        validateConflictFiles(checkout, ["src/a.js"]),
      ).resolves.toEqual([canonical]);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});

describe("conflict repair manager", () => {
  it("runs Codex against a non-Git mirror and stages resolved files before checking the index", async () => {
    const root = await mkdtemp(join(homedir(), ".puller-conflict-test-"));
    let staged = false;
    let committed = false;
    let committedContent = "";
    const calls = [];
    const run = vi.fn(async (file, argumentsList) => {
      calls.push([file, ...argumentsList]);
      const cwd = argumentsList[1];
      if (argumentsList.includes("checkout")) {
        const path = join(cwd, "src", "a.js");
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(
          path,
          "<<<<<<< HEAD\nhead\n=======\nbase\n>>>>>>> base\n",
        );
      }
      if (argumentsList.includes("merge")) {
        const error = new Error("conflict");
        error.code = 1;
        throw error;
      }
      if (argumentsList.includes("rev-parse")) {
        const reference = argumentsList.at(-1);
        if (reference === "refs/puller/base^{commit}") {
          return { stderr: "", stdout: `${BASE}\n` };
        }
        if (reference === "refs/puller/head^{commit}") {
          return { stderr: "", stdout: `${HEAD}\n` };
        }
        return {
          stderr: "",
          stdout: `${committed ? COMMIT : HEAD}\n`,
        };
      }
      if (
        argumentsList.includes("diff") &&
        argumentsList.includes("--diff-filter=U")
      ) {
        return {
          stderr: "",
          stdout: staged ? "" : "src/a.js\0",
        };
      }
      if (
        argumentsList.includes("add") &&
        argumentsList.includes("--") &&
        argumentsList.includes("src/a.js")
      ) {
        staged = true;
      }
      if (argumentsList.includes("commit")) {
        committed = true;
        committedContent = await readFile(join(cwd, "src", "a.js"), "utf8");
      }
      return { stderr: "", stdout: "" };
    });
    const spawned = child();
    let mirror;
    const cleanup = vi.fn(async () => undefined);
    const prepareCodex = vi.fn(async (options) => {
      mirror = options.target;
      expect(options.deniedPaths).toHaveLength(1);
      expect(await readdir(mirror)).toEqual(["src"]);
      return {
        args: ["exec", "--json", "-"],
        cleanup,
        command: "/opt/homebrew/bin/codex",
        cwd: join(root, "control"),
        environment: {},
        prompt: "trusted conflict prompt",
      };
    });
    spawned.stdin.end = vi.fn(() => {
      void writeFile(join(mirror, "src", "a.js"), "head\nbase\n").then(() => {
        spawned.stderr.write(
          `token=ghp_abcdefghijklmnop ${join(root, "secret")}\n`,
        );
        spawned.stdout.write(
          '{"type":"item.completed","item":{"type":"agent_message","text":"Resolved."}}\n',
        );
        spawned.stdout.write('{"type":"turn.completed"}\n');
        spawned.stdout.end();
        spawned.stderr.end();
        spawned.emit("close", 0, null);
      });
    });
    const manager = createConflictRepairManager({
      coordinator: createRunCoordinator({ limit: 1 }),
      createId: () => "repair-codex",
      createToken: () => "C".repeat(43),
      executor: { json: vi.fn(), rest: vi.fn() },
      inspectAccess: vi.fn(async () => ({ permissions: { push: true } })),
      inspectPull: vi.fn(async () => pull()),
      loadPull: vi.fn(async () => authoredPull()),
      prepareCodex,
      removeTemporary: (path) => rm(path, { force: true, recursive: true }),
      run,
      spawn: vi.fn(() => spawned),
      stateRoot: root,
    });
    try {
      const queued = manager.enqueue({ ...input, agent: "codex" });
      await waitFor(manager, queued.id, ["ready", "conflict", "failed"]);
      const observed = observation();
      await manager.watch(
        {
          id: queued.id,
          number: 7,
          repository: "owner/repo",
          token: queued.token,
        },
        observed.value,
      );
      expect(observed.events[0]).toMatchObject({ state: "ready" });
      expect(queued.agent).toBe("codex");
      expect(committedContent).toBe("head\nbase\n");
      const addIndex = calls.findIndex(
        (call) =>
          call.includes("add") &&
          call.includes("--") &&
          call.includes("src/a.js"),
      );
      const postAddCheck = calls.findIndex(
        (call, index) =>
          index > addIndex &&
          call.includes("diff") &&
          call.includes("--diff-filter=U"),
      );
      expect(addIndex).toBeGreaterThan(-1);
      expect(postAddCheck).toBeGreaterThan(addIndex);
      expect(
        calls.some(
          (call) =>
            call.includes("push") &&
            call.includes(`${COMMIT}:refs/heads/feature`),
        ),
      ).toBe(true);
      expect(observed.events[0].agent).toBe("codex");
      expect(observed.events[0].output).toContain("[secret]");
      expect(observed.events[0].output).not.toContain(root);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await manager.shutdown();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets Grok edit a disposable conflict mirror while Puller copies back and publishes", async () => {
    const root = await mkdtemp(join(homedir(), ".puller-conflict-test-"));
    let staged = false;
    let committed = false;
    let committedContent = "";
    const run = vi.fn(async (file, argumentsList) => {
      const cwd = argumentsList[1];
      if (argumentsList.includes("checkout")) {
        const path = join(cwd, "src", "a.js");
        await mkdir(join(cwd, "src"), { recursive: true });
        await writeFile(
          path,
          "<<<<<<< HEAD\nhead\n=======\nbase\n>>>>>>> base\n",
        );
      }
      if (argumentsList.includes("merge")) {
        const error = new Error("conflict");
        error.code = 1;
        throw error;
      }
      if (argumentsList.includes("rev-parse")) {
        const reference = argumentsList.at(-1);
        if (reference === "refs/puller/base^{commit}") {
          return { stderr: "", stdout: `${BASE}\n` };
        }
        if (reference === "refs/puller/head^{commit}") {
          return { stderr: "", stdout: `${HEAD}\n` };
        }
        return {
          stderr: "",
          stdout: `${committed ? COMMIT : HEAD}\n`,
        };
      }
      if (
        argumentsList.includes("diff") &&
        argumentsList.includes("--diff-filter=U")
      ) {
        return {
          stderr: "",
          stdout: staged ? "" : "src/a.js\0",
        };
      }
      if (
        argumentsList.includes("add") &&
        argumentsList.includes("--") &&
        argumentsList.includes("src/a.js")
      ) {
        staged = true;
      }
      if (argumentsList.includes("commit")) {
        committed = true;
        committedContent = await readFile(join(cwd, "src", "a.js"), "utf8");
      }
      return { stderr: "", stdout: "" };
    });
    const spawned = child();
    let mirror;
    const cleanup = vi.fn(async () => undefined);
    const prepareGrok = vi.fn(async (options) => {
      mirror = options.target;
      expect(options.deniedPaths).toHaveLength(1);
      expect(await readdir(mirror)).toEqual(["src"]);
      return {
        args: [
          "-p",
          "trusted conflict prompt",
          "--output-format",
          "streaming-json",
        ],
        cleanup,
        command: "/Users/test/.grok/bin/grok",
        cwd: mirror,
        environment: {},
        prompt: "trusted conflict prompt",
      };
    });
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        void writeFile(join(mirror, "src", "a.js"), "head\nbase\n").then(() => {
          spawned.stdout.write('{"type":"text","data":"Resolved."}\n');
          spawned.stdout.write('{"type":"end","stopReason":"end_turn"}\n');
          spawned.stdout.end();
          spawned.stderr.end();
          spawned.emit("close", 0, null);
        });
      });
      return spawned;
    });
    const manager = createConflictRepairManager({
      coordinator: createRunCoordinator({ limit: 1 }),
      createId: () => "repair-grok",
      createToken: () => "G".repeat(43),
      executor: { json: vi.fn(), rest: vi.fn() },
      inspectAccess: vi.fn(async () => ({ permissions: { push: true } })),
      inspectPull: vi.fn(async () => pull()),
      loadPull: vi.fn(async () => authoredPull()),
      prepareGrok,
      removeTemporary: (path) => rm(path, { force: true, recursive: true }),
      run,
      spawn,
      stateRoot: root,
    });
    try {
      const queued = manager.enqueue({ ...input, agent: "grok" });
      await waitFor(manager, queued.id, ["ready", "conflict", "failed"]);
      const observed = observation();
      await manager.watch(
        {
          id: queued.id,
          number: 7,
          repository: "owner/repo",
          token: queued.token,
        },
        observed.value,
      );
      expect(observed.events[0]).toMatchObject({ state: "ready" });
      expect(queued.agent).toBe("grok");
      expect(committedContent).toBe("head\nbase\n");
      expect(observed.events[0].agent).toBe("grok");
      expect(observed.events[0].output).toContain("Grok started.");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        "/Users/test/.grok/bin/grok",
        expect.arrayContaining(["-p", "--output-format", "streaming-json"]),
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      await manager.shutdown();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("escalates Codex conflict cancellation from SIGINT through SIGTERM to SIGKILL", async () => {
    const root = await mkdtemp(join(homedir(), ".puller-conflict-test-"));
    const spawned = child();
    spawned.stdin.end = vi.fn();
    const timers = [];
    const kill = vi.fn((_pid, signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => spawned.emit("close", null, "SIGKILL"));
      }
    });
    const cleanup = vi.fn(async () => undefined);
    const prepareCodex = vi.fn(async () => ({
      args: ["exec", "--json", "-"],
      cleanup,
      command: "/opt/homebrew/bin/codex",
      cwd: join(root, "control"),
      environment: {},
      prompt: "trusted conflict prompt",
    }));
    const validateFiles = vi.fn(async (checkout, conflictFiles) => {
      const path = join(checkout, conflictFiles[0]);
      try {
        return [await realpath(path)];
      } catch {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          "<<<<<<< HEAD\nhead\n=======\nbase\n>>>>>>> base\n",
        );
        return [await realpath(path)];
      }
    });
    const value = context({
      child: spawned,
      clearTimer: vi.fn((timer) => {
        if (timer) timer.cleared = true;
      }),
      kill,
      killGrace: 5,
      prepareCodex,
      setTimer(callback, delay) {
        const timer = { callback, cleared: false, delay, unref: vi.fn() };
        timers.push(timer);
        return timer;
      },
      stateRoot: root,
      validateFiles,
    });
    try {
      const queued = value.manager.enqueue({ ...input, agent: "codex" });
      await waitUntil(() => spawned.stdin.end.mock.calls.length === 1);

      expect(value.manager.cancel(queued.id)).toBe(true);
      await waitUntil(() => kill.mock.calls.length === 1);
      expect(kill.mock.calls.map(([, signal]) => signal)).toEqual(["SIGINT"]);
      timers.findLast((timer) => timer.delay === 5).callback();
      expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
        "SIGINT",
        "SIGTERM",
      ]);
      timers.findLast((timer) => timer.delay === 5).callback();
      await waitFor(value.manager, queued.id, ["cancelled"]);
      expect(kill.mock.calls.map(([, signal]) => signal)).toEqual([
        "SIGINT",
        "SIGTERM",
        "SIGKILL",
      ]);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await value.manager.shutdown();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("deduplicates atomically, resolves in isolation, validates again, and only pushes the head", async () => {
    const value = context();
    const first = value.manager.enqueue(input);
    const duplicate = value.manager.enqueue(input);

    expect(first).toEqual({
      accepted: true,
      agent: "claude",
      deduplicated: false,
      id: "repair-1",
      state: "repair_queued",
      token: "A".repeat(43),
    });
    expect(duplicate).toEqual({
      accepted: true,
      agent: "claude",
      deduplicated: true,
      id: "repair-1",
      state: "repair_queued",
      token: "A".repeat(43),
    });
    await waitFor(value.manager, first.id, ["ready"]);

    expect(value.states.map((event) => event.state)).toEqual([
      "repair_queued",
      "repair_running",
      "ready",
    ]);
    expect(value.inspectPull).toHaveBeenCalledTimes(2);
    expect(value.commands.calls).toContainEqual([
      "git",
      "-C",
      expect.any(String),
      "fetch",
      "--no-tags",
      "origin",
      "+refs/pull/7/head:refs/puller/head",
      "+refs/heads/main:refs/puller/base",
    ]);
    const pushes = value.commands.calls.filter((call) => call[3] === "push");
    expect(pushes).toEqual([
      [
        "git",
        "-C",
        expect.any(String),
        "push",
        "origin",
        `${COMMIT}:refs/heads/feature`,
      ],
    ]);
    expect(pushes[0].join(" ")).not.toContain("refs/heads/main");
    expect(pushes[0].join(" ")).not.toContain("--force");
    expect(value.removed.length).toBeGreaterThanOrEqual(2);
  });

  it("spawns from an isolated session with no inherited HOME, credentials, or config and cleans it", async () => {
    const value = context({
      environment: {
        ANTHROPIC_API_KEY: "secret",
        CLAUDE_CONFIG_DIR: "/Users/example/.claude",
        GH_TOKEN: "secret",
        HOME: "/Users/example",
        PATH: "/usr/bin",
      },
    });
    const queued = value.manager.enqueue(input);

    await waitFor(value.manager, queued.id, ["ready"]);

    const arguments_ = value.spawn.mock.calls[0][1];
    const options = value.spawn.mock.calls[0][2];
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
    expect(options.cwd).toBe(join(options.env.TMPDIR, "session"));
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("GH_TOKEN");
    expect(options.env.HOME).toBe(join(options.env.TMPDIR, "home"));
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(
      join(options.env.TMPDIR, "claude"),
    );
    expect(value.removed).toContain(options.env.TMPDIR);
  });

  it("fails closed when a validated conflict file is swapped to a host symlink after Claude edits", async () => {
    const external = await mkdtemp(join(tmpdir(), "puller-host-secret-"));
    const secret = join(external, "credential");
    const spawned = child();
    let checkout;
    let validation = 0;
    const validateFiles = vi.fn(async (root, paths) => {
      checkout = root;
      validation += 1;
      if (validation === 1) {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src", "a.js"), "conflict");
      }
      return validateConflictFiles(root, paths);
    });
    spawned.stdin.end = vi.fn(() => {
      void (async () => {
        const target = join(checkout, "src", "a.js");
        await rm(target, { force: true });
        await symlink(secret, target);
        spawned.stdout.end();
        spawned.emit("close", 0, null);
      })();
    });
    try {
      await writeFile(secret, "host credential");
      const value = context({ child: spawned, validateFiles });
      const queued = value.manager.enqueue(input);

      await waitFor(value.manager, queued.id, ["failed"]);

      expect(validateFiles).toHaveBeenCalledTimes(2);
      expect(value.commands.calls.some((call) => call[3] === "add")).toBe(
        false,
      );
      expect(value.commands.calls.some((call) => call[3] === "push")).toBe(
        false,
      );
    } finally {
      await rm(external, { force: true, recursive: true });
    }
  });

  it("revalidates authored membership before cloning and immediately before pushing", async () => {
    const loadPull = vi
      .fn()
      .mockResolvedValueOnce(authoredPull())
      .mockResolvedValueOnce({ ...authoredPull(), authored: false });
    const value = context({ loadPull });
    const queued = value.manager.enqueue(input);

    await waitFor(value.manager, queued.id, ["failed"]);

    expect(loadPull).toHaveBeenCalledTimes(2);
    expect(value.commands.calls.some((call) => call[3] === "push")).toBe(false);
  });

  it("refuses an unauthored pull before fetching or spawning", async () => {
    const commands = commandRunner();
    const value = context({
      commands,
      loadPull: vi.fn(async () => ({ ...authoredPull(), authored: false })),
    });
    const queued = value.manager.enqueue(input);

    await waitFor(value.manager, queued.id, ["failed"]);

    expect(commands.run).not.toHaveBeenCalled();
    expect(value.inspectPull).not.toHaveBeenCalled();
  });

  it("fails closed on stale identity before fetching or spawning", async () => {
    const commands = commandRunner();
    const value = context({
      commands,
      inspectPull: vi.fn(async () => pull(BASE, { headRefOid: NEXT_BASE })),
    });
    const queued = value.manager.enqueue(input);
    await waitFor(value.manager, queued.id, ["failed"]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("bounds base churn and cleans each abandoned checkout without pushing", async () => {
    const commands = commandRunner();
    const inspectPull = vi
      .fn()
      .mockResolvedValueOnce(pull(BASE))
      .mockResolvedValueOnce(pull(NEXT_BASE));
    const value = context({ commands, inspectPull, maximumBaseRestarts: 0 });
    const queued = value.manager.enqueue(input);
    await waitFor(value.manager, queued.id, ["conflict"]);
    expect(commands.calls.some((call) => call[3] === "push")).toBe(false);
    expect(value.removed.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses lost push permission during both initial and pre-push checks", async () => {
    const inspectAccess = vi
      .fn()
      .mockResolvedValueOnce({ permissions: { push: true } })
      .mockResolvedValueOnce({ permissions: { push: false } });
    const value = context({ inspectAccess });
    const queued = value.manager.enqueue(input);
    await waitFor(value.manager, queued.id, ["failed"]);
    expect(value.commands.calls.some((call) => call[3] === "push")).toBe(false);
    expect(inspectAccess).toHaveBeenCalledTimes(2);
  });

  it("uses the executor REST contract and validates repository permission responses by default", async () => {
    const rest = vi.fn(async (_endpoint, options) => {
      expect(options.validate({ permissions: { push: true } })).toBe(true);
      expect(options.validate({ permissions: { push: "yes" } })).toBe(false);
      expect(options.validate({})).toBe(false);
      return { permissions: { push: true } };
    });
    const value = context({
      defaultInspectAccess: true,
      executor: { json: vi.fn(), rest },
    });
    const queued = value.manager.enqueue(input);

    await waitFor(value.manager, queued.id, ["ready"]);

    expect(rest).toHaveBeenCalledTimes(2);
    for (const call of rest.mock.calls) {
      expect(call[0]).toBe("repos/owner/repo");
      expect(call[1]).toMatchObject({
        method: "GET",
        validate: expect.any(Function),
      });
    }
  });

  it("shares the coordinator and reports queued work without exceeding active capacity", async () => {
    let release;
    const scheduler = {
      reserveQueued: vi.fn(async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          release: vi.fn(),
          reserveWorkspace: vi.fn(),
          releaseWorkspace: vi.fn(),
        };
      }),
    };
    const value = context({ coordinator: scheduler });
    const queued = value.manager.enqueue(input);
    expect(queued.state).toBe("repair_queued");
    expect(value.manager.get(queued.id)?.state).toBe("repair_queued");
    expect(scheduler.reserveQueued).toHaveBeenCalledOnce();
    value.manager.cancel(queued.id);
    release();
    await waitFor(value.manager, queued.id, ["cancelled"]);
  });

  it("replays an exact snapshot, streams live states, and keeps disconnects observational", async () => {
    let release;
    const coordinator = {
      reserveQueued: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                release: vi.fn(),
                releaseWorkspace: vi.fn(),
                reserveWorkspace: vi.fn(),
              });
          }),
      ),
    };
    const value = context({ coordinator });
    const queued = value.manager.enqueue(input);
    const output = observation();
    await value.manager.watch(
      {
        id: queued.id,
        number: 7,
        repository: "owner/repo",
        token: queued.token,
      },
      output.value,
    );

    expect(output.events).toEqual([
      expect.objectContaining({
        actionId: "repair-1",
        headRefOid: HEAD,
        output: "",
        state: "repair_queued",
        terminal: false,
        type: "snapshot",
      }),
    ]);
    output.close();
    release();
    await waitFor(value.manager, queued.id, ["ready"]);
    expect(output.events).toHaveLength(1);

    const replay = observation();
    await value.manager.watch(
      {
        id: queued.id,
        number: 7,
        repository: "owner/repo",
        token: queued.token,
      },
      replay.value,
    );
    expect(replay.events).toEqual([
      expect.objectContaining({
        commit: COMMIT,
        state: "ready",
        terminal: true,
        type: "snapshot",
      }),
    ]);
  });

  it("fails observation closed for unknown, foreign, stale-head, or invalid-token actions", async () => {
    const stale = vi.fn(async () => authoredPull({ headRefOid: NEXT_BASE }));
    const value = context({ loadPull: stale });
    const queued = value.manager.enqueue(input);
    const base = {
      id: queued.id,
      number: 7,
      repository: "owner/repo",
      token: queued.token,
    };

    await expect(
      value.manager.watch(base, observation().value),
    ).rejects.toMatchObject({
      code: "repair_not_found",
      status: 404,
    });
    await expect(
      value.manager.watch(
        { ...base, repository: "other/repo" },
        observation().value,
      ),
    ).rejects.toMatchObject({ code: "repair_not_found" });
    await expect(
      value.manager.watch(
        { ...base, token: "B".repeat(43) },
        observation().value,
      ),
    ).rejects.toMatchObject({ code: "repair_not_found" });
    await expect(
      value.manager.watch({ ...base, id: "unknown" }, observation().value),
    ).rejects.toMatchObject({ code: "repair_not_found" });
  });

  it("authenticates cancellation and returns a token-free terminal snapshot", async () => {
    const coordinator = {
      reserveQueued: vi.fn(
        (_options, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("cancelled"), { name: "AbortError" }),
                ),
              { once: true },
            );
          }),
      ),
    };
    const value = context({ coordinator });
    const queued = value.manager.enqueue(input);
    const result = await value.manager.cancelObserved({
      id: queued.id,
      number: 7,
      repository: "owner/repo",
      token: queued.token,
    });

    expect(result).toMatchObject({
      actionId: queued.id,
      state: "cancelled",
      terminal: true,
      type: "snapshot",
    });
    expect(result).not.toHaveProperty("token");
  });

  it("retains bounded redacted Claude output without exposing control characters", async () => {
    const spawned = child();
    spawned.stdin.end = vi.fn(() => {
      spawned.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "token=ghp_super_secret123456 \u001b[31m<script>\nsecond",
            },
          },
        })}\n`,
      );
      spawned.stdout.end();
      queueMicrotask(() => spawned.emit("close", 0, null));
    });
    const commands = commandRunner();
    const manager = createConflictRepairManager({
      coordinator: createRunCoordinator({ limit: 2 }),
      createId: () => "repair-1",
      createToken: () => "A".repeat(43),
      createTemporary: (prefix) => mkdtemp(prefix),
      executor: { json: vi.fn(), rest: vi.fn() },
      inspectAccess: vi.fn(async () => ({ permissions: { push: true } })),
      inspectPull: vi.fn(async () => pull()),
      loadPull: vi.fn(async () => authoredPull()),
      redactionDelay: 1,
      removeTemporary: (path) => rm(path, { force: true, recursive: true }),
      retainedOutputLimit: 128,
      run: commands.run,
      spawn: vi.fn(() => spawned),
      validateFiles: vi.fn(async () => [CONFLICT_FILE]),
    });
    const queued = manager.enqueue(input);
    await waitFor(manager, queued.id, ["ready"]);
    const output = observation();
    await manager.watch(
      {
        id: queued.id,
        number: 7,
        repository: "owner/repo",
        token: queued.token,
      },
      output.value,
    );
    const text = output.events[0].output;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(128);
    expect(text).toContain("[secret]");
    expect(text).toContain("<script>\nsecond");
    expect(text).not.toContain("ghp_super_secret");
    expect(text).not.toContain("\u001b");
  });

  it("accepts an Edit path only after incrementally assembling its streamed JSON input", async () => {
    const spawned = child();
    spawned.stdin.end = vi.fn(() => {
      for (const event of [
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", name: "Edit", input: {} },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"file_' },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: `path":"${CONFLICT_FILE}"}`,
            },
          },
        },
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        },
      ]) {
        spawned.stdout.write(`${JSON.stringify(event)}\n`);
      }
      spawned.stdout.end();
      queueMicrotask(() => spawned.emit("close", 0, null));
    });
    const value = context({ child: spawned });
    const queued = value.manager.enqueue(input);

    await waitFor(value.manager, queued.id, ["ready"]);

    expect(spawned.stdin.end).toHaveBeenCalledOnce();
    expect(value.kill).not.toHaveBeenCalled();
  });

  it.each([
    [
      "malformed stream JSON",
      (value) => value.spawned.stdout.write("not-json\n"),
      "failed",
    ],
    [
      "a Claude error event",
      (value) =>
        value.spawned.stdout.write(
          '{"type":"result","subtype":"error","is_error":true}\n',
        ),
      "failed",
    ],
    [
      "an oversized stream line",
      (value) => value.spawned.stdout.write("12345"),
      "failed",
      { lineLimit: 4 },
    ],
    [
      "excess total output",
      (value) => value.spawned.stdout.write("12345"),
      "failed",
      { outputLimit: 4 },
    ],
    ["runtime expiry", () => undefined, "failed", { runtime: 5 }],
    ["cancellation", (value, id) => value.manager.cancel(id), "cancelled"],
    [
      "child process error",
      (value) => value.spawned.emit("error", new Error("boom")),
      "failed",
    ],
  ])(
    "terminates, reaps, and releases capacity after %s",
    async (_name, trigger, state, limits = {}) => {
      const coordinator = createRunCoordinator({ limit: 1 });
      const spawned = child();
      spawned.stdin.end = vi.fn();
      const kill = vi.fn((_pid, signal) => {
        if (signal === "SIGKILL")
          queueMicrotask(() => spawned.emit("close", null, "SIGKILL"));
      });
      const value = context({
        child: spawned,
        coordinator,
        kill,
        killGrace: 5,
        ...limits,
      });
      const queued = value.manager.enqueue(input);
      await waitUntil(() => spawned.stdin.end.mock.calls.length === 1);

      trigger(value, queued.id);
      await waitFor(value.manager, queued.id, [state]);
      await waitUntil(() => coordinator.activeCount() === 0);

      expect(kill).toHaveBeenCalledWith(-987_654, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-987_654, "SIGKILL");
      expect(coordinator.activeWorkspaceCount()).toBe(0);
      expect(value.removed.length).toBeGreaterThanOrEqual(2);
    },
  );
});
