import { homedir } from "node:os";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  GrokError,
  createGrokInvocation,
  defaultGrokSearchDirectories,
  eventsForGrokLine,
  readGrokFixture,
  resetGrokExecutableForTests,
  resolveGrokExecutable,
  runtimePath,
} from "../grok.mjs";

const roots = new Set();
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const VERSION = "grok 1.0.5 (5115b46bc909)\n";

async function root() {
  const value = await mkdtemp(join(homedir(), ".puller-grok-test-"));
  roots.add(value);
  return value;
}

async function fixture() {
  const value = await root();
  const target = join(value, "target");
  const state = join(value, "state");
  const home = join(value, "real-home");
  const binary = join(value, "grok");
  await Promise.all([
    mkdir(join(target, ".git"), { recursive: true }),
    mkdir(join(home, ".grok"), { recursive: true }),
    mkdir(state, { recursive: true }),
    writeFile(binary, "#!/bin/sh\n", { mode: 0o700 }),
  ]);
  await writeFile(join(home, ".grok", "auth.json"), "{}\n", { mode: 0o600 });
  await chmod(binary, 0o700);
  const run = async () => ({
    stderr: "",
    stdout: VERSION,
  });
  return {
    binary,
    environment: {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    run,
    state,
    target,
  };
}

afterEach(async () => {
  resetGrokExecutableForTests();
  await Promise.all(
    [...roots].map((value) => rm(value, { force: true, recursive: true })),
  );
  roots.clear();
});

describe("Grok executable discovery", () => {
  it("searches ~/.grok/bin, ~/.local/bin, Homebrew, Linuxbrew, and /usr/local/bin", () => {
    expect(defaultGrokSearchDirectories("/home/jake")).toEqual([
      "/home/jake/.grok/bin",
      "/home/jake/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
    ]);
  });

  it("includes the resolved binary directory in the host-neutral PATH fallback", () => {
    expect(runtimePath("/home/jake/.grok/bin").split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/home/jake/.grok/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
    ]);
  });

  it("uses an explicit executable path", async () => {
    const value = await fixture();
    await expect(
      resolveGrokExecutable({ path: value.binary, run: value.run }),
    ).resolves.toBe(value.binary);
  });

  it("uses GROK_PATH when no explicit executable is provided", async () => {
    const value = await fixture();
    await expect(
      resolveGrokExecutable({
        directories: [],
        environment: { GROK_PATH: value.binary, PATH: "" },
        run: value.run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("rejects a relative GROK_PATH", async () => {
    await expect(
      resolveGrokExecutable({
        directories: [],
        environment: { GROK_PATH: "grok", PATH: "" },
        run: async () => ({ stdout: VERSION }),
      }),
    ).rejects.toMatchObject({
      code: "grok_path_invalid",
      status: 500,
    });
  });

  it("discovers Grok from PATH when well-known prefixes are empty", async () => {
    const value = await fixture();
    const missing = join(value.state, "missing");
    await expect(
      resolveGrokExecutable({
        directories: [missing],
        environment: { PATH: dirname(value.binary) },
        run: value.run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("skips a wrong-version candidate and uses a later matching binary", async () => {
    const value = await fixture();
    const other = join(await root(), "grok");
    await writeFile(other, "#!/bin/sh\n", { mode: 0o700 });
    const run = async (command) => ({
      stdout: command === other ? "grok 1.0.6 (deadbeef)\n" : VERSION,
    });

    await expect(
      resolveGrokExecutable({
        directories: [dirname(other), dirname(value.binary)],
        environment: { PATH: "" },
        run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("refuses an exclusive wrong-version GROK_PATH without falling through", async () => {
    const value = await fixture();
    await expect(
      resolveGrokExecutable({
        directories: [dirname(value.binary)],
        environment: {
          GROK_PATH: value.binary,
          PATH: dirname(value.binary),
        },
        run: async () => ({ stdout: "grok 1.0.6 (deadbeef)\n" }),
      }),
    ).rejects.toMatchObject({
      code: "grok_version_unsupported",
      status: 503,
    });
  });

  it("reports a missing exclusive path without assuming Homebrew", async () => {
    const value = await fixture();
    const missing = join(value.state, "grok");
    await expect(
      resolveGrokExecutable({
        path: missing,
        run: value.run,
      }),
    ).rejects.toMatchObject({
      code: "grok_unavailable",
      message: `Grok 1.0.5 is not available at ${missing}.`,
      status: 503,
    });
  });

  it("explains how to install or set GROK_PATH when nothing matches", async () => {
    await expect(
      resolveGrokExecutable({
        directories: [],
        environment: { PATH: "" },
        run: async () => ({ stdout: VERSION }),
      }),
    ).rejects.toMatchObject({
      code: "grok_unavailable",
      message:
        "Grok 1.0.5 is not available. Install the audited Grok CLI or set GROK_PATH to its executable.",
      status: 503,
    });
  });

  it("refuses a swapped binary until the process restarts", async () => {
    const value = await fixture();
    await expect(
      resolveGrokExecutable({ path: value.binary, run: value.run }),
    ).resolves.toBe(value.binary);
    await writeFile(value.binary, "#!/bin/sh\necho swapped\n", { mode: 0o700 });
    await expect(
      resolveGrokExecutable({ path: value.binary, run: value.run }),
    ).rejects.toMatchObject({
      code: "grok_changed",
      status: 503,
    });
  });

  it("lets createGrokInvocation discover Grok through GROK_PATH", async () => {
    const value = await fixture();
    const invocation = await createGrokInvocation({
      environment: {
        ...value.environment,
        GROK_PATH: value.binary,
        PATH: undefined,
      },
      prompt: "Fix the pull request.",
      purpose: "fix",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });
    expect(invocation.command).toBe(value.binary);
    expect(invocation.environment.PATH.split(":")).toEqual(
      expect.arrayContaining([
        "/usr/bin",
        "/bin",
        dirname(value.binary),
        "/usr/local/bin",
        "/home/linuxbrew/.linuxbrew/bin",
      ]),
    );
    await invocation.cleanup();
  });
});

describe("Grok invocation", () => {
  it("builds a streaming headless profile without a bypass flag", async () => {
    const value = await fixture();
    const invocation = await createGrokInvocation({
      environment: value.environment,
      executable: value.binary,
      prompt: "Fix the pull request.",
      purpose: "fix",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });

    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "streaming-json",
        "--sandbox",
        "puller-edit",
        "--disable-web-search",
        "--no-subagents",
        "--no-plan",
        "--always-approve",
      ]),
    );
    expect(invocation.args).toContain("Bash(git *)");
    expect(invocation.args.join(" ")).toContain("web_search,web_fetch");
    expect(invocation.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(invocation.prompt).toContain(invocation.target);
    expect(invocation.cwd).toBe(invocation.target);
    expect(invocation.environment).not.toHaveProperty("GH_TOKEN");
    expect(invocation.environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(invocation.environment).not.toHaveProperty("XAI_API_KEY");
    expect(invocation.environment.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(invocation.environment.GROK_MEMORY).toBe("0");
    expect(invocation.sandbox).toContain('extends = "strict"');
    expect(await readdir(invocation.environment.GROK_HOME)).toEqual(
      expect.arrayContaining(["auth.json", "sandbox.toml"]),
    );
    await invocation.cleanup();
    await invocation.cleanup();
  });

  it("lets New Task load repository instructions from the worktree", async () => {
    const value = await fixture();
    const invocation = await createGrokInvocation({
      environment: value.environment,
      executable: value.binary,
      newTask: true,
      prompt: "Implement the task.",
      purpose: "task",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });

    expect(invocation.cwd).toBe(invocation.target);
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("puller-edit");
    await invocation.cleanup();
  });

  it("rejects an unsupported Grok version", async () => {
    const value = await fixture();
    await expect(
      createGrokInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: async () => ({ stdout: "grok 1.0.6 (deadbeef)\n" }),
        stateRoot: value.state,
        target: value.target,
      }),
    ).rejects.toMatchObject({
      code: "grok_version_unsupported",
      status: 503,
    });
  });

  it("requires isolated authentication", async () => {
    const value = await fixture();
    await rm(join(value.environment.HOME, ".grok", "auth.json"));
    await expect(
      createGrokInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: value.run,
        stateRoot: value.state,
        target: value.target,
      }),
    ).rejects.toBeInstanceOf(GrokError);
  });

  it("rejects control state that overlaps the target or a Git worktree", async () => {
    const value = await fixture();
    const nested = join(value.target, "control");
    await expect(
      createGrokInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: value.run,
        stateRoot: nested,
        target: value.target,
      }),
    ).rejects.toMatchObject({
      code: "grok_state_insecure",
    });
    await expect(stat(nested)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("includes explicit denied paths in a conflict profile", async () => {
    const value = await fixture();
    const denied = join(value.target, "protected");
    const mirror = join(value.state, "mirror");
    await Promise.all([mkdir(denied), mkdir(mirror)]);
    const invocation = await createGrokInvocation({
      deniedPaths: [denied],
      environment: value.environment,
      executable: value.binary,
      prompt: "Resolve the conflict.",
      purpose: "conflict",
      run: value.run,
      stateRoot: join(value.state, "agents"),
      target: mirror,
    });
    expect(invocation.args).toContain("puller-conflict");
    expect(invocation.sandbox).toContain(denied);
    await invocation.cleanup();
  });

  it("refuses additional writable paths for every agent purpose", async () => {
    const value = await fixture();
    await expect(
      createGrokInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: value.run,
        stateRoot: value.state,
        target: value.target,
        writablePaths: [dirname(value.target)],
      }),
    ).rejects.toThrow("cannot receive additional writable paths");
  });

  it("uses the read-only verification profile and read-only tools", async () => {
    const value = await fixture();
    const snapshot = join(dirname(value.target), "snapshot");
    await mkdir(snapshot);
    const invocation = await createGrokInvocation({
      deniedPaths: [snapshot],
      environment: value.environment,
      executable: value.binary,
      prompt: "Exercise the released behavior.",
      purpose: "verification",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        "--sandbox",
        "puller-read",
        "--tools",
        "read_file,grep,list_dir",
        "--permission-mode",
        "dontAsk",
      ]),
    );
    expect(invocation.args).not.toContain("--always-approve");
    expect(invocation.sandbox).toContain('extends = "read-only"');
    expect(invocation.sandbox).toContain(snapshot);
    expect(invocation.prompt).toContain("immutable release snapshot");
    expect(invocation.prompt).toContain("<puller-verification-memory>");
    await invocation.cleanup();
  });

  it("refuses to clean a replaced runtime directory", async () => {
    const value = await fixture();
    const invocation = await createGrokInvocation({
      environment: value.environment,
      executable: value.binary,
      prompt: "Fix the pull request.",
      purpose: "fix",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });
    const runRoot = dirname(invocation.environment.HOME);
    await rm(runRoot, { force: true, recursive: true });
    await mkdir(runRoot, { mode: 0o700 });
    await expect(invocation.cleanup()).rejects.toMatchObject({
      code: "grok_cleanup_unsafe",
    });
  });
});

describe("Grok streaming JSON", () => {
  it("replays the committed success and error fixtures", async () => {
    const success = (
      await readGrokFixture(join(FIXTURES, "grok-success.jsonl"))
    )
      .trim()
      .split("\n")
      .flatMap((line) => eventsForGrokLine(line));
    expect(success).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "started", type: "tool" }),
        expect.objectContaining({ status: "completed", type: "tool" }),
        {
          type: "text",
          text: "Implemented and verified the change.",
        },
        { status: "completed", type: "protocol" },
      ]),
    );

    const failure = (await readGrokFixture(join(FIXTURES, "grok-error.jsonl")))
      .trim()
      .split("\n")
      .flatMap((line) => eventsForGrokLine(line));
    expect(failure.filter((event) => event.type === "error")).toHaveLength(2);
    expect(failure).not.toContainEqual(
      expect.objectContaining({ type: "protocol" }),
    );
    expect(failure[0]).toEqual({
      message: "You have no weighted tokens left",
      type: "error",
    });
  });

  it("normalizes successful text and tool events", () => {
    expect(eventsForGrokLine('{"type":"text","data":"done"}')).toEqual([
      { type: "text", text: "done" },
    ]);
    expect(
      eventsForGrokLine(
        '{"type":"tool_call_update","toolName":"run_terminal_cmd","status":"completed","rawOutput":"ok"}',
      ),
    ).toEqual([
      { name: "run_terminal_cmd", status: "completed", type: "tool" },
      { text: "ok", type: "diagnostic" },
    ]);
    expect(eventsForGrokLine('{"type":"end","stopReason":"end_turn"}')).toEqual(
      [{ status: "completed", type: "protocol" }],
    );
  });

  it("surfaces real failure text", () => {
    expect(
      eventsForGrokLine('{"type":"error","message":"quota exceeded"}'),
    ).toEqual([{ message: "quota exceeded", type: "error" }]);
  });

  it("bounds malformed and unknown input safely", () => {
    expect(eventsForGrokLine("{")).toEqual([
      { text: "Grok emitted an unreadable event.", type: "diagnostic" },
    ]);
    expect(eventsForGrokLine('{"type":"future.event"}')).toEqual([]);
  });
});
