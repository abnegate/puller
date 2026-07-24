import { execFile as executeFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { reviewClaudeArguments, reviewClaudeEnvironment } from "../claude.mjs";

const execFile = promisify(executeFile);
const enabled = process.env.PULLER_CLAUDE_SMOKE === "1";
const roots = [];

async function git(cwd, ...arguments_) {
  return await execFile("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
}

async function head(cwd, reference = "HEAD") {
  return (await git(cwd, "rev-parse", reference)).stdout.trim().toLowerCase();
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe.skipIf(!enabled)("installed Claude review command", () => {
  it("accepts the production arguments, emits a successful stream, and leaves Git untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-claude-smoke-"));
    roots.push(root);
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    const temporary = join(root, "temporary");
    await mkdir(repository);
    await mkdir(temporary);
    await execFile("git", ["init", "--bare", remote]);
    await execFile("git", ["init", "--initial-branch=main", repository]);
    await git(repository, "config", "user.email", "smoke@example.test");
    await git(repository, "config", "user.name", "Puller Smoke");
    await writeFile(
      join(repository, "README.md"),
      "# Puller Claude argument smoke test\n",
    );
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "smoke fixture");
    await git(repository, "remote", "add", "origin", remote);
    await git(repository, "push", "origin", "HEAD:refs/heads/main");

    const initialHead = await head(repository);
    const initialRemote = await head(remote, "refs/heads/main");
    const initialOrigin = (
      await git(repository, "remote", "get-url", "origin")
    ).stdout.trim();
    const prompt = [
      "This is a local command-line compatibility smoke test.",
      "Do not call tools, inspect the repository, read files, write files, execute commands, or change Git state.",
      "Reply with exactly PULLER_CLAUDE_SMOKE_OK and nothing else.",
    ].join(" ");
    const arguments_ = reviewClaudeArguments(prompt);
    const environment = reviewClaudeEnvironment(process.env, temporary);

    const result = await execFile("claude", arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: environment,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    });
    const events = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const terminal = events.findLast((event) => event.type === "result");
    const text = events
      .filter(
        (event) =>
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta",
      )
      .map((event) => event.event.delta.text)
      .join("");

    expect(events[0]).toMatchObject({ subtype: "init", type: "system" });
    expect(terminal).toMatchObject({ is_error: false, subtype: "success" });
    expect(text).toContain("PULLER_CLAUDE_SMOKE_OK");
    expect(
      events.some(
        (event) =>
          event.type === "stream_event" &&
          event.event?.type === "content_block_start" &&
          event.event.content_block?.type === "tool_use",
      ),
    ).toBe(false);
    expect(await head(repository)).toBe(initialHead);
    expect((await git(repository, "status", "--porcelain=v1")).stdout).toBe("");
    expect(
      (await git(repository, "remote", "get-url", "origin")).stdout.trim(),
    ).toBe(initialOrigin);
    expect(await head(remote, "refs/heads/main")).toBe(initialRemote);
  }, 240_000);
});
