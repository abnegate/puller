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
  CodexError,
  createCodexInvocation,
  defaultCodexSearchDirectories,
  eventsForCodexLine,
  readCodexFixture,
  resetCodexExecutableForTests,
  resolveCodexExecutable,
  runtimePath,
} from "../codex.mjs";

const roots = new Set();
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function root() {
  const value = await mkdtemp(join(homedir(), ".puller-codex-test-"));
  roots.add(value);
  return value;
}

async function fixture() {
  const value = await root();
  const target = join(value, "target");
  const state = join(value, "state");
  const home = join(value, "real-home");
  const binary = join(value, "codex");
  await Promise.all([
    mkdir(join(target, ".git"), { recursive: true }),
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(state, { recursive: true }),
    writeFile(binary, "#!/bin/sh\n", { mode: 0o700 }),
  ]);
  await writeFile(join(home, ".codex", "auth.json"), "{}\n", { mode: 0o600 });
  await chmod(binary, 0o700);
  const run = async () => ({
    stderr: "",
    stdout: "codex-cli-exec 0.144.6\n",
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
  resetCodexExecutableForTests();
  await Promise.all(
    [...roots].map((value) => rm(value, { force: true, recursive: true })),
  );
  roots.clear();
});

describe("Codex executable discovery", () => {
  it("searches Homebrew, Linuxbrew, /usr/local/bin, and ~/.local/bin", () => {
    expect(defaultCodexSearchDirectories("/home/jake")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/home/jake/.local/bin",
    ]);
  });

  it("includes the resolved binary directory in the host-neutral PATH fallback", () => {
    expect(runtimePath("/home/jake/.local/bin").split(":")).toEqual([
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/home/jake/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
    ]);
  });

  it("uses an explicit executable path", async () => {
    const value = await fixture();
    await expect(
      resolveCodexExecutable({ path: value.binary, run: value.run }),
    ).resolves.toBe(value.binary);
  });

  it("uses CODEX_PATH when no explicit executable is provided", async () => {
    const value = await fixture();
    await expect(
      resolveCodexExecutable({
        directories: [],
        environment: { CODEX_PATH: value.binary, PATH: "" },
        run: value.run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("rejects a relative CODEX_PATH", async () => {
    await expect(
      resolveCodexExecutable({
        directories: [],
        environment: { CODEX_PATH: "codex", PATH: "" },
        run: async () => ({ stdout: "codex-cli-exec 0.144.6\n" }),
      }),
    ).rejects.toMatchObject({
      code: "codex_path_invalid",
      status: 500,
    });
  });

  it("discovers Codex from PATH when well-known prefixes are empty", async () => {
    const value = await fixture();
    const missing = join(value.state, "missing");
    await expect(
      resolveCodexExecutable({
        directories: [missing],
        environment: { PATH: dirname(value.binary) },
        run: value.run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("skips a wrong-version candidate and uses a later matching binary", async () => {
    const value = await fixture();
    const other = join(await root(), "codex");
    await writeFile(other, "#!/bin/sh\n", { mode: 0o700 });
    const run = async (command) => ({
      stdout:
        command === other
          ? "codex-cli-exec 0.145.0\n"
          : "codex-cli-exec 0.144.6\n",
    });

    await expect(
      resolveCodexExecutable({
        directories: [dirname(other), dirname(value.binary)],
        environment: { PATH: "" },
        run,
      }),
    ).resolves.toBe(value.binary);
  });

  it("refuses an exclusive wrong-version CODEX_PATH without falling through", async () => {
    const value = await fixture();
    await expect(
      resolveCodexExecutable({
        directories: [dirname(value.binary)],
        environment: {
          CODEX_PATH: value.binary,
          PATH: dirname(value.binary),
        },
        run: async () => ({ stdout: "codex-cli-exec 0.145.0\n" }),
      }),
    ).rejects.toMatchObject({
      code: "codex_version_unsupported",
      status: 503,
    });
  });

  it("reports a missing exclusive path without assuming Homebrew", async () => {
    const value = await fixture();
    const missing = join(value.state, "codex");
    await expect(
      resolveCodexExecutable({
        path: missing,
        run: value.run,
      }),
    ).rejects.toMatchObject({
      code: "codex_unavailable",
      message: `Codex 0.144.6 is not available at ${missing}.`,
      status: 503,
    });
  });

  it("explains how to install or set CODEX_PATH when nothing matches", async () => {
    await expect(
      resolveCodexExecutable({
        directories: [],
        environment: { PATH: "" },
        run: async () => ({ stdout: "codex-cli-exec 0.144.6\n" }),
      }),
    ).rejects.toMatchObject({
      code: "codex_unavailable",
      message:
        "Codex 0.144.6 is not available. Install the audited Codex CLI or set CODEX_PATH to its executable.",
      status: 503,
    });
  });

  it("lets createCodexInvocation discover Codex through CODEX_PATH", async () => {
    const value = await fixture();
    const invocation = await createCodexInvocation({
      environment: {
        ...value.environment,
        CODEX_PATH: value.binary,
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

describe("Codex invocation", () => {
  it("builds the strict non-repository edit profile without shorthand or bypass", async () => {
    const value = await fixture();
    const invocation = await createCodexInvocation({
      environment: value.environment,
      executable: value.binary,
      prompt: "Fix the pull request.",
      purpose: "fix",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });

    expect(invocation.args).toContain("--strict-config");
    expect(invocation.args).toContain("--skip-git-repo-check");
    expect(invocation.args).toContain("project_doc_max_bytes=0");
    expect(invocation.args).toContain("project_root_markers=[]");
    expect(invocation.args).toContain('web_search="disabled"');
    expect(invocation.args).toContain(
      "skills={bundled={enabled=false},include_instructions=false}",
    );
    for (const feature of [
      "plugins",
      "apps",
      "remote_plugin",
      "hooks",
      "browser_use",
      "computer_use",
      "in_app_browser",
      "multi_agent",
    ]) {
      expect(invocation.args).toContain(feature);
    }
    expect(invocation.args.join(" ")).toContain(
      'default_permissions="puller-edit"',
    );
    expect(invocation.args.join(" ")).toContain(`${invocation.target}/.git`);
    expect(invocation.args).not.toContain("-s");
    expect(invocation.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(invocation.prompt).toContain(invocation.target);
    expect(invocation.cwd).not.toBe(invocation.target);
    expect((await stat(invocation.cwd)).mode & 0o777).toBe(0o700);
    expect((await stat(value.state)).mode & 0o777).toBe(0o700);
    expect(invocation.cwd.startsWith(value.state)).toBe(true);
    expect(invocation.environment).not.toHaveProperty("GH_TOKEN");
    expect(invocation.environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(await readdir(invocation.environment.CODEX_HOME)).toEqual([
      "auth.json",
    ]);
    await invocation.cleanup();
    await invocation.cleanup();
  });

  it("lets New Task load repository instructions but keeps the named profile", async () => {
    const value = await fixture();
    const invocation = await createCodexInvocation({
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
    expect(invocation.args).not.toContain("project_doc_max_bytes=0");
    expect(invocation.args).not.toContain("project_root_markers=[]");
    expect(invocation.args).not.toContain("--skip-git-repo-check");
    await invocation.cleanup();
  });

  it("rejects an unsupported Codex version", async () => {
    const value = await fixture();
    await expect(
      createCodexInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: async () => ({ stdout: "codex-cli-exec 0.145.0\n" }),
        stateRoot: value.state,
        target: value.target,
      }),
    ).rejects.toMatchObject({
      code: "codex_version_unsupported",
      status: 503,
    });
  });

  it("requires isolated authentication", async () => {
    const value = await fixture();
    await rm(join(value.environment.HOME, ".codex", "auth.json"));
    await expect(
      createCodexInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: value.run,
        stateRoot: value.state,
        target: value.target,
      }),
    ).rejects.toBeInstanceOf(CodexError);
  });

  it("rejects control state that overlaps the target or a Git worktree", async () => {
    const value = await fixture();
    const nested = join(value.target, "control");
    await expect(
      createCodexInvocation({
        environment: value.environment,
        executable: value.binary,
        prompt: "Fix the pull request.",
        purpose: "fix",
        run: value.run,
        stateRoot: nested,
        target: value.target,
      }),
    ).rejects.toMatchObject({
      code: "codex_state_insecure",
    });
    await expect(stat(nested)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("includes explicit denied paths in a conflict profile", async () => {
    const value = await fixture();
    const denied = join(value.target, "protected");
    const mirror = join(value.state, "mirror");
    await Promise.all([mkdir(denied), mkdir(mirror)]);
    const invocation = await createCodexInvocation({
      deniedPaths: [denied],
      environment: value.environment,
      executable: value.binary,
      prompt: "Resolve the conflict.",
      purpose: "conflict",
      run: value.run,
      stateRoot: join(value.state, "agents"),
      target: mirror,
    });
    expect(invocation.args.join(" ")).toContain(
      `${JSON.stringify(denied)}="deny"`,
    );
    await invocation.cleanup();
  });

  it("refuses additional writable paths for every agent purpose", async () => {
    const value = await fixture();
    await expect(
      createCodexInvocation({
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

  it("uses the read-only verification profile while denying unrelated snapshots", async () => {
    const value = await fixture();
    const snapshot = join(dirname(value.target), "snapshot");
    const predecessor = join(dirname(value.target), "predecessor");
    await Promise.all([mkdir(snapshot), mkdir(predecessor)]);
    const invocation = await createCodexInvocation({
      deniedPaths: [snapshot],
      environment: value.environment,
      executable: value.binary,
      prompt: "Exercise the released behavior.",
      purpose: "verification",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });
    const configuration = invocation.args.join(" ");
    expect(configuration).toContain('default_permissions="puller-read"');
    expect(configuration).toContain("--disable shell_tool");
    expect(configuration).toContain("--disable unified_exec");
    expect(configuration).toContain("--disable code_mode_host");
    expect(configuration).toContain(
      `${JSON.stringify(invocation.target)}="read"`,
    );
    expect(configuration).toContain(`${JSON.stringify(snapshot)}="deny"`);
    expect(configuration).not.toContain(
      `${JSON.stringify(predecessor)}="write"`,
    );
    expect(configuration).toContain("network={enabled=false}");
    if (process.platform === "darwin") {
      expect(configuration).toContain('"/System/Library/OpenSSL"="read"');
    }
    expect(invocation.prompt).toContain("immutable release snapshot");
    expect(invocation.prompt).toContain("no command or filesystem tools");
    expect(invocation.prompt).toContain("<puller-verification-memory>");
    await invocation.cleanup();
  });

  it("refuses to clean a replaced runtime directory", async () => {
    const value = await fixture();
    const invocation = await createCodexInvocation({
      environment: value.environment,
      executable: value.binary,
      prompt: "Fix the pull request.",
      purpose: "fix",
      run: value.run,
      stateRoot: value.state,
      target: value.target,
    });
    const runRoot = dirname(invocation.cwd);
    await rm(runRoot, { force: true, recursive: true });
    await mkdir(runRoot, { mode: 0o700 });
    await expect(invocation.cleanup()).rejects.toMatchObject({
      code: "codex_cleanup_unsafe",
    });
  });
});

describe("Codex JSONL", () => {
  it("replays the committed success and quota fixtures", async () => {
    const success = (
      await readCodexFixture(join(FIXTURES, "codex-success.jsonl"))
    )
      .trim()
      .split("\n")
      .flatMap((line) => eventsForCodexLine(line));
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

    const quota = (await readCodexFixture(join(FIXTURES, "codex-quota.jsonl")))
      .trim()
      .split("\n")
      .flatMap((line) => eventsForCodexLine(line));
    expect(quota.filter((event) => event.type === "error")).toHaveLength(2);
    expect(quota).not.toContainEqual(
      expect.objectContaining({ type: "protocol" }),
    );
  });

  it("normalizes successful agent and command events", () => {
    expect(
      eventsForCodexLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      ),
    ).toEqual([{ type: "text", text: "done" }]);
    expect(
      eventsForCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
      ),
    ).toEqual([
      { name: "npm test", status: "completed", type: "tool" },
      { text: "ok", type: "diagnostic" },
    ]);
    expect(eventsForCodexLine('{"type":"turn.completed"}')).toEqual([
      { status: "completed", type: "protocol" },
    ]);
  });

  it("treats inner item errors as diagnostics", () => {
    expect(
      eventsForCodexLine(
        '{"type":"item.completed","item":{"type":"error","message":"lag"}}',
      ),
    ).toEqual([{ text: "lag", type: "diagnostic" }]);
  });

  it.each([
    '{"type":"error","message":"quota"}',
    '{"type":"turn.failed","error":{"message":"failed"}}',
  ])("treats terminal failure events as fatal", (line) => {
    expect(eventsForCodexLine(line)).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
  });

  it("tags Codex quota failures as rate limits", () => {
    expect(
      eventsForCodexLine(
        '{"type":"turn.failed","error":{"message":"You have no weighted tokens left"}}',
      ),
    ).toEqual([
      {
        code: "rate_limit",
        message: "You have no weighted tokens left",
        type: "error",
      },
    ]);
  });

  it("bounds malformed and unknown input safely", () => {
    expect(eventsForCodexLine("{")).toEqual([
      { text: "Codex emitted an unreadable event.", type: "diagnostic" },
    ]);
    expect(eventsForCodexLine('{"type":"future.event"}')).toEqual([]);
  });
});
