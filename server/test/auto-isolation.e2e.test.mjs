import { execFile as executeFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createClaudeRunManager, createRunCoordinator } from "../claude.mjs";
import { assessPull } from "../readiness.mjs";
import { createWorkspaceResolver } from "../workspace.mjs";

const execFile = promisify(executeFile);
const BRANCH = "fix/auto";
const NUMBER = 7;
const REPOSITORY = "owner/repo";

async function git(cwd, ...arguments_) {
  return await execFile("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
}

async function head(cwd, reference = "HEAD") {
  return (await git(cwd, "rev-parse", reference)).stdout.trim().toLowerCase();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "puller-auto-isolation-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const reviews = join(root, "reviews");
  await execFile("git", ["init", "--bare", remote]);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await git(source, "config", "user.email", "fixture@example.test");
  await git(source, "config", "user.name", "Fixture");
  await writeFile(join(source, "example.js"), "export const value = 1;\n");
  await git(source, "add", "example.js");
  await git(source, "commit", "-m", "base");
  const base = await head(source);
  await git(source, "switch", "-c", BRANCH);
  await writeFile(join(source, "example.js"), "export const value = 2;\n");
  await git(source, "add", "example.js");
  await git(source, "commit", "-m", "pull request");
  const initial = await head(source);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main", BRANCH);
  await git(
    source,
    "remote",
    "set-url",
    "origin",
    `git@github.com:${REPOSITORY}.git`,
  );
  await writeFile(join(source, "example.js"), "dirty source checkout\n");
  await writeFile(join(source, "untracked.txt"), "source-only\n");

  const timeline = [];
  const transport = async (file, arguments_, options) => {
    const rewritten = [...arguments_];
    const operation = rewritten.findIndex(
      (argument) => argument === "fetch" || argument === "push",
    );
    const push = operation >= 0 && rewritten[operation] === "push";
    if (push) {
      timeline.push(rewritten.includes("--dry-run") ? "push-dry-run" : "push");
    } else if (rewritten.includes("add")) {
      timeline.push("add");
    } else if (rewritten.includes("commit")) {
      timeline.push("commit");
    }
    if (operation >= 0) {
      const origin = rewritten.indexOf("origin", operation + 1);
      if (origin >= 0) rewritten[origin] = remote;
    }
    const result = await execFile(file, rewritten, options);
    if (push && !rewritten.includes("--dry-run")) {
      const directory = rewritten[rewritten.indexOf("-C") + 1];
      const remoteHead = (
        await execFile(
          "git",
          ["--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`],
          { encoding: "utf8" },
        )
      ).stdout.trim();
      await git(
        directory,
        "update-ref",
        `refs/remotes/origin/${BRANCH}`,
        remoteHead,
      );
    }
    return result;
  };

  return {
    base,
    initial,
    remote,
    reviews,
    root,
    source,
    timeline,
    transport,
  };
}

function authorization(repository, current) {
  return {
    authored: true,
    authorLogin: "viewer",
    available: true,
    baseRefOid: repository.base,
    complete: true,
    headRefName: BRANCH,
    headRefOid: current,
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

function rawPull(repository) {
  return {
    baseRefOid: repository.base,
    ci: {
      checks: [
        {
          detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
          id: "failed-check",
          name: "Tests",
          state: "failure",
          workflow: "CI",
        },
      ],
      complete: true,
      failed: 1,
      passed: 0,
      running: 0,
      state: "failure",
      total: 1,
      unknown: 0,
    },
    comments: [
      {
        author: "greptile-apps",
        body: `Confidence Score: 5/5\nLast reviewed commit: ${repository.initial}`,
        createdAt: "2026-07-24T00:00:00Z",
        id: "greptile",
        updatedAt: "2026-07-24T00:00:00Z",
        url: `https://github.com/${REPOSITORY}/pull/${NUMBER}#issuecomment-1`,
      },
    ],
    commentsComplete: true,
    headRefOid: repository.initial,
    number: NUMBER,
    repository: REPOSITORY,
    repositoryUrl: `https://github.com/${REPOSITORY}`,
    reviewThreads: [],
    state: "OPEN",
    threadsComplete: true,
    title: "Fix the check",
    unresolvedThreads: [],
    updatedAt: "2026-07-24T00:00:00Z",
    url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
  };
}

function child() {
  const process = new EventEmitter();
  process.pid = 12_345;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn();
  return process;
}

function channel() {
  const events = [];
  return {
    events,
    value: {
      closed: () => false,
      onClose: () => () => undefined,
      onceDrain: () => () => undefined,
      write(event) {
        events.push(event);
        return true;
      },
    },
  };
}

describe("Auto workspace isolation", () => {
  it("leaves a dirty same-head source untouched while Puller publishes from an owned workspace", async () => {
    const repository = await createRepository();
    let manager;
    try {
      const sourceStatus = (
        await git(repository.source, "status", "--porcelain")
      ).stdout;
      const sourceTracked = await readFile(
        join(repository.source, "example.js"),
        "utf8",
      );
      const sourceUntracked = await readFile(
        join(repository.source, "untracked.txt"),
        "utf8",
      );
      const pull = rawPull(repository);
      const assessed = assessPull(pull, 1);
      const resolver = createWorkspaceResolver({
        environment: process.env,
        reviewRoot: repository.reviews,
        roots: [repository.root],
        run: repository.transport,
      });
      const agentProcess = child();
      const spawn = vi.fn(() => agentProcess);
      const coordinator = createRunCoordinator({ limit: 1 });
      const loadReviewAuthorization = vi.fn(async () => {
        repository.timeline.push("authorize");
        const current = (
          await execFile(
            "git",
            [
              "--git-dir",
              repository.remote,
              "rev-parse",
              `refs/heads/${BRANCH}`,
            ],
            { encoding: "utf8" },
          )
        ).stdout
          .trim()
          .toLowerCase();
        return authorization(repository, current);
      });
      manager = createClaudeRunManager({
        cache: {
          get: vi.fn(async () => ({
            notReady: [assessed],
            partial: false,
            ready: [],
            stale: false,
          })),
        },
        coordinator,
        createId: () => "auto-isolation",
        environment: {
          GH_TOKEN: "must-not-reach-agent",
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        },
        git: repository.transport,
        loadPull: vi.fn(async () => ({
          authored: true,
          available: true,
          complete: true,
          open: true,
          pull,
        })),
        loadReviewAuthorization,
        resolver,
        spawn,
      });
      const output = channel();
      const started = await manager.start(
        {
          agent: "claude",
          expectedHeadRefOid: repository.initial,
          message: "",
          number: NUMBER,
          parallelism: 1,
          repository: REPOSITORY,
          source: "auto",
          triggers: [
            {
              detailsUrl: "https://github.com/owner/repo/actions/runs/1/job/2",
              headRefOid: repository.initial,
              id: "failed-check",
              kind: "failed_check",
            },
          ],
        },
        output.value,
      );

      const [, arguments_, options] = spawn.mock.calls[0];
      expect(options.cwd).not.toBe(repository.source);
      expect(options.cwd.startsWith(await realpath(repository.reviews))).toBe(
        true,
      );
      expect(arguments_).not.toContain("--dangerously-skip-permissions");
      expect(arguments_.join(" ")).toContain("Bash(*git *)");
      expect(options.env).not.toHaveProperty("GH_TOKEN");

      await writeFile(
        join(options.cwd, "example.js"),
        "export const value = 3;\n",
      );
      agentProcess.emit("close", 0, null);
      await started.done;

      expect(output.events.at(-1)).toEqual({
        exitCode: 0,
        type: "complete",
      });
      expect(await head(repository.source)).toBe(repository.initial);
      expect(
        (await git(repository.source, "status", "--porcelain")).stdout,
      ).toBe(sourceStatus);
      expect(
        await readFile(join(repository.source, "example.js"), "utf8"),
      ).toBe(sourceTracked);
      expect(
        await readFile(join(repository.source, "untracked.txt"), "utf8"),
      ).toBe(sourceUntracked);

      const published = (
        await execFile(
          "git",
          ["--git-dir", repository.remote, "rev-parse", `refs/heads/${BRANCH}`],
          { encoding: "utf8" },
        )
      ).stdout
        .trim()
        .toLowerCase();
      expect(published).not.toBe(repository.initial);
      await expect(
        execFile(
          "git",
          [
            "--git-dir",
            repository.remote,
            "merge-base",
            "--is-ancestor",
            repository.initial,
            published,
          ],
          { encoding: "utf8" },
        ),
      ).resolves.toBeDefined();
      expect(
        (
          await execFile(
            "git",
            [
              "--git-dir",
              repository.remote,
              "show",
              "-s",
              "--format=%s",
              published,
            ],
            { encoding: "utf8" },
          )
        ).stdout.trim(),
      ).toBe("fix: address pull request blockers");
      expect(await readdir(repository.reviews)).toEqual([]);
      expect(manager.activeCount()).toBe(0);
      expect(manager.activeWorkspaceCount()).toBe(0);
      expect(coordinator.activeCount()).toBe(0);
      expect(coordinator.activeWorkspaceCount()).toBe(0);
      expect(loadReviewAuthorization).toHaveBeenCalledTimes(6);
      expect(
        repository.timeline.filter((event) =>
          ["add", "authorize", "commit", "push", "push-dry-run"].includes(
            event,
          ),
        ),
      ).toEqual([
        "authorize",
        "push-dry-run",
        "authorize",
        "authorize",
        "add",
        "authorize",
        "commit",
        "authorize",
        "push",
        "authorize",
      ]);
    } finally {
      await manager?.shutdown();
      await rm(repository.root, { force: true, recursive: true });
    }
  }, 20_000);
});
