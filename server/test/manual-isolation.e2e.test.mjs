import { execFile as executeFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeRunManager } from "../claude.mjs";
import { assessPull } from "../readiness.mjs";
import { createWorkspaceResolver } from "../workspace.mjs";
import { removeTrackedFixtures } from "./fixtures.mjs";

const execFile = promisify(executeFile);
const ORIGIN = "git@github.com:owner/repo.git";
const REPOSITORY = "owner/repo";
const NUMBER = 92;
const BRANCH = "fix/http";
const fixtures = new Set();

async function git(cwd, ...arguments_) {
  return await execFile("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

async function head(cwd, reference = "HEAD") {
  return (await git(cwd, "rev-parse", "--verify", reference)).stdout
    .trim()
    .toLowerCase();
}

async function branch(cwd) {
  return (
    await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
  ).stdout.trim();
}

async function status(cwd) {
  return (await git(cwd, "status", "--porcelain=v1", "--untracked-files=all"))
    .stdout;
}

async function checkoutProof(cwd, tracked, untracked) {
  return {
    branch: await branch(cwd),
    head: await head(cwd),
    status: await status(cwd),
    tracked: await readFile(join(cwd, tracked)),
    untracked: await readFile(join(cwd, untracked)),
  };
}

function child() {
  const process = new EventEmitter();
  process.pid = 73_001;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn();
  return process;
}

function channel() {
  const events = [];
  return {
    events,
    write(event) {
      events.push(event);
      return true;
    },
    onceDrain() {
      return () => undefined;
    },
    onClose() {
      return () => undefined;
    },
    closed: () => false,
  };
}

function rawPull({ base, current }) {
  return {
    baseRefOid: base,
    ci: {
      checks: [
        {
          detailsUrl: null,
          id: "check-1",
          name: "CI",
          state: "success",
          workflow: "CI",
        },
      ],
      complete: true,
      failed: 0,
      inProgress: 0,
      passed: 1,
      queued: 0,
      running: 0,
      state: "success",
      total: 1,
      unknown: 0,
    },
    comments: [
      {
        author: "greptile-apps",
        body: `Confidence Score: 4/5\nLast reviewed commit: ${current}`,
        createdAt: "2026-07-27T00:00:00Z",
        updatedAt: "2026-07-27T00:00:00Z",
        url: `https://github.com/${REPOSITORY}/pull/${NUMBER}#issuecomment-1`,
      },
    ],
    commentsComplete: true,
    headRefOid: current,
    number: NUMBER,
    repository: REPOSITORY,
    repositoryUrl: `https://github.com/${REPOSITORY}`,
    reviewThreads: [{ id: "thread-1", isResolved: false }],
    state: "OPEN",
    threadsComplete: true,
    title: "Keep the original exception",
    unresolvedThreads: [
      {
        author: "reviewer",
        body: "Preserve the original exception.",
        createdAt: "2026-07-27T00:00:00Z",
        id: "thread-1",
        line: 1,
        outdated: false,
        path: "feature.txt",
        url: `https://github.com/${REPOSITORY}/pull/${NUMBER}#discussion_r1`,
      },
    ],
    updatedAt: "2026-07-27T00:00:00Z",
    url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
  };
}

function authorization({ base, remote }) {
  return {
    authored: true,
    authorLogin: "owner",
    available: true,
    baseRefOid: base,
    complete: true,
    headRefName: BRANCH,
    headRefOid: remote,
    headRepository: REPOSITORY,
    isCrossRepository: false,
    number: NUMBER,
    open: true,
    repository: REPOSITORY,
    state: "OPEN",
    url: `https://github.com/${REPOSITORY}/pull/${NUMBER}`,
    viewerLogin: "owner",
    viewerPermission: "WRITE",
  };
}

function localRemoteRunner(remote, calls) {
  const rewrite = `url.${pathToFileURL(remote).href}.insteadOf=${ORIGIN}`;
  return async (command, arguments_, options) => {
    const argumentsCopy = [...arguments_];
    const network = argumentsCopy.findIndex(
      (argument) => argument === "fetch" || argument === "push",
    );
    if (network !== -1) {
      argumentsCopy.splice(network, 0, "-c", rewrite);
    }
    calls.push({
      arguments: [...arguments_],
      network: network === -1 ? null : arguments_[network],
    });
    return await execFile(command, argumentsCopy, options);
  };
}

afterEach(async () => {
  await removeTrackedFixtures(fixtures);
});

describe("manual Run fix isolation", () => {
  it("publishes from a fresh owned workspace without touching dirty user checkouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-manual-isolation-"));
    fixtures.add(root);
    const repositories = join(root, "repositories");
    const primary = join(repositories, "repo");
    const dirtyHead = join(repositories, "repo-pr-copy");
    const remote = join(root, "remote.git");
    const reviews = join(root, "reviews");
    const home = join(root, "home");
    await mkdir(repositories);
    await mkdir(home);
    await execFile("git", ["init", "--bare", remote]);
    await execFile("git", ["init", "--initial-branch=main", primary]);
    await git(primary, "config", "user.email", "fixture@example.test");
    await git(primary, "config", "user.name", "Puller Fixture");
    await writeFile(join(primary, "README.md"), "base\n");
    await git(primary, "add", "README.md");
    await git(primary, "commit", "-m", "base");
    const base = await head(primary);
    await git(primary, "push", remote, "HEAD:refs/heads/main");
    await execFile("git", [
      "--git-dir",
      remote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);

    await git(primary, "switch", "-c", BRANCH);
    await writeFile(join(primary, "feature.txt"), "pull request\n");
    await git(primary, "add", "feature.txt");
    await git(primary, "commit", "-m", "pull request");
    const submitted = await head(primary);
    await git(primary, "push", remote, `HEAD:refs/heads/${BRANCH}`);
    await git(primary, "remote", "add", "origin", ORIGIN);

    await git(primary, "switch", "-c", "local/experiment", "main");
    await appendFile(join(primary, "README.md"), "primary sentinel\n");
    await writeFile(join(primary, "primary.untracked"), "primary bytes\n");
    await git(
      primary,
      "worktree",
      "add",
      "-b",
      "local/pr-copy",
      dirtyHead,
      submitted,
    );
    await appendFile(join(dirtyHead, "feature.txt"), "linked sentinel\n");
    await writeFile(join(dirtyHead, "linked.untracked"), "linked bytes\n");

    const primaryBefore = await checkoutProof(
      primary,
      "README.md",
      "primary.untracked",
    );
    const dirtyBefore = await checkoutProof(
      dirtyHead,
      "feature.txt",
      "linked.untracked",
    );
    const raw = rawPull({ base, current: submitted });
    const cached = assessPull(raw, 1);
    const cache = {
      get: vi.fn(async () => ({
        notReady: [cached],
        partial: false,
        ready: [],
        stale: false,
      })),
    };
    const loadPull = vi.fn(async () => ({
      authored: true,
      available: true,
      complete: true,
      headRefOid: submitted,
      open: true,
      pull: raw,
    }));
    const loadReviewAuthorization = vi.fn(async () =>
      authorization({
        base,
        remote: await head(remote, `refs/heads/${BRANCH}`),
      }),
    );
    const calls = [];
    const runGit = localRemoteRunner(remote, calls);
    const actualResolver = createWorkspaceResolver({
      environment: {
        HOME: home,
        LANG: "C",
        PATH: process.env.PATH,
        USER: "fixture",
      },
      reviewRoot: reviews,
      roots: [repositories],
      run: runGit,
    });
    const legacyResolve = vi.fn(() => {
      throw new Error("Manual Run fix reused the legacy worktree resolver.");
    });
    const resolver = {
      clear: actualResolver.clear,
      resolve: legacyResolve,
      resolveReview: actualResolver.resolveReview,
      verifyReview: actualResolver.verifyReview,
    };
    const spawned = child();
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("spawn failed");
      })
      .mockImplementationOnce(() => spawned);
    const output = channel();
    const manager = createClaudeRunManager({
      cache,
      canonicalize: async (cwd) => cwd,
      createId: () => "manual-isolation-run",
      createTemporary: async () => join(root, "agent-temporary"),
      environment: {
        HOME: home,
        LANG: "C",
        PATH: process.env.PATH,
        USER: "fixture",
      },
      git: runGit,
      loadPull,
      loadReviewAuthorization,
      removeTemporary: async () => undefined,
      resolver,
      runtime: 30_000,
      spawn,
    });

    const input = {
      agent: "claude",
      expectedHeadRefOid: submitted,
      message: "Address every readiness blocker.",
      number: NUMBER,
      repository: REPOSITORY,
    };
    await expect(manager.start(input, channel())).rejects.toThrow(
      "spawn failed",
    );
    expect(await readdir(reviews)).toEqual([]);
    expect(manager.activeCount()).toBe(0);
    expect(manager.activeWorkspaceCount()).toBe(0);

    const run = await manager.start(input, output);

    expect(legacyResolve).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    const agent = spawn.mock.calls[1][2].cwd;
    expect(agent).not.toBe(primary);
    expect(agent).not.toBe(dirtyHead);
    expect(agent.startsWith(`${await realpath(reviews)}/review-`)).toBe(true);
    expect(await head(agent)).toBe(submitted);
    expect(await branch(agent)).toBe(BRANCH);
    expect(await status(agent)).toBe("");

    await appendFile(join(agent, "feature.txt"), "agent fix\n");
    spawned.stdout.write(
      `${JSON.stringify({
        is_error: false,
        subtype: "success",
        type: "result",
      })}\n`,
    );
    spawned.stdout.end();
    spawned.stderr.end();
    spawned.emit("close", 0, null);
    await run.done;

    const published = await head(remote, `refs/heads/${BRANCH}`);
    expect(published).not.toBe(submitted);
    await git(remote, "merge-base", "--is-ancestor", submitted, published);
    expect(
      (
        await git(remote, "rev-list", "--count", `${submitted}..${published}`)
      ).stdout.trim(),
    ).toBe("1");
    expect(await head(remote, "refs/heads/main")).toBe(base);

    const pushes = calls.filter(
      ({ arguments: arguments_, network }) =>
        network === "push" && !arguments_.includes("--dry-run"),
    );
    expect(pushes).toHaveLength(1);
    const push = pushes[0].arguments;
    expect(push.slice(push.indexOf("push"))).toEqual([
      "push",
      "--no-verify",
      "origin",
      `HEAD:refs/heads/${BRANCH}`,
    ]);
    expect(push).not.toContain("--force");
    expect(push).not.toContain("--force-with-lease");
    expect(push).not.toContain("-f");
    expect(push).not.toContain("--mirror");

    expect(
      await checkoutProof(primary, "README.md", "primary.untracked"),
    ).toEqual(primaryBefore);
    expect(
      await checkoutProof(dirtyHead, "feature.txt", "linked.untracked"),
    ).toEqual(dirtyBefore);
    expect(await readdir(reviews)).toEqual([]);
    expect(manager.activeCount()).toBe(0);
    expect(manager.activeWorkspaceCount()).toBe(0);
    expect(output.events.at(-1)).toEqual({ exitCode: 0, type: "complete" });
  }, 30_000);
});
