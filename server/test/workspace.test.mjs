import { execFile as executeFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTaskRepositoryCatalog,
  createVerificationWorkspaceManager,
  createWorkspaceResolver,
  repositoryFromOrigin,
  resolveTaskWorkspaceOptions,
  resolveWorkspaceOptions,
  validateGitBranch,
  validateReleaseTag,
} from "../workspace.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const OTHER_SHA = "1234567890abcdef1234567890abcdef12345678";
const SAFE_GIT_CONFIGURATION = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];
const temporary = [];
const execFile = promisify(executeFile);

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory(name = "root") {
  const base = await mkdtemp(join(tmpdir(), "pull-workspace-"));
  temporary.push(base);
  const path = join(base, name);
  await mkdir(path, { recursive: true });
  return { base: await realpath(base), path: await realpath(path) };
}

function gitRunner(states) {
  return vi.fn(async (_git, args) => {
    const cwd = args[1];
    const tokens = args.slice(2);
    const command = (
      SAFE_GIT_CONFIGURATION.every(
        (argument, index) => tokens[index] === argument,
      )
        ? tokens.slice(SAFE_GIT_CONFIGURATION.length)
        : tokens
    ).join(" ");
    const state = states.get(cwd);
    const common = Object.prototype.hasOwnProperty.call(state ?? {}, "common")
      ? state.common
      : cwd;
    const gitDirectory = Object.prototype.hasOwnProperty.call(
      state ?? {},
      "gitDirectory",
    )
      ? state.gitDirectory
      : common;
    const values = {
      "rev-parse --show-toplevel": state?.top ?? cwd,
      "config --get remote.origin.url": state?.origin,
      "merge-base --is-ancestor abcdef0123456789abcdef0123456789abcdef01 1234567890abcdef1234567890abcdef12345678":
        state?.descendant,
      "push --dry-run --porcelain origin abcdef0123456789abcdef0123456789abcdef01:refs/heads/fix/review":
        state?.pushable,
      "remote get-url --push origin": state?.pushOrigin,
      "rev-parse --absolute-git-dir": gitDirectory,
      "rev-parse --git-common-dir": common,
      "rev-parse HEAD": state?.head,
      "rev-parse --verify refs/remotes/origin/fix/review": state?.remoteHead,
      "status --porcelain=v1 --untracked-files=all": state?.status ?? "",
      "symbolic-ref --quiet --short HEAD": state?.branch,
      "worktree list --porcelain -z": state?.worktrees,
    };
    const configured = values[command];
    const value = typeof configured === "function" ? configured() : configured;
    if (value === undefined) throw new Error("git failed");
    return { stdout: `${value}\n`, stderr: "" };
  });
}

function worktreeList(records) {
  return records
    .map(
      ({ metadata = [], path }) =>
        `${[`worktree ${path}`, ...metadata].join("\0")}\0\0`,
    )
    .join("");
}

describe("workspace resolution", () => {
  it("normalizes exact GitHub origins case-insensitively", () => {
    expect(repositoryFromOrigin("git@github.com:Owner/Repo.git")).toBe(
      "owner/repo",
    );
    expect(repositoryFromOrigin("https://github.com/OWNER/Repo.git")).toBe(
      "owner/repo",
    );
    expect(repositoryFromOrigin("ssh://git@github.com/Owner/Repo.git")).toBe(
      "owner/repo",
    );
    expect(repositoryFromOrigin("https://example.com/owner/repo")).toBeNull();
    expect(repositoryFromOrigin("file://github.com/owner/repo")).toBeNull();
    expect(
      repositoryFromOrigin("https://github.com/owner/repo/extra"),
    ).toBeNull();
  });

  it("uses the documented environment-shaped roots option", () => {
    expect(
      resolveWorkspaceOptions(
        { ACTION_WORKSPACE_ROOTS: "/one:/two" },
        "/home/test",
      ),
    ).toEqual({
      roots: ["/one", "/two", "/home/test/.puller/worktrees"],
    });
    expect(resolveWorkspaceOptions({}, "/home/test")).toEqual({
      roots: [
        "/home/test/Local",
        "/home/test/.codex/worktrees",
        "/home/test/.puller/worktrees",
      ],
    });
    expect(
      resolveWorkspaceOptions(
        {
          ACTION_WORKSPACE_ROOTS: "/one:/state/worktrees",
          PULLER_TASK_ROOT: "/state",
        },
        "/home/test",
      ),
    ).toEqual({
      roots: ["/one", "/state/worktrees"],
    });
    expect(
      resolveWorkspaceOptions(
        { PULLER_TASK_WORKTREE_ROOT: "/custom/tasks" },
        "/home/test",
      ),
    ).toEqual({
      roots: [
        "/home/test/Local",
        "/home/test/.codex/worktrees",
        "/custom/tasks",
      ],
    });
  });

  it("deduplicates canonically equivalent trusted roots before discovery", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    await mkdir(repository);
    const states = new Map([
      [
        repository,
        {
          top: repository,
          origin: "https://github.com/owner/repo",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const discoverRepositories = vi.fn(async () => [repository]);
    const resolver = createWorkspaceResolver({
      roots: [root, root],
      run: gitRunner(states),
      discoverRepositories,
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 7,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(repository);
    expect(discoverRepositories).toHaveBeenCalledOnce();
  });

  it("selects one clean exact-head normal repo or git-file worktree", async () => {
    const { path: root } = await directory();
    const repo = join(root, "repo");
    await mkdir(repo);
    const states = new Map([
      [
        repo,
        {
          top: repo,
          origin: "git@github.com:Owner/Repo.git",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
      discoverRepositories: vi.fn(async () => [repo]),
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 7,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(repo);

    // The retained association permits follow-up edits while the checked-out commit remains pinned.
    states.get(repo).status = " M source.js";
    await expect(
      resolver.resolve({
        repository: "OWNER/REPO",
        number: 7,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(repo);
  });

  it("clears an association when the retained worktree head moves", async () => {
    const { path: root } = await directory();
    const repo = join(root, "repo");
    await mkdir(repo);
    const states = new Map([
      [
        repo,
        {
          top: repo,
          origin: "https://github.com/owner/repo.git",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const discoverRepositories = vi.fn(async () => [repo]);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
      discoverRepositories,
    });

    await resolver.resolve({
      repository: "owner/repo",
      number: 7,
      expectedHeadRefOid: SHA,
    });

    states.get(repo).head = "1234567890abcdef1234567890abcdef12345678";
    states.get(repo).status = " M source.js";
    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 7,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
    expect(discoverRepositories).toHaveBeenCalledTimes(2);
  });

  it("discovers a git-file worktree under a canonical trusted root", async () => {
    const { path: root } = await directory();
    const worktree = join(root, "group", "worktree");
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(worktree, ".git"),
      "gitdir: /trusted/common/worktrees/repo\n",
    );
    const states = new Map([
      [
        worktree,
        {
          top: worktree,
          origin: "https://github.com/owner/repo.git",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 7,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(worktree);
  });

  it("discovers the exact PR head in a nested .claude registered worktree", async () => {
    const { path: root } = await directory("trusted");
    const repository = join(root, "cloud");
    await mkdir(repository);
    await execFile("git", ["init", "--initial-branch=main", repository]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "puller@example.test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Puller Test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "remote.origin.url",
      "https://github.com/appwrite-labs/cloud.git",
    ]);
    await writeFile(join(repository, ".gitignore"), ".claude/\n");
    await writeFile(join(repository, "source.php"), "first\n");
    await execFile("git", ["-C", repository, "add", "."]);
    await execFile("git", ["-C", repository, "commit", "-m", "first"]);
    const { stdout } = await execFile("git", [
      "-C",
      repository,
      "rev-parse",
      "HEAD",
    ]);
    const expected = stdout.trim();
    await writeFile(join(repository, "source.php"), "second\n");
    await execFile("git", ["-C", repository, "add", "source.php"]);
    await execFile("git", ["-C", repository, "commit", "-m", "second"]);

    const nested = join(
      repository,
      ".claude",
      "worktrees",
      "pull-request-4563",
    );
    await mkdir(join(repository, ".claude", "worktrees"), {
      recursive: true,
    });
    await execFile("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "--detach",
      nested,
      expected,
    ]);

    const resolver = createWorkspaceResolver({ roots: [root] });
    await expect(
      resolver.resolve({
        repository: "appwrite-labs/cloud",
        number: 4563,
        expectedHeadRefOid: expected,
      }),
    ).resolves.toBe(await realpath(nested));
  });

  it("parses registered paths with spaces and newlines, ignores unknown metadata, and permits locked worktrees", async () => {
    const { path: root } = await directory();
    const repository = join(root, "cloud");
    const common = join(repository, ".git");
    const worktree = join(
      repository,
      ".claude",
      "worktrees",
      "review 4563\nsecond line",
    );
    const unrelated = join(repository, ".claude", "worktrees", "unrelated");
    await Promise.all([
      mkdir(common, { recursive: true }),
      mkdir(worktree, { recursive: true }),
      mkdir(unrelated, { recursive: true }),
    ]);
    const states = new Map([
      [
        repository,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/appwrite-labs/cloud.git",
          status: "",
          worktrees: worktreeList([
            {
              metadata: [`HEAD ${OTHER_SHA}`],
              path: repository,
            },
            {
              metadata: [`HEAD ${OTHER_SHA}`],
              path: unrelated,
            },
            {
              metadata: [
                `HEAD ${SHA}`,
                "future-metadata value with spaces\nand a newline",
                "locked verification in progress",
              ],
              path: worktree,
            },
          ]),
        },
      ],
      [
        worktree,
        {
          head: SHA,
          origin: "git@github.com:appwrite-labs/cloud.git",
          status: "",
        },
      ],
      [
        unrelated,
        {
          head: OTHER_SHA,
          origin: "git@github.com:appwrite-labs/cloud.git",
          status: "",
        },
      ],
    ]);
    const run = gitRunner(states);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run,
      discoverRepositories: async () => [repository],
    });

    await expect(
      resolver.resolve({
        repository: "appwrite-labs/cloud",
        number: 4563,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(worktree);
    expect(
      run.mock.calls.some(
        ([, args]) =>
          [repository, unrelated].includes(args[1]) &&
          args.slice(2).join(" ") === "config --get remote.origin.url",
      ),
    ).toBe(false);

    states.get(worktree).status = " M source.php";
    await expect(
      resolver.resolve({
        repository: "appwrite-labs/cloud",
        number: 4563,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(worktree);
    await expect(
      resolver.resolve({
        repository: "appwrite-labs/cloud",
        number: 4564,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });

    states.get(worktree).head = OTHER_SHA;
    states.get(worktree).status = "";
    await expect(
      resolver.resolve({
        repository: "appwrite-labs/cloud",
        number: 4565,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
  });

  it("fails closed for bare, prunable, and missing registered worktrees", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    const common = join(repository, ".git");
    const bare = join(root, "bare");
    const prunable = join(root, "prunable");
    const missing = join(root, "missing");
    await Promise.all([
      mkdir(common, { recursive: true }),
      mkdir(bare),
      mkdir(prunable),
    ]);
    const states = new Map([
      [
        repository,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/owner/repo",
          worktrees: worktreeList([
            { metadata: [`HEAD ${SHA}`, "bare"], path: bare },
            {
              metadata: [
                `HEAD ${SHA}`,
                "prunable gitdir file points to non-existent location",
              ],
              path: prunable,
            },
            { metadata: [`HEAD ${SHA}`], path: missing },
          ]),
        },
      ],
      [
        bare,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
      [
        prunable,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
    ]);
    const run = gitRunner(states);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run,
      discoverRepositories: async () => [repository],
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
    expect(
      run.mock.calls.some(
        ([, args]) =>
          [bare, prunable, missing].includes(args[1]) &&
          args.slice(2).join(" ") === "config --get remote.origin.url",
      ),
    ).toBe(false);
  });

  it("rejects registered path and common-directory escapes after canonicalization", async () => {
    const { base, path: root } = await directory();
    const repository = join(root, "repo");
    const common = join(repository, ".git");
    const outside = join(base, "outside");
    const outsideCommon = join(outside, ".git");
    const alias = join(root, "alias");
    const inside = join(root, "inside");
    await Promise.all([
      mkdir(common, { recursive: true }),
      mkdir(outsideCommon, { recursive: true }),
      mkdir(inside),
    ]);
    await symlink(outside, alias, "dir");
    const states = new Map([
      [
        repository,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/owner/repo",
          worktrees: worktreeList([
            { metadata: [`HEAD ${SHA}`], path: outside },
            { metadata: [`HEAD ${SHA}`], path: alias },
          ]),
        },
      ],
      [
        outside,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
      [
        inside,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
    ]);
    const run = gitRunner(states);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run,
      discoverRepositories: async () => [repository],
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
    const listed = () =>
      run.mock.calls.filter(
        ([, args]) =>
          args.slice(2).join(" ") === "worktree list --porcelain -z",
      ).length;
    expect(listed()).toBe(1);

    states.get(repository).common = outsideCommon;
    states.get(repository).gitDirectory = outsideCommon;
    states.get(repository).head = SHA;
    states.get(repository).worktrees = worktreeList([
      { metadata: [`HEAD ${SHA}`], path: inside },
    ]);
    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 2,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
    expect(listed()).toBe(1);
  });

  it("rejects a matching-head worktree whose .git indirection escapes trusted roots", async () => {
    const { base, path: root } = await directory();
    const repository = join(root, "escaped");
    const outside = join(base, "outside.git");
    await Promise.all([mkdir(repository), mkdir(outside)]);
    await writeFile(join(repository, ".git"), `gitdir: ${outside}\n`);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(
        new Map([
          [
            repository,
            {
              common: outside,
              gitDirectory: outside,
              head: SHA,
              origin: "https://github.com/owner/repo",
              status: "",
              top: repository,
            },
          ],
        ]),
      ),
      discoverRepositories: async () => [repository],
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 3,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("lists each canonical common directory once, deduplicates canonical paths, and preserves real ambiguity", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    const common = join(repository, ".git");
    const linked = join(root, "linked");
    const selected = join(root, "selected");
    const alias = join(root, "selected-alias");
    const competing = join(root, "competing");
    await Promise.all([
      mkdir(common, { recursive: true }),
      mkdir(linked),
      mkdir(selected),
      mkdir(competing),
    ]);
    await symlink(selected, alias, "dir");
    let records = [
      { metadata: [`HEAD ${OTHER_SHA}`], path: repository },
      { metadata: [`HEAD ${OTHER_SHA}`], path: linked },
      { metadata: [`HEAD ${SHA}`], path: selected },
      { metadata: [`HEAD ${SHA}`], path: alias },
    ];
    const states = new Map([
      [
        repository,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/owner/repo",
          worktrees: () => worktreeList(records),
        },
      ],
      [
        linked,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/owner/repo",
        },
      ],
      [
        selected,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
      [
        competing,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
    ]);
    const run = gitRunner(states);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run,
      discoverRepositories: async () => [repository, linked, repository],
    });
    const listCalls = () =>
      run.mock.calls.filter(
        ([, args]) =>
          args.slice(2).join(" ") === "worktree list --porcelain -z",
      );

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(selected);
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0][1]).toEqual([
      "-C",
      repository,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    expect(
      run.mock.calls.some(
        ([, args]) =>
          [repository, linked].includes(args[1]) &&
          [
            "rev-parse --show-toplevel",
            "config --get remote.origin.url",
            "status --porcelain=v1 --untracked-files=all",
          ].includes(args.slice(2).join(" ")),
      ),
    ).toBe(false);
    expect(
      run.mock.calls.some(
        ([, args]) =>
          args[1] === linked &&
          args.slice(2).join(" ") === "rev-parse --git-common-dir",
      ),
    ).toBe(false);

    records = [...records, { metadata: [`HEAD ${SHA}`], path: competing }];
    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 2,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_ambiguous" });
    expect(listCalls()).toHaveLength(2);
    for (const path of [selected, competing]) {
      expect(
        run.mock.calls.some(
          ([, args]) =>
            args[1] === path &&
            args.slice(2).join(" ") ===
              "status --porcelain=v1 --untracked-files=all",
        ),
      ).toBe(true);
    }
  });

  it("falls back to the full registry when its HEAD snapshot has no exact match", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    const common = join(repository, ".git");
    const worktree = join(root, "worktree");
    await Promise.all([mkdir(common, { recursive: true }), mkdir(worktree)]);
    const states = new Map([
      [
        repository,
        {
          common,
          head: OTHER_SHA,
          origin: "https://github.com/owner/repo",
          worktrees: worktreeList([
            { metadata: [`HEAD ${OTHER_SHA}`], path: repository },
            { metadata: [`HEAD ${OTHER_SHA}`], path: worktree },
          ]),
        },
      ],
      [
        worktree,
        { head: SHA, origin: "https://github.com/owner/repo", status: "" },
      ],
    ]);
    const run = gitRunner(states);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run,
      discoverRepositories: async () => [repository],
    });

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).resolves.toBe(worktree);
    expect(
      run.mock.calls.some(
        ([, args]) =>
          args[1] === worktree &&
          args.slice(2).join(" ") === "config --get remote.origin.url",
      ),
    ).toBe(true);

    states.get(worktree).status = " M changed.php";
    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 2,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });

    states.get(worktree).head = OTHER_SHA;
    states.get(worktree).status = "";
    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 3,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
    await expect(
      resolver.resolve({
        repository: "other/repository",
        number: 4,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("rejects missing Git metadata but retains direct candidates when worktree listing fails", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    const common = join(repository, ".git");
    await mkdir(common, { recursive: true });

    for (const commonDirectory of [undefined, common]) {
      const states = new Map([
        [
          repository,
          {
            common: commonDirectory,
            head: SHA,
            origin: "https://github.com/owner/repo",
            status: "",
          },
        ],
      ]);
      const resolver = createWorkspaceResolver({
        roots: [root],
        run: gitRunner(states),
        discoverRepositories: async () => [repository],
      });
      if (commonDirectory === undefined) {
        await expect(
          resolver.resolve({
            repository: "owner/repo",
            number: 1,
            expectedHeadRefOid: SHA,
          }),
        ).rejects.toMatchObject({ code: "workspace_missing" });
        continue;
      }
      await expect(
        resolver.resolve({
          repository: "owner/repo",
          number: commonDirectory ? 2 : 1,
          expectedHeadRefOid: SHA,
        }),
      ).resolves.toBe(repository);

      states.get(repository).status = " M changed.php";
      await expect(
        resolver.resolve({
          repository: "owner/repo",
          number: commonDirectory ? 12 : 11,
          expectedHeadRefOid: SHA,
        }),
      ).rejects.toMatchObject({ code: "workspace_dirty" });

      states.get(repository).head = OTHER_SHA;
      states.get(repository).status = "";
      await expect(
        resolver.resolve({
          repository: "owner/repo",
          number: commonDirectory ? 22 : 21,
          expectedHeadRefOid: SHA,
        }),
      ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
    }
  });

  it("rechecks HEAD around status and reinspects origin, HEAD, and cleanliness before returning", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    await mkdir(repository);

    const dirtyStatuses = ["", " M changed.php"];
    const dirtyRun = gitRunner(
      new Map([
        [
          repository,
          {
            head: SHA,
            origin: "https://github.com/owner/repo",
            status: () => dirtyStatuses.shift(),
          },
        ],
      ]),
    );
    const dirtyResolver = createWorkspaceResolver({
      roots: [root],
      run: dirtyRun,
      discoverRepositories: async () => [repository],
    });
    await expect(
      dirtyResolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });
    expect(
      dirtyRun.mock.calls.slice(-7).map(([, args]) => args.slice(2)),
    ).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--git-common-dir"],
      ["rev-parse", "--absolute-git-dir"],
      ["config", "--get", "remote.origin.url"],
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
      ["rev-parse", "HEAD"],
    ]);

    const heads = [SHA, SHA, SHA, OTHER_SHA];
    const raceResolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(
        new Map([
          [
            repository,
            {
              head: () => heads.shift(),
              origin: "https://github.com/owner/repo",
              status: "",
            },
          ],
        ]),
      ),
      discoverRepositories: async () => [repository],
    });
    await expect(
      raceResolver.resolve({
        repository: "owner/repo",
        number: 2,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });

    const origins = [
      "https://github.com/owner/repo",
      "https://example.com/owner/repo",
    ];
    const originResolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(
        new Map([
          [
            repository,
            {
              head: SHA,
              origin: () => origins.shift(),
              status: "",
            },
          ],
        ]),
      ),
      discoverRepositories: async () => [repository],
    });
    await expect(
      originResolver.resolve({
        repository: "owner/repo",
        number: 3,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("clears an association when the refreshed remote head changes", async () => {
    const { path: root } = await directory();
    const repo = join(root, "repo");
    await mkdir(repo);
    const states = new Map([
      [
        repo,
        {
          top: repo,
          origin: "https://github.com/owner/repo",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
      discoverRepositories: async () => [repo],
    });
    await resolver.resolve({
      repository: "owner/repo",
      number: 1,
      expectedHeadRefOid: SHA,
    });
    states.get(repo).status = " M local.php";

    await expect(
      resolver.resolve({
        repository: "owner/repo",
        number: 1,
        expectedHeadRefOid: "1234567890abcdef1234567890abcdef12345678",
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
  });

  it("rejects ambiguity, dirty exact heads, wrong heads, and root escapes", async () => {
    const { base, path: root } = await directory();
    const first = join(root, "first");
    const second = join(root, "second");
    const outside = join(base, "outside");
    await Promise.all([mkdir(first), mkdir(second), mkdir(outside)]);
    const states = new Map([
      [
        first,
        { top: first, origin: "https://github.com/o/r", head: SHA, status: "" },
      ],
      [
        second,
        {
          top: second,
          origin: "git@github.com:o/r.git",
          head: SHA,
          status: "",
        },
      ],
      [
        outside,
        {
          top: outside,
          origin: "https://github.com/o/r",
          head: SHA,
          status: "",
        },
      ],
    ]);
    const candidates = [first, second, outside];
    const resolver = createWorkspaceResolver({
      roots: [root],
      run: gitRunner(states),
      discoverRepositories: async () => candidates,
    });
    await expect(
      resolver.resolve({
        repository: "o/r",
        number: 1,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_ambiguous" });

    states.get(second).status = "?? new.txt";
    states.get(first).status = " M tracked.txt";
    await expect(
      resolver.resolve({
        repository: "o/r",
        number: 2,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });

    states.get(first).status = "";
    states.get(second).status = "";
    states.get(first).head = "1234567890abcdef1234567890abcdef12345678";
    states.get(second).head = states.get(first).head;
    await expect(
      resolver.resolve({
        repository: "o/r",
        number: 3,
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "workspace_head_mismatch" });
  });
});

describe("review workspaces", () => {
  async function reviewFixture(overrides = {}) {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    await mkdir(repository);
    const state = {
      branch: "fix/review",
      descendant: "",
      head: SHA,
      origin: "https://github.com/owner/repo.git",
      pushable: "ok",
      pushOrigin: "git@github.com:owner/repo.git",
      remoteHead: SHA,
      status: "",
      top: repository,
      ...overrides,
    };
    const run = gitRunner(new Map([[repository, state]]));
    const resolver = createWorkspaceResolver({
      discoverRepositories: vi.fn(async () => [repository]),
      reviewCommandTimeout: overrides.reviewCommandTimeout ?? 30_000,
      roots: [root],
      run,
    });
    return { repository, resolver, run, state };
  }

  async function rewrittenHistory(kind) {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    await execFile("git", ["init", "--initial-branch=main", repository]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "puller@example.test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Puller Test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "commit.gpgsign",
      "false",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "remote.origin.url",
      "https://github.com/owner/repo.git",
    ]);
    await writeFile(join(repository, "source.txt"), "content\n");
    await execFile("git", ["-C", repository, "add", "source.txt"]);
    await execFile("git", ["-C", repository, "commit", "-m", "base"]);
    const base = (
      await execFile("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    const tree = (
      await execFile("git", ["-C", repository, "rev-parse", "HEAD^{tree}"])
    ).stdout.trim();
    const unrelated = (
      await execFile("git", [
        "-C",
        repository,
        "commit-tree",
        tree,
        "-m",
        "unrelated",
      ])
    ).stdout.trim();
    const replacement = (
      await execFile("git", [
        "-C",
        repository,
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "replacement",
      ])
    ).stdout.trim();
    await execFile("git", [
      "-C",
      repository,
      "checkout",
      "-B",
      "fix/review",
      unrelated,
    ]);
    await execFile("git", [
      "-C",
      repository,
      "update-ref",
      "refs/remotes/origin/fix/review",
      unrelated,
    ]);
    if (kind === "replace") {
      await execFile("git", [
        "-C",
        repository,
        "replace",
        unrelated,
        replacement,
      ]);
    } else {
      await mkdir(join(repository, ".git", "info"), { recursive: true });
      await writeFile(
        join(repository, ".git", "info", "grafts"),
        `${unrelated} ${base}\n`,
      );
    }
    await expect(
      execFile("git", [
        "-C",
        repository,
        "merge-base",
        "--is-ancestor",
        base,
        unrelated,
      ]),
    ).resolves.toBeDefined();
    return {
      base,
      repository,
      resolver: createWorkspaceResolver({ roots: [root] }),
      unrelated,
    };
  }

  it("proves a clean exact-head branch and push remote before review", async () => {
    const { repository, resolver, run } = await reviewFixture({
      reviewCommandTimeout: 17,
    });
    await expect(
      resolver.resolveReview({
        expectedHeadRefOid: SHA,
        headRefName: "fix/review",
        number: 7,
        repository: "owner/repo",
      }),
    ).resolves.toEqual({
      branch: "fix/review",
      cwd: repository,
      headRefOid: SHA,
      remote: "origin",
      repository: "owner/repo",
    });
    const calls = run.mock.calls.filter(([executable]) => executable === "git");
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) {
      expect(args.slice(2, 2 + SAFE_GIT_CONFIGURATION.length)).toEqual(
        SAFE_GIT_CONFIGURATION,
      );
    }
    const push = calls.find(
      ([, args]) =>
        args
          .slice(
            2 + SAFE_GIT_CONFIGURATION.length,
            5 + SAFE_GIT_CONFIGURATION.length,
          )
          .join(" ") === "push --dry-run --porcelain",
    );
    expect(push?.[2]).toMatchObject({
      env: expect.objectContaining({
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_SSH_COMMAND: expect.stringContaining("BatchMode=yes"),
        GIT_TERMINAL_PROMPT: "0",
      }),
      killSignal: "SIGKILL",
      timeout: 17,
    });
  });

  it("does not execute repository hooks or fsmonitor during review proof commands", async () => {
    const { path: root } = await directory();
    const repository = join(root, "repo");
    const remote = join(root, "remote.git");
    const hookMarker = join(root, "hook-ran");
    const monitorMarker = join(root, "monitor-ran");
    const hook = join(repository, ".git", "hooks", "pre-push");
    const monitor = join(root, "monitor");

    await execFile("git", ["init", "--bare", remote]);
    await execFile("git", ["init", "--initial-branch=fix/review", repository]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "puller@example.test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Puller Test",
    ]);
    await execFile("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://github.com/owner/repo.git",
    ]);
    await writeFile(join(repository, "source.txt"), "content\n");
    await execFile("git", ["-C", repository, "add", "source.txt"]);
    await execFile("git", ["-C", repository, "commit", "-m", "base"]);
    const head = (
      await execFile("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();

    await writeFile(hook, `#!/bin/sh\n: > "${hookMarker}"\nexit 1\n`);
    await chmod(hook, 0o755);
    await writeFile(monitor, `#!/bin/sh\n: > "${monitorMarker}"\nexit 1\n`);
    await chmod(monitor, 0o755);
    await execFile("git", [
      "-C",
      repository,
      "config",
      "core.fsmonitor",
      monitor,
    ]);

    await expect(
      execFile("git", [
        "-C",
        repository,
        "push",
        "--dry-run",
        remote,
        `${head}:refs/heads/fix/review`,
      ]),
    ).rejects.toBeDefined();
    await expect(stat(hookMarker)).resolves.toBeDefined();
    await execFile("git", ["-C", repository, "status", "--porcelain=v1"]).catch(
      () => undefined,
    );
    await expect(stat(monitorMarker)).resolves.toBeDefined();
    await rm(hookMarker, { force: true });
    await rm(monitorMarker, { force: true });

    await execFile("git", [
      "-C",
      repository,
      ...SAFE_GIT_CONFIGURATION,
      "push",
      remote,
      `${head}:refs/heads/fix/review`,
    ]);
    await execFile("git", [
      "-C",
      repository,
      "update-ref",
      "refs/remotes/origin/fix/review",
      head,
    ]);

    const run = vi.fn(async (executable, args, options) => {
      const configured = args.slice(2 + SAFE_GIT_CONFIGURATION.length);
      if (configured[0] === "push") {
        const rewritten = [...args];
        rewritten[rewritten.indexOf("origin")] = remote;
        return execFile(executable, rewritten, options);
      }
      return execFile(executable, args, options);
    });
    const resolver = createWorkspaceResolver({
      discoverRepositories: async () => [repository],
      roots: [root],
      run,
    });

    await expect(
      resolver.resolveReview({
        expectedHeadRefOid: head,
        headRefName: "fix/review",
        number: 7,
        repository: "owner/repo",
      }),
    ).resolves.toMatchObject({ cwd: repository, headRefOid: head });
    await expect(stat(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(monitorMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dirty and mismatched push-remote workspaces", async () => {
    const dirty = await reviewFixture({ status: " M source.js" });
    await expect(
      dirty.resolver.resolveReview({
        expectedHeadRefOid: SHA,
        headRefName: "fix/review",
        number: 7,
        repository: "owner/repo",
      }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });

    const remote = await reviewFixture({
      pushOrigin: "https://github.com/different/repo.git",
    });
    await expect(
      remote.resolver.resolveReview({
        expectedHeadRefOid: SHA,
        headRefName: "fix/review",
        number: 7,
        repository: "owner/repo",
      }),
    ).rejects.toMatchObject({ code: "review_workspace_remote_mismatch" });
  });

  it("post-verifies a clean pushed descendant at the exact origin ref", async () => {
    const { repository, resolver, state } = await reviewFixture();
    const workspace = await resolver.resolveReview({
      expectedHeadRefOid: SHA,
      headRefName: "fix/review",
      number: 7,
      repository: "owner/repo",
    });
    state.head = OTHER_SHA;
    state.remoteHead = OTHER_SHA;

    await expect(
      resolver.verifyReview(workspace, { expectedHeadRefOid: SHA }),
    ).resolves.toMatchObject({
      cwd: repository,
      headRefOid: OTHER_SHA,
    });
  });

  it("rejects a rewritten or unpushed completion", async () => {
    const rewritten = await reviewFixture();
    const rewrittenWorkspace = await rewritten.resolver.resolveReview({
      expectedHeadRefOid: SHA,
      headRefName: "fix/review",
      number: 7,
      repository: "owner/repo",
    });
    rewritten.state.head = OTHER_SHA;
    rewritten.state.remoteHead = OTHER_SHA;
    rewritten.state.descendant = undefined;
    await expect(
      rewritten.resolver.verifyReview(rewrittenWorkspace, {
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "review_commit_not_descendant" });

    const unpushed = await reviewFixture();
    const unpushedWorkspace = await unpushed.resolver.resolveReview({
      expectedHeadRefOid: SHA,
      headRefName: "fix/review",
      number: 7,
      repository: "owner/repo",
    });
    unpushed.state.head = OTHER_SHA;
    await expect(
      unpushed.resolver.verifyReview(unpushedWorkspace, {
        expectedHeadRefOid: SHA,
      }),
    ).rejects.toMatchObject({ code: "review_workspace_remote_head_mismatch" });
  });

  it("does not let replace refs spoof descendant verification", async () => {
    const fixture = await rewrittenHistory("replace");
    await expect(
      fixture.resolver.verifyReview(
        {
          branch: "fix/review",
          cwd: fixture.repository,
          headRefOid: fixture.base,
          remote: "origin",
          repository: "owner/repo",
        },
        { expectedHeadRefOid: fixture.base },
      ),
    ).rejects.toMatchObject({ code: "review_commit_not_descendant" });
  });

  it("fails closed when legacy Git grafts could spoof ancestry", async () => {
    const fixture = await rewrittenHistory("graft");
    await expect(
      fixture.resolver.verifyReview(
        {
          branch: "fix/review",
          cwd: fixture.repository,
          headRefOid: fixture.base,
          remote: "origin",
          repository: "owner/repo",
        },
        { expectedHeadRefOid: fixture.base },
      ),
    ).rejects.toMatchObject({ code: "review_git_grafts_present" });
  });
});

describe("task repository catalog", () => {
  it("uses dedicated safe task roots and validates branch refs", () => {
    expect(resolveTaskWorkspaceOptions({}, "/home/test")).toEqual({
      repositoryRoot: "/home/test/Local",
      stateRoot: "/home/test/.puller/tasks",
      worktreeRoot: "/home/test/.puller/worktrees",
    });
    expect(
      resolveTaskWorkspaceOptions(
        {
          PULLER_REPOSITORY_ROOT: "/repositories",
          PULLER_TASK_ROOT: "/state",
        },
        "/home/test",
      ),
    ).toEqual({
      repositoryRoot: "/repositories",
      stateRoot: "/state/tasks",
      worktreeRoot: "/state/worktrees",
    });
    expect(validateGitBranch("1.9.x")).toBe(true);
    expect(validateGitBranch("feature/new-task")).toBe(true);
    expect(validateGitBranch("--help")).toBe(false);
    expect(validateGitBranch("../escape")).toBe(false);
    expect(validateGitBranch("bad branch")).toBe(false);
    expect(validateGitBranch("main@{one}")).toBe(false);
  });

  it("caches canonical repositories, deduplicates linked worktrees, and prefers the primary clone", async () => {
    const { path: root } = await directory();
    const primary = join(root, "repo");
    const linked = join(root, "linked");
    const common = join(primary, ".git");
    await mkdir(common, { recursive: true });
    await mkdir(linked);
    await writeFile(
      join(linked, ".git"),
      `gitdir: ${join(common, "worktrees", "linked")}\n`,
    );
    const discoverRepositories = vi.fn(async () => [linked, primary]);
    let origin = "git@github.com:Owner/Repo.git";
    const run = vi.fn(async (_git, args) => {
      const cwd = args[1];
      const command = args.slice(2);
      if (command.join(" ") === "rev-parse --show-toplevel")
        return { stdout: `${cwd}\n` };
      if (command.join(" ") === "config --get remote.origin.url")
        return { stdout: `${origin}\n` };
      if (command.join(" ") === "rev-parse --git-common-dir")
        return { stdout: `${common}\n` };
      if (command[0] === "for-each-ref")
        return { stdout: "main\nrelease/1.9\nHEAD\n" };
      if (command[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    });
    const catalog = createTaskRepositoryCatalog({
      root,
      run,
      discoverRepositories,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    const first = await catalog.options();
    const second = await catalog.options();
    expect(first).toEqual({
      updatedAt: "2026-07-22T00:00:00.000Z",
      repositories: [
        {
          repository: "owner/repo",
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          branches: ["main", "release/1.9"],
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    });
    expect(second).toBeDefined();
    expect(discoverRepositories).toHaveBeenCalledTimes(1);
    await expect(catalog.resolve("owner/repo", "main")).resolves.toMatchObject({
      cwd: primary,
    });
    expect(discoverRepositories).toHaveBeenCalledTimes(1);
    await catalog.refresh();
    expect(discoverRepositories).toHaveBeenCalledTimes(2);

    origin = "https://example.com/owner/repo";
    await expect(catalog.resolve("owner/repo", "main")).rejects.toMatchObject({
      code: "repository_changed",
    });
  });

  it("fails closed for untrusted origins, traversal-shaped repositories, and unavailable branches", async () => {
    const { path: root } = await directory();
    const repo = join(root, "repo");
    const common = join(repo, ".git");
    await mkdir(common, { recursive: true });
    const run = vi.fn(async (_git, args) => {
      const command = args.slice(2);
      if (command.join(" ") === "rev-parse --show-toplevel")
        return { stdout: `${repo}\n` };
      if (command.join(" ") === "config --get remote.origin.url") {
        return { stdout: "https://example.com/owner/repo\n" };
      }
      throw new Error("not inspected");
    });
    const catalog = createTaskRepositoryCatalog({
      root,
      run,
      discoverRepositories: async () => [repo],
    });

    await expect(catalog.options()).resolves.toMatchObject({
      repositories: [],
    });
    await expect(catalog.resolve("../repo", "main")).rejects.toMatchObject({
      code: "repository_invalid",
    });
    await expect(
      catalog.resolve("owner/repo", "../main"),
    ).rejects.toMatchObject({
      code: "branch_invalid",
    });
    await expect(catalog.resolve("owner/repo", "main")).rejects.toMatchObject({
      code: "repository_unavailable",
    });
  });
});

describe("release verification workspaces", () => {
  it("validates release tags before using them as argument-array git refs", () => {
    expect(validateReleaseTag("v1.2.3")).toBe(true);
    expect(validateReleaseTag("release/1.2.3")).toBe(true);
    expect(validateReleaseTag("--help")).toBe(false);
    expect(validateReleaseTag("../escape")).toBe(false);
    expect(validateReleaseTag("bad tag")).toBe(false);
    expect(validateReleaseTag("tag@{one}")).toBe(false);
  });

  it("archives the pinned commit without checkout hooks, filters, or worktrees and cleans it", async () => {
    const { base, path: source } = await directory("repo");
    const temporaryRoot = join(base, "temporary-root");
    const temporaryBase = join(temporaryRoot, "puller-verify-test");
    const snapshot = join(temporaryBase, "snapshot");
    const archive = join(temporaryBase, "snapshot.tar");
    await mkdir(temporaryRoot);
    const tagSha = "1234567890abcdef1234567890abcdef12345678";
    const run = vi.fn(async (executable, args) => {
      if (executable === "tar") {
        await writeFile(
          join(snapshot, "source.js"),
          "export const safe = true\n",
        );
        return { stdout: "", stderr: "" };
      }
      if (args.at(-1) === "--show-toplevel")
        return { stdout: `${source}\n`, stderr: "" };
      if (args.slice(-3).join(" ") === "config --get remote.origin.url") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "" };
      }
      if (args.includes("cat-file")) return { stdout: "", stderr: "" };
      if (args.includes("--git-path"))
        return { stdout: `${source}\n`, stderr: "" };
      if (args.includes("hash-object")) {
        return {
          stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
          stderr: "",
        };
      }
      if (args.includes("archive")) {
        await writeFile(archive, "fake archive");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    });
    const remove = vi.fn(async (path) =>
      rm(path, { recursive: true, force: true }),
    );
    const manager = createVerificationWorkspaceManager({
      roots: [base],
      run,
      discoverRepositories: async () => [source],
      makeTemporary: async () => {
        await mkdir(temporaryBase);
        return temporaryBase;
      },
      remove,
      temporaryRoot,
    });

    const prepared = await manager.prepare({
      commitOid: tagSha,
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    expect(prepared).toMatchObject({
      commitOid: tagSha,
      cwd: snapshot,
      headSha: tagSha,
      tag: "v1.2.4",
    });
    expect(run).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "--no-replace-objects",
        `--git-dir=${join(temporaryBase, "repository.git")}`,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        tagSha,
      ],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(run).toHaveBeenCalledWith(
      "tar",
      [
        "-xf",
        archive,
        "-C",
        snapshot,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      expect.any(Object),
    );
    const gitTokens = run.mock.calls
      .filter(([executable]) => executable === "git")
      .flatMap(([, args]) => args);
    expect(gitTokens).not.toContain("worktree");
    expect(gitTokens).not.toContain("checkout");
    expect(gitTokens).not.toContain("fetch");
    expect(gitTokens).not.toContain("status");
    expect((await stat(join(snapshot, "source.js"))).mode & 0o777).toBe(0o444);
    await prepared.cleanup();
    await prepared.cleanup();
    expect(remove).toHaveBeenCalledWith(temporaryBase);
    await expect(stat(temporaryBase)).rejects.toThrow();
  });

  it("does not execute configured checkout hooks or smudge filters for a real repository", async () => {
    const { base, path: source } = await directory("repo");
    const temporaryRoot = join(base, "temporary-root");
    const hookMarker = join(base, "hook-ran");
    const filterMarker = join(base, "filter-ran");
    await mkdir(temporaryRoot);
    await execFile("git", ["init", source]);
    await execFile("git", [
      "-C",
      source,
      "config",
      "user.email",
      "puller@example.test",
    ]);
    await execFile("git", ["-C", source, "config", "user.name", "Puller Test"]);
    await execFile("git", [
      "-C",
      source,
      "config",
      "remote.origin.url",
      "https://github.com/owner/repo.git",
    ]);
    await execFile("git", [
      "-C",
      source,
      "config",
      "filter.evil.smudge",
      `/usr/bin/touch ${filterMarker}`,
    ]);
    await writeFile(
      join(source, ".gitattributes"),
      "payload.txt filter=evil\n",
    );
    await writeFile(join(source, "payload.txt"), "trusted snapshot\n");
    await execFile("git", [
      "-C",
      source,
      "add",
      ".gitattributes",
      "payload.txt",
    ]);
    await execFile("git", ["-C", source, "commit", "-m", "test snapshot"]);
    const hook = join(source, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\n/usr/bin/touch ${hookMarker}\n`);
    await chmod(hook, 0o755);
    await rm(filterMarker, { force: true });
    await rm(hookMarker, { force: true });
    const { stdout } = await execFile("git", [
      "-C",
      source,
      "rev-parse",
      "HEAD",
    ]);
    const commitOid = stdout.trim();
    const manager = createVerificationWorkspaceManager({
      roots: [base],
      discoverRepositories: async () => [source],
      temporaryRoot,
    });

    const prepared = await manager.prepare({
      commitOid,
      repository: "owner/repo",
      tag: "v1.2.4",
    });
    try {
      await expect(stat(hookMarker)).rejects.toThrow();
      await expect(stat(filterMarker)).rejects.toThrow();
      expect((await stat(join(prepared.cwd, "payload.txt"))).mode & 0o777).toBe(
        0o444,
      );
    } finally {
      await prepared.cleanup();
    }
    await expect(stat(prepared.cwd)).rejects.toThrow();
  });

  it("fails closed and removes temporary state when archive extraction fails", async () => {
    const { base, path: source } = await directory("repo");
    const temporaryRoot = join(base, "temporary-root");
    const temporaryBase = join(temporaryRoot, "puller-verify-failure");
    const archive = join(temporaryBase, "snapshot.tar");
    await mkdir(temporaryRoot);
    const tagSha = "1234567890abcdef1234567890abcdef12345678";
    const run = vi.fn(async (executable, args) => {
      if (executable === "tar") throw new Error("invalid archive");
      if (args.at(-1) === "--show-toplevel") return { stdout: source };
      if (args.slice(-3).join(" ") === "config --get remote.origin.url") {
        return { stdout: "https://github.com/owner/repo" };
      }
      if (args.includes("cat-file")) return { stdout: "" };
      if (args.includes("--git-path")) return { stdout: source };
      if (args.includes("hash-object")) {
        return { stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" };
      }
      if (args.includes("archive")) {
        await writeFile(archive, "invalid");
        return { stdout: "" };
      }
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    });
    const remove = vi.fn(async (path) =>
      rm(path, { recursive: true, force: true }),
    );
    const manager = createVerificationWorkspaceManager({
      roots: [base],
      run,
      discoverRepositories: async () => [source],
      makeTemporary: async () => {
        await mkdir(temporaryBase);
        return temporaryBase;
      },
      remove,
      temporaryRoot,
    });
    await expect(
      manager.prepare({
        commitOid: tagSha,
        repository: "owner/repo",
        tag: "v1.2.4",
      }),
    ).rejects.toMatchObject({ code: "release_workspace_failed" });
    expect(remove).toHaveBeenCalledWith(temporaryBase);
    await expect(stat(temporaryBase)).rejects.toThrow();
  });

  it("requires the pinned commit locally without fetching or creating temporary state", async () => {
    const { base, path: source } = await directory("repo");
    const authorized = "1234567890abcdef1234567890abcdef12345678";
    const run = vi.fn(async (_git, args) => {
      if (args.at(-1) === "--show-toplevel") return { stdout: source };
      if (args.slice(-3).join(" ") === "config --get remote.origin.url") {
        return { stdout: "https://github.com/owner/repo" };
      }
      if (args.includes("cat-file")) throw new Error("missing object");
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    });
    const makeTemporary = vi.fn();
    const manager = createVerificationWorkspaceManager({
      roots: [base],
      run,
      discoverRepositories: async () => [source],
      makeTemporary,
    });
    await expect(
      manager.prepare({
        commitOid: authorized,
        repository: "owner/repo",
        tag: "v1.2.4",
      }),
    ).rejects.toMatchObject({ code: "release_commit_missing" });
    expect(makeTemporary).not.toHaveBeenCalled();
    const tokens = run.mock.calls.flatMap(([, args]) => args);
    expect(tokens).not.toContain("fetch");
    expect(tokens).not.toContain("checkout");
    expect(tokens).not.toContain("worktree");
  });
});
