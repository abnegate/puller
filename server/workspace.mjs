import { execFile as executeFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

const execFile = promisify(executeFile);
const GITHUB = "github.com";
const SHA = /^[a-f0-9]{40}$/i;
const DEFAULT_REVIEW_CLEANUP_TIMEOUT = 30_000;
const DEFAULT_REVIEW_COMMAND_TIMEOUT = 30_000;
const REVIEW_DIRECTORY_PREFIX = "review-";
const REVIEW_ROOT_MODE = 0o700;
const REVIEW_WORKSPACE_CLEANUP_FAILURE =
  "The review workspace could not be removed safely.";
const REVIEW_SSH_COMMAND =
  "ssh -oBatchMode=yes -oConnectTimeout=15 -oStrictHostKeyChecking=yes";
const REVIEW_GIT_ENVIRONMENT = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "__CF_USER_TEXT_ENCODING",
]);
const SAFE_GIT_CONFIGURATION = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
]);

export class WorkspaceError extends Error {
  constructor(message, code = "workspace_unavailable") {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = 409;
  }
}

function isInside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function normalizeRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return repository.replace(/\.git$/i, "").toLowerCase();
}

const GIT_REF =
  /^(?!-)(?!.*(?:\.\.|@\{|[~^:?*\[\\\s\x00-\x1f\x7f]))(?!.*\/\/)(?!.*\/$)[^/]+(?:\/[^/]+)*$/;

export function validateGitBranch(value) {
  if (typeof value !== "string" || value === "" || value === "@") return false;
  return (
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      ) &&
    GIT_REF.test(value)
  );
}

export function repositoryFromOrigin(origin) {
  if (typeof origin !== "string") {
    return null;
  }

  const trimmed = origin.trim();
  const scp = /^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (scp) {
    return normalizeRepository(scp[1]);
  }

  try {
    const url = new URL(trimmed);
    if (
      url.hostname.toLowerCase() !== GITHUB ||
      (url.protocol !== "https:" && url.protocol !== "ssh:")
    ) {
      return null;
    }
    return normalizeRepository(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function splitRoots(value, home = homedir()) {
  const configured = value
    ? value.split(delimiter).filter(Boolean)
    : [join(home, "Local"), join(home, ".codex", "worktrees")];

  return configured.map((path) => resolve(path));
}

export function resolveWorkspaceOptions(
  environment = process.env,
  home = homedir(),
) {
  const task = resolveTaskWorkspaceOptions(environment, home);
  const base = resolve(environment.PULLER_TASK_ROOT || join(home, ".puller"));
  return {
    reviewRoot: resolve(
      environment.PULLER_REVIEW_WORKSPACE_ROOT || join(base, "reviews"),
    ),
    roots: [
      ...new Set([
        ...splitRoots(environment.ACTION_WORKSPACE_ROOTS, home),
        task.worktreeRoot,
      ]),
    ],
  };
}

export function resolveTaskWorkspaceOptions(
  environment = process.env,
  home = homedir(),
) {
  const base = resolve(environment.PULLER_TASK_ROOT || join(home, ".puller"));
  return {
    repositoryRoot: resolve(
      environment.PULLER_REPOSITORY_ROOT || join(home, "Local"),
    ),
    stateRoot: resolve(
      environment.PULLER_TASK_STATE_ROOT || join(base, "tasks"),
    ),
    worktreeRoot: resolve(
      environment.PULLER_TASK_WORKTREE_ROOT || join(base, "worktrees"),
    ),
  };
}

async function command(run, cwd, args, options = {}) {
  const { gitConfiguration = [], ...execution } = options;
  try {
    const result = await run("git", ["-C", cwd, ...gitConfiguration, ...args], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      ...execution,
    });
    return String(result.stdout ?? "").trim();
  } catch {
    return null;
  }
}

async function hasGitMarker(path) {
  try {
    const marker = await lstat(join(path, ".git"));
    if (marker.isDirectory()) {
      return true;
    }
    if (!marker.isFile()) {
      return false;
    }
    const content = await readFile(join(path, ".git"), "utf8");
    return /^gitdir:\s*.+/m.test(content);
  } catch {
    return false;
  }
}

async function discover(root) {
  const found = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    let marker = false;
    try {
      marker = await hasGitMarker(current);
    } catch {
      marker = false;
    }
    if (marker) {
      found.push(current);
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        entry.name !== ".git"
      ) {
        pending.push(join(current, entry.name));
      }
    }
  }

  return found;
}

async function canonicalRoots(roots) {
  const canonical = new Set();
  for (const root of roots) {
    try {
      canonical.add(await realpath(root));
    } catch {
      // Missing configured roots are ignored. A later error remains path-free.
    }
  }
  return [...canonical];
}

function parseRegisteredWorktrees(output) {
  const worktrees = [];
  let current = null;

  for (const field of String(output).split("\0")) {
    if (field === "") continue;

    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { bare: false, head: null, path: value, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === "bare") current.bare = true;
    if (key === "HEAD" && SHA.test(value)) current.head = value.toLowerCase();
    if (key === "prunable") current.prunable = true;
  }
  if (current) worktrees.push(current);

  return worktrees.filter((worktree) => worktree.path !== "");
}

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function canonicalGitPath(path, cwd) {
  if (!path) return null;
  return canonicalPath(isAbsolute(path) ? path : resolve(cwd, path));
}

async function registeredCandidates(
  run,
  roots,
  direct,
  expected,
  options = {},
) {
  const candidates = new Map();
  for (const path of direct) {
    const canonical = await canonicalPath(path);
    if (canonical && roots.some((root) => isInside(root, canonical))) {
      candidates.set(canonical, canonical);
    }
  }

  const fast = new Map();
  const listed = new Set();
  const represented = new Set();
  for (const candidate of [...candidates.values()]) {
    if (represented.has(candidate)) continue;

    const common = await command(
      run,
      candidate,
      ["rev-parse", "--git-common-dir"],
      options,
    );
    if (!common) continue;

    const commonDirectory = await canonicalPath(
      isAbsolute(common) ? common : resolve(candidate, common),
    );
    if (
      !commonDirectory ||
      !roots.some((root) => isInside(root, commonDirectory)) ||
      listed.has(commonDirectory)
    ) {
      continue;
    }
    listed.add(commonDirectory);

    const output = await command(
      run,
      candidate,
      ["worktree", "list", "--porcelain", "-z"],
      options,
    );
    if (output === null) continue;

    const worktrees = parseRegisteredWorktrees(output);
    if (worktrees.length === 0) continue;
    for (const worktree of worktrees) {
      const canonical = await canonicalPath(worktree.path);
      if (canonical && roots.some((root) => isInside(root, canonical))) {
        represented.add(canonical);
        if (worktree.bare || worktree.prunable) {
          candidates.delete(canonical);
          continue;
        }
        candidates.set(canonical, canonical);
        if (worktree.head === expected) fast.set(canonical, canonical);
      }
    }
  }

  for (const [canonical, candidate] of candidates) {
    if (!represented.has(canonical)) fast.set(canonical, candidate);
  }

  return {
    fast: [...fast.values()],
    full: [...candidates.values()],
  };
}

async function inspectCandidate(run, roots, candidate, options = {}) {
  const top = await command(
    run,
    candidate,
    ["rev-parse", "--show-toplevel"],
    options,
  );
  if (!top) {
    return null;
  }

  let cwd;
  try {
    cwd = await realpath(top);
  } catch {
    return null;
  }
  if (!roots.some((root) => isInside(root, cwd))) {
    return null;
  }

  const common = await command(
    run,
    cwd,
    ["rev-parse", "--git-common-dir"],
    options,
  );
  const git = await command(
    run,
    cwd,
    ["rev-parse", "--absolute-git-dir"],
    options,
  );
  const commonDirectory = await canonicalGitPath(common, cwd);
  const gitDirectory = await canonicalGitPath(git, cwd);
  if (
    !commonDirectory ||
    !gitDirectory ||
    !roots.some((root) => isInside(root, commonDirectory)) ||
    !roots.some((root) => isInside(root, gitDirectory))
  ) {
    return null;
  }

  const origin = await command(
    run,
    cwd,
    ["config", "--get", "remote.origin.url"],
    options,
  );
  const initialHead = await command(run, cwd, ["rev-parse", "HEAD"], options);
  const status = await command(
    run,
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options,
  );
  const head = await command(run, cwd, ["rev-parse", "HEAD"], options);
  if (
    !origin ||
    !SHA.test(initialHead ?? "") ||
    !SHA.test(head ?? "") ||
    status === null
  ) {
    return null;
  }

  return {
    commonDirectory,
    cwd,
    gitDirectory,
    repository: repositoryFromOrigin(origin),
    head: head.toLowerCase(),
    clean: status === "",
    stable: initialHead.toLowerCase() === head.toLowerCase(),
  };
}

async function inspectSourceCandidate(run, roots, candidate, options = {}) {
  const top = await command(
    run,
    candidate,
    ["rev-parse", "--show-toplevel"],
    options,
  );
  if (!top) return null;

  const cwd = await canonicalPath(top);
  if (!cwd || !roots.some((root) => isInside(root, cwd))) return null;

  const common = await command(
    run,
    cwd,
    ["rev-parse", "--git-common-dir"],
    options,
  );
  const git = await command(
    run,
    cwd,
    ["rev-parse", "--absolute-git-dir"],
    options,
  );
  const commonDirectory = await canonicalGitPath(common, cwd);
  const gitDirectory = await canonicalGitPath(git, cwd);
  if (
    !commonDirectory ||
    !gitDirectory ||
    !roots.some((root) => isInside(root, commonDirectory)) ||
    !roots.some((root) => isInside(root, gitDirectory))
  ) {
    return null;
  }

  const origin = await command(
    run,
    cwd,
    ["config", "--get", "remote.origin.url"],
    options,
  );
  const initialHead = await command(run, cwd, ["rev-parse", "HEAD"], options);
  const head = await command(run, cwd, ["rev-parse", "HEAD"], options);
  if (!origin || !SHA.test(initialHead ?? "") || !SHA.test(head ?? "")) {
    return null;
  }

  return {
    commonDirectory,
    cwd,
    gitDirectory,
    head: head.toLowerCase(),
    repository: repositoryFromOrigin(origin),
    stable: initialHead.toLowerCase() === head.toLowerCase(),
  };
}

function canonicalGitHubOrigin(repository) {
  return `git@github.com:${repository}.git`;
}

function directReviewDirectory(root, cwd) {
  const path = relative(root, cwd);
  return (
    path.startsWith(REVIEW_DIRECTORY_PREFIX) &&
    !path.includes(sep) &&
    path !== REVIEW_DIRECTORY_PREFIX
  );
}

function reviewWorkspaceCleanupError() {
  return new WorkspaceError(
    REVIEW_WORKSPACE_CLEANUP_FAILURE,
    "review_workspace_cleanup_failed",
  );
}

async function createReviewDirectory(
  root,
  { cleanupTimeout, removeReviewDirectory },
) {
  const configured = resolve(root);
  await mkdir(configured, { mode: REVIEW_ROOT_MODE, recursive: true });
  const rootState = await lstat(configured);
  if (
    !rootState.isDirectory() ||
    rootState.isSymbolicLink() ||
    (typeof process.getuid === "function" && rootState.uid !== process.getuid())
  ) {
    throw new WorkspaceError(
      "The review workspace root is not app-owned.",
      "review_workspace_root_untrusted",
    );
  }
  await chmod(configured, REVIEW_ROOT_MODE);
  const canonicalRoot = await realpath(configured);
  const rootIdentity = await lstat(canonicalRoot);
  const created = await mkdtemp(join(canonicalRoot, REVIEW_DIRECTORY_PREFIX));
  await chmod(created, REVIEW_ROOT_MODE);
  const cwd = await realpath(created);
  const identity = await lstat(cwd);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    !directReviewDirectory(canonicalRoot, cwd)
  ) {
    await rm(created, { force: true, recursive: true });
    throw new WorkspaceError(
      "The review workspace could not be created safely.",
      "review_workspace_create_failed",
    );
  }

  let removal = null;
  const cleanup = () => {
    if (removal !== null) return removal;
    const attempt = Promise.resolve().then(async () => {
      const currentRoot = await canonicalPath(canonicalRoot);
      let currentRootIdentity;
      let current;
      try {
        currentRootIdentity = await lstat(canonicalRoot);
        current = await lstat(cwd);
      } catch {
        throw reviewWorkspaceCleanupError();
      }
      const currentCwd = await canonicalPath(cwd);
      if (
        currentRoot !== canonicalRoot ||
        !currentRootIdentity.isDirectory() ||
        currentRootIdentity.isSymbolicLink() ||
        currentRootIdentity.dev !== rootIdentity.dev ||
        currentRootIdentity.ino !== rootIdentity.ino ||
        currentRootIdentity.uid !== rootIdentity.uid ||
        (currentRootIdentity.mode & 0o777) !== REVIEW_ROOT_MODE ||
        currentCwd !== cwd ||
        !directReviewDirectory(canonicalRoot, currentCwd ?? "")
      ) {
        throw reviewWorkspaceCleanupError();
      }
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.uid !== identity.uid
      ) {
        throw reviewWorkspaceCleanupError();
      }
      await removeReviewDirectory(cwd);
    });
    removal = new Promise((resolveRemoval, rejectRemoval) => {
      let settled = false;
      const finish = (complete) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        complete();
      };
      const timer = setTimeout(
        () => finish(() => rejectRemoval(reviewWorkspaceCleanupError())),
        cleanupTimeout,
      );
      timer.unref?.();
      attempt.then(
        () => finish(resolveRemoval),
        () => finish(() => rejectRemoval(reviewWorkspaceCleanupError())),
      );
    });
    return removal;
  };

  return { cleanup, cwd, root: canonicalRoot };
}

async function rejectAlternates(commonDirectory) {
  try {
    await lstat(join(commonDirectory, "objects", "info", "alternates"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new WorkspaceError(
      "The review repository object storage could not be inspected.",
      "review_git_metadata_unavailable",
    );
  }
  throw new WorkspaceError(
    "Git object alternates are not allowed in review workspaces.",
    "review_git_alternates_present",
  );
}

function selectCandidate(inspected, expected) {
  const eligible = inspected.filter(
    (candidate) =>
      candidate.head === expected && candidate.clean && candidate.stable,
  );
  const unique = new Map(
    eligible.map((candidate) => [candidate.cwd, candidate]),
  );
  if (unique.size > 1) {
    return {
      error: new WorkspaceError(
        "More than one clean matching worktree was found.",
        "workspace_ambiguous",
      ),
    };
  }
  if (unique.size === 1) {
    return { candidate: [...unique.values()][0] };
  }
  if (
    inspected.some(
      (candidate) =>
        candidate.head === expected && candidate.stable && !candidate.clean,
    )
  ) {
    return {
      error: new WorkspaceError(
        "The matching worktree has uncommitted changes.",
        "workspace_dirty",
      ),
    };
  }
  if (inspected.length > 0) {
    return {
      error: new WorkspaceError(
        "No clean worktree is checked out at the current pull request head.",
        "workspace_head_mismatch",
      ),
    };
  }
  return {
    error: new WorkspaceError(
      "No trusted local worktree matches this repository.",
      "workspace_missing",
    ),
  };
}

export function createWorkspaceResolver({
  environment = process.env,
  reviewRoot = resolveWorkspaceOptions(environment).reviewRoot,
  roots = resolveWorkspaceOptions(environment).roots,
  run = execFile,
  discoverRepositories = discover,
  removeReviewDirectory = (path) => rm(path, { force: true, recursive: true }),
  reviewCleanupTimeout = DEFAULT_REVIEW_CLEANUP_TIMEOUT,
  reviewCommandTimeout = DEFAULT_REVIEW_COMMAND_TIMEOUT,
} = {}) {
  if (!Number.isSafeInteger(reviewCleanupTimeout) || reviewCleanupTimeout < 1) {
    throw new TypeError("reviewCleanupTimeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(reviewCommandTimeout) || reviewCommandTimeout < 1) {
    throw new TypeError("reviewCommandTimeout must be a positive integer.");
  }
  if (typeof removeReviewDirectory !== "function") {
    throw new TypeError("removeReviewDirectory must be a function.");
  }
  if (
    typeof reviewRoot !== "string" ||
    reviewRoot === "" ||
    reviewRoot.includes("\0")
  ) {
    throw new TypeError("reviewRoot must be a non-empty path.");
  }
  const associations = new Map();

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
    throw (
      signal.reason ?? new Error("The review workspace request was aborted.")
    );
  }

  function reviewCommandOptions(signal) {
    const selected = {};
    for (const name of REVIEW_GIT_ENVIRONMENT) {
      const value = environment[name];
      if (typeof value === "string" && !value.includes("\0")) {
        selected[name] = value;
      }
    }
    return {
      env: {
        ...selected,
        GIT_ASKPASS: "/usr/bin/false",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_SSH_COMMAND: REVIEW_SSH_COMMAND,
        GIT_TERMINAL_PROMPT: "0",
        SSH_ASKPASS: "/usr/bin/false",
      },
      gitConfiguration: SAFE_GIT_CONFIGURATION,
      killSignal: "SIGKILL",
      ...(signal === undefined ? {} : { signal }),
      timeout: reviewCommandTimeout,
    };
  }

  async function inspectAssociated(association, repository, options = {}) {
    const canonical = await canonicalRoots(roots);
    if (
      canonical.length === 0 ||
      !canonical.some((root) => isInside(root, association.cwd))
    ) {
      return null;
    }
    const candidate = await inspectCandidate(
      run,
      canonical,
      association.cwd,
      options,
    );
    if (
      !candidate ||
      candidate.repository !== repository ||
      !candidate.stable
    ) {
      return null;
    }
    return candidate;
  }

  async function resolveReviewSource(repository, expected, options, signal) {
    const canonical = await canonicalRoots(roots);
    if (canonical.length === 0) {
      throw new WorkspaceError("No trusted workspace roots are available.");
    }

    const [, name] = repository.split("/");
    const preferred = [];
    for (const root of canonical) {
      for (const path of [
        join(root, name),
        join(root, ...repository.split("/")),
      ]) {
        const candidate = await canonicalPath(path);
        if (candidate && isInside(root, candidate)) preferred.push(candidate);
      }
    }

    const inspected = [];
    const attempted = new Set();
    const inspect = async (paths) => {
      for (const path of paths) {
        throwIfAborted(signal);
        if (attempted.has(path)) continue;
        attempted.add(path);
        const candidate = await inspectSourceCandidate(
          run,
          canonical,
          path,
          options,
        );
        throwIfAborted(signal);
        if (candidate?.repository === repository && candidate.stable) {
          inspected.push(candidate);
        }
      }
    };

    await inspect(preferred);
    if (inspected.length === 0) {
      const direct = [];
      for (const root of canonical) {
        throwIfAborted(signal);
        for (const candidate of await discoverRepositories(root)) {
          direct.push(candidate);
        }
      }
      const candidates = await registeredCandidates(
        run,
        canonical,
        direct,
        expected,
        options,
      );
      await inspect(candidates.fast);
      await inspect(candidates.full);
    }

    const unique = new Map();
    for (const candidate of inspected) {
      const current = unique.get(candidate.commonDirectory);
      if (
        !current ||
        candidate.cwd.split(sep).length < current.cwd.split(sep).length ||
        (candidate.cwd.split(sep).length === current.cwd.split(sep).length &&
          candidate.cwd.localeCompare(current.cwd) < 0)
      ) {
        unique.set(candidate.commonDirectory, candidate);
      }
    }
    const selected = [...unique.values()].sort((left, right) =>
      left.cwd.localeCompare(right.cwd),
    )[0];
    if (!selected) {
      throw new WorkspaceError(
        "No trusted local repository matches this pull request.",
        "workspace_missing",
      );
    }
    return selected;
  }

  async function requiredReviewCommand(
    cwd,
    args,
    options,
    signal,
    message,
    code,
  ) {
    const result = await command(run, cwd, args, options);
    throwIfAborted(signal);
    if (result === null) throw new WorkspaceError(message, code);
    return result;
  }

  async function resolvePull(
    { repository, number, expectedHeadRefOid },
    options = {},
  ) {
    const normalized = normalizeRepository(repository);
    const expected = String(expectedHeadRefOid).toLowerCase();
    const key = `${normalized}#${number}`;
    const association = associations.get(key);

    if (association) {
      if (association.remoteHead !== expected) {
        associations.delete(key);
      } else {
        const current = await inspectAssociated(
          association,
          normalized,
          options,
        );
        if (current?.head === expected) {
          return current.cwd;
        }
        associations.delete(key);
      }
    }

    const canonical = await canonicalRoots(roots);
    if (canonical.length === 0) {
      throw new WorkspaceError("No trusted workspace roots are available.");
    }

    const direct = [];
    for (const root of canonical) {
      for (const candidate of await discoverRepositories(root)) {
        direct.push(candidate);
      }
    }
    const candidates = await registeredCandidates(
      run,
      canonical,
      direct,
      expected,
      options,
    );

    const inspected = [];
    const attempted = new Set();
    const inspect = async (paths) => {
      for (const path of paths) {
        if (attempted.has(path)) continue;
        attempted.add(path);
        const candidate = await inspectCandidate(run, canonical, path, options);
        if (candidate?.repository === normalized) {
          inspected.push(candidate);
        }
      }
    };

    await inspect(candidates.fast);
    let selection = selectCandidate(inspected, expected);
    if (
      !selection.candidate &&
      selection.error.code !== "workspace_ambiguous" &&
      selection.error.code !== "workspace_dirty"
    ) {
      await inspect(candidates.full);
      selection = selectCandidate(inspected, expected);
    }
    if (selection.error) throw selection.error;

    const selected = selection.candidate;
    const confirmed = await inspectCandidate(
      run,
      canonical,
      selected.cwd,
      options,
    );
    if (
      !confirmed ||
      confirmed.cwd !== selected.cwd ||
      confirmed.repository !== normalized
    ) {
      throw new WorkspaceError(
        "No trusted local worktree matches this repository.",
        "workspace_missing",
      );
    }
    if (!confirmed.stable || confirmed.head !== expected) {
      throw new WorkspaceError(
        "No clean worktree is checked out at the current pull request head.",
        "workspace_head_mismatch",
      );
    }
    if (!confirmed.clean) {
      throw new WorkspaceError(
        "The matching worktree has uncommitted changes.",
        "workspace_dirty",
      );
    }
    associations.set(key, { cwd: confirmed.cwd, remoteHead: expected });
    return confirmed.cwd;
  }

  async function inspectReviewState({
    allowedRoots = roots,
    branch,
    cwd,
    expectedHead,
    repository,
    requireClean = true,
    options = {},
  }) {
    const canonical = await canonicalRoots(allowedRoots);
    if (
      canonical.length === 0 ||
      !canonical.some((root) => isInside(root, cwd))
    ) {
      throw new WorkspaceError(
        "The review worktree is outside the trusted workspace roots.",
        "review_workspace_untrusted",
      );
    }

    const candidate = await inspectCandidate(run, canonical, cwd, options);
    if (!candidate || candidate.repository !== repository) {
      throw new WorkspaceError(
        "The review worktree no longer matches the pull request repository.",
        "review_workspace_changed",
      );
    }
    if (!candidate.stable || candidate.head !== expectedHead) {
      throw new WorkspaceError(
        "The review worktree is not at the expected pull request head.",
        "review_workspace_head_mismatch",
      );
    }
    if (requireClean && !candidate.clean) {
      throw new WorkspaceError(
        "The review worktree has uncommitted changes.",
        "review_workspace_dirty",
      );
    }

    const currentBranch = await command(
      run,
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      options,
    );
    if (currentBranch !== branch) {
      throw new WorkspaceError(
        "The review worktree is not checked out on the pull request branch.",
        "review_workspace_branch_mismatch",
      );
    }
    const expectedOrigin = canonicalGitHubOrigin(repository);
    const fetchOrigin = await command(
      run,
      cwd,
      ["config", "--get", "remote.origin.url"],
      options,
    );
    const pushOrigin = await command(
      run,
      cwd,
      ["remote", "get-url", "--push", "origin"],
      options,
    );
    if (fetchOrigin !== expectedOrigin || pushOrigin !== expectedOrigin) {
      throw new WorkspaceError(
        "The review worktree remote does not exactly match the authorized GitHub repository.",
        "review_workspace_remote_mismatch",
      );
    }
    const fetchRefspec = await command(
      run,
      cwd,
      ["config", "--local", "--get-all", "remote.origin.fetch"],
      options,
    );
    const upstream = await command(
      run,
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      options,
    );
    if (
      fetchRefspec !== `+refs/heads/${branch}:refs/remotes/origin/${branch}` ||
      upstream !== `origin/${branch}`
    ) {
      throw new WorkspaceError(
        "The review worktree remote tracking proof changed.",
        "review_workspace_remote_mismatch",
      );
    }
    const hardening = await Promise.all(
      [
        ["core.fsmonitor", "false"],
        ["core.hooksPath", "/dev/null"],
        ["commit.gpgsign", "false"],
        ["tag.gpgsign", "false"],
        ["user.email", "puller@localhost"],
        ["user.name", "Puller Review"],
        ["user.useConfigOnly", "true"],
      ].map(async ([key, expected]) => [
        expected,
        await command(run, cwd, ["config", "--local", "--get", key], options),
      ]),
    );
    if (hardening.some(([expected, actual]) => expected !== actual)) {
      throw new WorkspaceError(
        "The review worktree local security configuration changed.",
        "review_workspace_hardening_changed",
      );
    }
    const remoteHead = await command(
      run,
      cwd,
      ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
      options,
    );
    if (remoteHead?.toLowerCase() !== expectedHead) {
      throw new WorkspaceError(
        "The local origin branch does not match the pull request head.",
        "review_workspace_remote_head_mismatch",
      );
    }
    return candidate;
  }

  async function rejectGrafts(commonDirectory) {
    const path = join(commonDirectory, "info", "grafts");
    try {
      await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new WorkspaceError(
        "The review repository graft state could not be inspected.",
        "review_git_metadata_unavailable",
      );
    }
    throw new WorkspaceError(
      "Git grafts are not allowed during review commit verification.",
      "review_git_grafts_present",
    );
  }

  return {
    resolve: resolvePull,

    async resolveReview({
      expectedHeadRefOid,
      headRefName,
      number,
      repository,
      signal,
    }) {
      const normalized = normalizeRepository(repository);
      const expected = String(expectedHeadRefOid).toLowerCase();
      if (
        !normalized ||
        !SHA.test(expected) ||
        !validateGitBranch(headRefName)
      ) {
        throw new WorkspaceError(
          "The pull request branch is invalid.",
          "review_workspace_branch_invalid",
        );
      }
      const options = reviewCommandOptions(signal);
      let owned = null;
      try {
        throwIfAborted(signal);
        const source = await resolveReviewSource(
          normalized,
          expected,
          options,
          signal,
        );
        owned = await createReviewDirectory(reviewRoot, {
          cleanupTimeout: reviewCleanupTimeout,
          removeReviewDirectory,
        });
        throwIfAborted(signal);
        await requiredReviewCommand(
          owned.root,
          [
            "clone",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            source.cwd,
            owned.cwd,
          ],
          options,
          signal,
          "The owned review workspace could not be cloned.",
          "review_workspace_clone_failed",
        );

        const confirmedSource = await inspectSourceCandidate(
          run,
          await canonicalRoots(roots),
          source.cwd,
          options,
        );
        throwIfAborted(signal);
        if (
          !confirmedSource ||
          confirmedSource.cwd !== source.cwd ||
          confirmedSource.commonDirectory !== source.commonDirectory ||
          confirmedSource.repository !== normalized ||
          confirmedSource.head !== source.head ||
          !confirmedSource.stable
        ) {
          throw new WorkspaceError(
            "The trusted local repository changed while the review workspace was created.",
            "review_workspace_source_changed",
          );
        }

        const origin = canonicalGitHubOrigin(normalized);
        const configurations = [
          ["config", "--local", "core.fsmonitor", "false"],
          ["config", "--local", "core.hooksPath", "/dev/null"],
          ["config", "--local", "commit.gpgsign", "false"],
          ["config", "--local", "tag.gpgsign", "false"],
          ["config", "--local", "user.email", "puller@localhost"],
          ["config", "--local", "user.name", "Puller Review"],
          ["config", "--local", "user.useConfigOnly", "true"],
          ["remote", "set-url", "origin", origin],
          ["remote", "set-url", "--push", "origin", origin],
          [
            "config",
            "--local",
            "--replace-all",
            "remote.origin.fetch",
            `+refs/heads/${headRefName}:refs/remotes/origin/${headRefName}`,
          ],
          ["config", "--local", "remote.origin.tagOpt", "--no-tags"],
        ];
        for (const args of configurations) {
          await requiredReviewCommand(
            owned.cwd,
            args,
            options,
            signal,
            "The owned review workspace could not be hardened.",
            "review_workspace_hardening_failed",
          );
        }

        const common = await requiredReviewCommand(
          owned.cwd,
          ["rev-parse", "--git-common-dir"],
          options,
          signal,
          "The owned review Git metadata could not be inspected.",
          "review_git_metadata_unavailable",
        );
        const commonDirectory = await canonicalGitPath(common, owned.cwd);
        if (!commonDirectory || !isInside(owned.cwd, commonDirectory)) {
          throw new WorkspaceError(
            "The owned review Git metadata is outside the review workspace.",
            "review_git_metadata_unavailable",
          );
        }
        await rejectAlternates(commonDirectory);

        await requiredReviewCommand(
          owned.cwd,
          [
            "fetch",
            "--force",
            "--no-tags",
            "--recurse-submodules=no",
            "origin",
            `+refs/heads/${headRefName}:refs/remotes/origin/${headRefName}`,
          ],
          options,
          signal,
          "The pull request branch could not be fetched into the owned review workspace.",
          "review_workspace_fetch_failed",
        );
        const fetched = await requiredReviewCommand(
          owned.cwd,
          ["rev-parse", "--verify", `refs/remotes/origin/${headRefName}`],
          options,
          signal,
          "The fetched pull request branch could not be verified.",
          "review_workspace_remote_head_mismatch",
        );
        if (fetched.toLowerCase() !== expected) {
          throw new WorkspaceError(
            "The fetched pull request branch does not match the authorized head.",
            "review_workspace_remote_head_mismatch",
          );
        }

        await requiredReviewCommand(
          owned.cwd,
          [
            "checkout",
            "--force",
            "-B",
            headRefName,
            `refs/remotes/origin/${headRefName}`,
          ],
          options,
          signal,
          "The pull request branch could not be checked out in the owned review workspace.",
          "review_workspace_checkout_failed",
        );
        await requiredReviewCommand(
          owned.cwd,
          ["branch", "--set-upstream-to", `origin/${headRefName}`, headRefName],
          options,
          signal,
          "The pull request branch upstream could not be configured.",
          "review_workspace_upstream_failed",
        );

        await inspectReviewState({
          allowedRoots: [owned.root],
          branch: headRefName,
          cwd: owned.cwd,
          expectedHead: expected,
          options,
          repository: normalized,
        });
        const [configuredOrigin, configuredPush, configuredFetch, upstream] =
          await Promise.all([
            command(
              run,
              owned.cwd,
              ["config", "--local", "--get", "remote.origin.url"],
              options,
            ),
            command(
              run,
              owned.cwd,
              ["config", "--local", "--get", "remote.origin.pushurl"],
              options,
            ),
            command(
              run,
              owned.cwd,
              ["config", "--local", "--get-all", "remote.origin.fetch"],
              options,
            ),
            command(
              run,
              owned.cwd,
              [
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
              ],
              options,
            ),
          ]);
        throwIfAborted(signal);
        if (
          configuredOrigin !== origin ||
          configuredPush !== origin ||
          configuredFetch !==
            `+refs/heads/${headRefName}:refs/remotes/origin/${headRefName}` ||
          upstream !== `origin/${headRefName}`
        ) {
          throw new WorkspaceError(
            "The owned review remote or upstream proof is invalid.",
            "review_workspace_remote_mismatch",
          );
        }

        await requiredReviewCommand(
          owned.cwd,
          [
            "push",
            "--dry-run",
            "--porcelain",
            "origin",
            `${expected}:refs/heads/${headRefName}`,
          ],
          options,
          signal,
          "The pull request branch cannot be pushed through the proven origin remote.",
          "review_workspace_not_pushable",
        );
        await inspectReviewState({
          allowedRoots: [owned.root],
          branch: headRefName,
          cwd: owned.cwd,
          expectedHead: expected,
          options,
          repository: normalized,
        });
        await rejectAlternates(commonDirectory);

        return Object.freeze({
          branch: headRefName,
          cleanup: owned.cleanup,
          cwd: owned.cwd,
          headRefOid: expected,
          remote: "origin",
          repository: normalized,
        });
      } catch (error) {
        if (owned !== null) {
          try {
            await owned.cleanup();
          } catch {
            throw reviewWorkspaceCleanupError();
          }
        }
        throw error;
      }
    },

    async verifyReview(workspace, { expectedHeadRefOid, signal }) {
      const repository = normalizeRepository(workspace?.repository);
      const previous = String(expectedHeadRefOid).toLowerCase();
      if (
        !repository ||
        !SHA.test(previous) ||
        !validateGitBranch(workspace?.branch) ||
        typeof workspace?.cwd !== "string" ||
        typeof workspace?.cleanup !== "function"
      ) {
        throw new WorkspaceError(
          "The review worktree proof is invalid.",
          "review_workspace_invalid",
        );
      }
      const canonical = await canonicalRoots([reviewRoot]);
      const options = reviewCommandOptions(signal);
      const cwd = await canonicalPath(workspace.cwd);
      if (
        !cwd ||
        !canonical.some((root) => isInside(root, cwd)) ||
        !canonical.some((root) => directReviewDirectory(root, cwd)) ||
        cwd !== workspace.cwd
      ) {
        throw new WorkspaceError(
          "The review worktree proof changed.",
          "review_workspace_changed",
        );
      }
      const head = await command(run, cwd, ["rev-parse", "HEAD"], options);
      if (!SHA.test(head ?? "") || head.toLowerCase() === previous) {
        throw new WorkspaceError(
          "The agent must create a new commit for the review feedback.",
          "review_commit_missing",
        );
      }
      const current = head.toLowerCase();
      const state = await inspectReviewState({
        allowedRoots: canonical,
        branch: workspace.branch,
        cwd,
        expectedHead: current,
        options,
        repository,
      });
      await rejectGrafts(state.commonDirectory);
      const descendant = await command(
        run,
        cwd,
        ["merge-base", "--is-ancestor", previous, current],
        options,
      );
      if (descendant === null) {
        throw new WorkspaceError(
          "The pushed review commit is not a descendant of the submitted head.",
          "review_commit_not_descendant",
        );
      }
      const confirmed = await inspectReviewState({
        allowedRoots: canonical,
        branch: workspace.branch,
        cwd,
        expectedHead: current,
        options,
        repository,
      });
      if (confirmed.commonDirectory !== state.commonDirectory) {
        throw new WorkspaceError(
          "The review repository Git metadata changed during verification.",
          "review_git_metadata_changed",
        );
      }
      await rejectGrafts(confirmed.commonDirectory);
      return Object.freeze({
        ...workspace,
        cwd,
        headRefOid: current,
      });
    },

    clear({ repository, number }) {
      associations.delete(`${normalizeRepository(repository)}#${number}`);
    },
  };
}

function publicRepository(candidate, updatedAt) {
  const [owner, name] = candidate.repository.split("/");
  return Object.freeze({
    repository: candidate.repository,
    owner,
    name,
    defaultBranch: candidate.defaultBranch,
    branches: Object.freeze([...candidate.branches]),
    updatedAt,
  });
}

async function inspectRepository(run, roots, candidate, options = {}) {
  const top = await command(
    run,
    candidate,
    ["rev-parse", "--show-toplevel"],
    options,
  );
  if (!top) return null;

  let cwd;
  try {
    cwd = await realpath(top);
  } catch {
    return null;
  }
  if (!roots.some((root) => isInside(root, cwd))) return null;

  const origin = await command(
    run,
    cwd,
    ["config", "--get", "remote.origin.url"],
    options,
  );
  const repository = repositoryFromOrigin(origin);
  const common = await command(
    run,
    cwd,
    ["rev-parse", "--git-common-dir"],
    options,
  );
  const refs = await command(
    run,
    cwd,
    ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"],
    options,
  );
  if (!repository || !common || refs === null) return null;

  let commonDirectory;
  try {
    commonDirectory = await realpath(
      isAbsolute(common) ? common : resolve(cwd, common),
    );
  } catch {
    return null;
  }
  if (!roots.some((root) => isInside(root, commonDirectory))) return null;

  const branches = [
    ...new Set(
      refs
        .split("\n")
        .map((branch) => branch.trim())
        .filter((branch) => branch !== "HEAD" && validateGitBranch(branch)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (branches.length === 0) return null;

  const symbolic = await command(
    run,
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    options,
  );
  const symbolicDefault = symbolic?.startsWith("origin/")
    ? symbolic.slice("origin/".length)
    : null;
  const defaultBranch = branches.includes(symbolicDefault)
    ? symbolicDefault
    : branches.includes("main")
      ? "main"
      : branches.includes("master")
        ? "master"
        : branches[0];

  let primary = false;
  try {
    const marker = await lstat(join(cwd, ".git"));
    primary =
      marker.isDirectory() &&
      (await realpath(join(cwd, ".git"))) === commonDirectory;
  } catch {
    primary = false;
  }

  return {
    branches,
    commonDirectory,
    cwd,
    defaultBranch,
    origin,
    primary,
    repository,
  };
}

function preferRepository(left, right) {
  if (left.primary !== right.primary) return left.primary ? left : right;
  if (left.cwd.split(sep).length !== right.cwd.split(sep).length) {
    return left.cwd.split(sep).length < right.cwd.split(sep).length
      ? left
      : right;
  }
  return left.cwd.localeCompare(right.cwd) <= 0 ? left : right;
}

export function createTaskRepositoryCatalog({
  root = resolveTaskWorkspaceOptions().repositoryRoot,
  run = execFile,
  discoverRepositories = discover,
  now = () => new Date(),
} = {}) {
  let cached = null;
  let loading = null;

  async function scan() {
    let canonical;
    try {
      canonical = await realpath(root);
    } catch {
      throw new WorkspaceError(
        "The trusted local repository root is unavailable.",
        "repository_root_missing",
      );
    }

    const paths = await discoverRepositories(canonical);
    const byCommonDirectory = new Map();
    for (const path of new Set(paths)) {
      const candidate = await inspectRepository(run, [canonical], path);
      if (!candidate) continue;
      const key = `${candidate.repository}\0${candidate.commonDirectory}`;
      const current = byCommonDirectory.get(key);
      byCommonDirectory.set(
        key,
        current ? preferRepository(current, candidate) : candidate,
      );
    }

    const byRepository = new Map();
    for (const candidate of byCommonDirectory.values()) {
      const current = byRepository.get(candidate.repository);
      byRepository.set(
        candidate.repository,
        current ? preferRepository(current, candidate) : candidate,
      );
    }

    const updatedAt = now().toISOString();
    const records = [...byRepository.values()].sort((left, right) =>
      left.repository.localeCompare(right.repository),
    );
    cached = Object.freeze({
      updatedAt,
      repositories: Object.freeze(
        records.map((record) => publicRepository(record, updatedAt)),
      ),
      records: new Map(records.map((record) => [record.repository, record])),
    });
    return cached;
  }

  async function load(refresh = false) {
    if (cached && !refresh) return cached;
    if (!loading) {
      loading = scan().finally(() => {
        loading = null;
      });
    }
    return loading;
  }

  return Object.freeze({
    async options({ refresh = false } = {}) {
      const catalog = await load(refresh);
      return Object.freeze({
        repositories: catalog.repositories,
        updatedAt: catalog.updatedAt,
      });
    },

    async resolve(repository, base, options = {}) {
      const normalized = normalizeRepository(repository);
      if (!normalized || normalized !== String(repository).toLowerCase()) {
        throw new WorkspaceError(
          "The selected repository is invalid.",
          "repository_invalid",
        );
      }
      if (!validateGitBranch(base)) {
        throw new WorkspaceError(
          "The selected base branch is invalid.",
          "branch_invalid",
        );
      }

      const catalog = await load();
      const selected = catalog.records.get(normalized);
      if (!selected || !selected.branches.includes(base)) {
        throw new WorkspaceError(
          "The selected repository or branch is unavailable.",
          "repository_unavailable",
        );
      }

      const refreshed = await inspectRepository(
        run,
        [await realpath(root)],
        selected.cwd,
        options,
      );
      if (
        !refreshed ||
        refreshed.repository !== normalized ||
        refreshed.commonDirectory !== selected.commonDirectory ||
        !refreshed.branches.includes(base)
      ) {
        throw new WorkspaceError(
          "The selected repository or branch changed.",
          "repository_changed",
        );
      }
      return Object.freeze({
        base,
        cwd: refreshed.cwd,
        origin: refreshed.origin,
        repository: refreshed.repository,
      });
    },

    refresh: () => load(true),
  });
}

const RELEASE_TAG =
  /^(?!-)(?!.*(?:\.\.|@\{|[~^:?*\[\\\s\x00-\x1f\x7f]))[^/]+(?:\/[^/]+)*$/;

export function validateReleaseTag(value) {
  if (typeof value !== "string") return false;
  const components = value.split("/");
  return (
    value !== "" &&
    value !== "@" &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    components.every(
      (component) =>
        component !== "" &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    ) &&
    RELEASE_TAG.test(value)
  );
}

async function verifiedCommand(run, args, options = {}) {
  try {
    const result = await run("git", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return String(result.stdout ?? "").trim();
  } catch {
    throw new WorkspaceError(
      "The release snapshot could not be prepared.",
      "release_workspace_failed",
    );
  }
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function archiveCandidate(run, roots, candidate) {
  const top = await command(run, candidate, [
    ...SAFE_GIT_CONFIGURATION,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (!top) return null;

  let cwd;
  try {
    cwd = await realpath(top);
  } catch {
    return null;
  }
  if (!roots.some((root) => isInside(root, cwd))) return null;

  const origin = await command(run, cwd, [
    ...SAFE_GIT_CONFIGURATION,
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (!origin) return null;
  return { cwd, repository: repositoryFromOrigin(origin) };
}

async function setSnapshotPermissions(path, readonly) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    return;
  }
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    if (!readonly) await chmod(path, 0o700);
    for (const entry of await readdir(path)) {
      await setSnapshotPermissions(join(path, entry), readonly);
    }
    if (readonly) await chmod(path, 0o555);
    return;
  }
  if (details.isFile()) {
    const executable = (details.mode & 0o111) !== 0;
    await chmod(
      path,
      readonly ? (executable ? 0o555 : 0o444) : executable ? 0o700 : 0o600,
    );
  }
}

async function removeEscapingLinks(root, path = root) {
  const details = await lstat(path);
  if (details.isSymbolicLink()) {
    let target = null;
    try {
      target = await realpath(path);
    } catch {
      // Broken links cannot provide useful verification evidence.
    }
    if (!target || !isInside(root, target)) await unlink(path);
    return;
  }
  if (!details.isDirectory()) return;
  for (const entry of await readdir(path)) {
    await removeEscapingLinks(root, join(path, entry));
  }
}

async function hashSnapshotPath(root, path, hash) {
  const details = await lstat(path);
  const name = relative(root, path).split(sep).join("/");
  hash.update(
    `${details.isDirectory() ? "d" : details.isFile() ? "f" : "l"}\0`,
  );
  hash.update(`${name}\0${details.mode & 0o7777}\0`);
  if (details.isSymbolicLink()) {
    hash.update(await readlink(path));
  } else if (details.isFile()) {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("end", resolve);
      stream.once("error", reject);
    });
  } else if (details.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) {
      await hashSnapshotPath(root, join(path, entry), hash);
    }
  }
}

async function snapshotDigest(root) {
  const hash = createHash("sha256");
  await hashSnapshotPath(root, root, hash);
  return hash.digest("hex");
}

function safeDeltaPath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !isAbsolute(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function normalizeTargetDelta(value, repository) {
  if (
    !value ||
    value.version !== 1 ||
    value.repository !== repository ||
    !Number.isSafeInteger(value.pullNumber) ||
    value.pullNumber < 1 ||
    typeof value.baseSha !== "string" ||
    !SHA.test(value.baseSha) ||
    typeof value.headSha !== "string" ||
    !SHA.test(value.headSha) ||
    typeof value.mergeCommitSha !== "string" ||
    !SHA.test(value.mergeCommitSha) ||
    typeof value.mergedAt !== "string" ||
    Number.isNaN(Date.parse(value.mergedAt)) ||
    !Number.isSafeInteger(value.changedFiles) ||
    value.changedFiles < 1 ||
    !Array.isArray(value.files) ||
    value.files.length !== value.changedFiles ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  ) {
    return null;
  }
  const paths = new Set();
  const files = [];
  for (const candidate of value.files) {
    if (
      !candidate ||
      !safeDeltaPath(candidate.path) ||
      paths.has(candidate.path) ||
      !["added", "modified", "removed"].includes(candidate.status) ||
      typeof candidate.sha !== "string" ||
      !SHA.test(candidate.sha) ||
      typeof candidate.patch !== "string" ||
      candidate.patch === "" ||
      candidate.patch.includes("\0") ||
      !Number.isSafeInteger(candidate.additions) ||
      candidate.additions < 0 ||
      !Number.isSafeInteger(candidate.deletions) ||
      candidate.deletions < 0 ||
      !Number.isSafeInteger(candidate.changes) ||
      candidate.changes !== candidate.additions + candidate.deletions
    ) {
      return null;
    }
    paths.add(candidate.path);
    files.push({
      additions: candidate.additions,
      changes: candidate.changes,
      deletions: candidate.deletions,
      path: candidate.path,
      patch: candidate.patch,
      sha: candidate.sha.toLowerCase(),
      status: candidate.status,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const canonical = {
    baseSha: value.baseSha.toLowerCase(),
    changedFiles: value.changedFiles,
    files,
    headSha: value.headSha.toLowerCase(),
    mergeCommitSha: value.mergeCommitSha.toLowerCase(),
    mergedAt: value.mergedAt,
    pullNumber: value.pullNumber,
    repository,
    version: 1,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return digest === value.digest
    ? Object.freeze({ ...canonical, digest })
    : null;
}

async function verifiedRawCommand(run, args, options = {}) {
  try {
    const result = await run("git", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return String(result.stdout ?? "");
  } catch {
    throw new WorkspaceError(
      "The target pull request delta could not be reconstructed.",
      "verification_delta_unavailable",
    );
  }
}

function gitEnvironment() {
  return {
    ...process.env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ATTR_SOURCE: EMPTY_TREE,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function rawManifest(output) {
  const values = output.split("\0");
  if (values.at(-1) === "") values.pop();
  if (values.length % 2 !== 0) return null;
  const entries = [];
  const paths = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/.exec(
        values[index],
      );
    const path = values[index + 1];
    if (!match || !safeDeltaPath(path) || paths.has(path)) return null;
    const [, beforeMode, afterMode, beforeOid, afterOid, status] = match;
    const regular = new Set(["100644", "100755"]);
    if (
      (status === "A" &&
        (beforeMode !== "000000" ||
          !/^0{40}$/.test(beforeOid) ||
          !regular.has(afterMode))) ||
      (status === "D" &&
        (!regular.has(beforeMode) ||
          afterMode !== "000000" ||
          !/^0{40}$/.test(afterOid))) ||
      (status === "M" && (!regular.has(beforeMode) || !regular.has(afterMode)))
    ) {
      return null;
    }
    paths.add(path);
    entries.push({
      afterMode,
      afterOid,
      beforeMode,
      beforeOid,
      path,
      status,
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function localManifest(run, source, before, after, maximumBytes) {
  const output = await verifiedRawCommand(
    run,
    [
      ...SAFE_GIT_CONFIGURATION,
      "--no-replace-objects",
      "-C",
      source,
      "diff-tree",
      "--no-commit-id",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "-r",
      before,
      after,
    ],
    { env: gitEnvironment(), maxBuffer: maximumBytes },
  );
  const manifest = rawManifest(output);
  if (manifest === null) {
    throw new WorkspaceError(
      "The target pull request contains an unsupported Git delta.",
      "verification_delta_unavailable",
    );
  }
  for (const entry of manifest) {
    for (const oid of [entry.beforeOid, entry.afterOid]) {
      if (/^0{40}$/.test(oid)) continue;
      const type = await verifiedCommand(run, [
        ...SAFE_GIT_CONFIGURATION,
        "--no-replace-objects",
        "-C",
        source,
        "cat-file",
        "-t",
        oid,
      ]);
      if (type !== "blob") {
        throw new WorkspaceError(
          "The target pull request references an unsupported Git object.",
          "verification_delta_unavailable",
        );
      }
    }
  }
  return manifest;
}

function sameManifest(left, right) {
  return (
    left.length === right.length &&
    left.every((entry, index) =>
      [
        "afterMode",
        "afterOid",
        "beforeMode",
        "beforeOid",
        "path",
        "status",
      ].every((key) => entry[key] === right[index]?.[key]),
    )
  );
}

function patchFromDiff(output) {
  const marker = output.indexOf("\n@@ ");
  if (marker < 0) return null;
  return output.slice(marker + 1).replace(/\n$/, "");
}

function canonicalPatch(patch) {
  return patch
    .split("\n")
    .map((line) =>
      line.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(?:.*)$/, "$1"),
    )
    .join("\n");
}

async function corroborateDelta(run, source, before, after, manifest, target) {
  if (manifest.length !== target.files.length) return false;
  const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
  for (const file of target.files) {
    const entry = byPath.get(file.path);
    const status = { A: "added", D: "removed", M: "modified" }[entry?.status];
    const blob = file.status === "removed" ? entry?.beforeOid : entry?.afterOid;
    if (!entry || status !== file.status || blob !== file.sha) return false;
    const output = await verifiedRawCommand(
      run,
      [
        ...SAFE_GIT_CONFIGURATION,
        "--no-replace-objects",
        "-C",
        source,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        "--inter-hunk-context=1",
        "--no-color",
        before,
        after,
        "--",
        file.path,
      ],
      {
        env: gitEnvironment(),
        maxBuffer: Buffer.byteLength(file.patch, "utf8") + 256 * 1024,
      },
    );
    const local = patchFromDiff(output);
    if (local === null || canonicalPatch(local) !== canonicalPatch(file.patch))
      return false;
  }
  return true;
}

async function hashFileWithGit(run, path) {
  return verifiedCommand(
    run,
    [
      ...SAFE_GIT_CONFIGURATION,
      "--no-replace-objects",
      "hash-object",
      "--no-filters",
      "--",
      path,
    ],
    { env: gitEnvironment() },
  );
}

function fileMode(details) {
  return (details.mode & 0o111) === 0 ? "100644" : "100755";
}

async function regularPath(root, path) {
  let current = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (
      details.isSymbolicLink() ||
      (index === parts.length - 1 ? !details.isFile() : !details.isDirectory())
    ) {
      throw new WorkspaceError(
        "The target pull request path has an unsupported type.",
        "verification_delta_unavailable",
      );
    }
  }
  return current;
}

async function ensureParent(root, path) {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new WorkspaceError(
          "The target pull request path has an unsupported parent.",
          "verification_delta_unavailable",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function removeEmptyParents(root, path) {
  let current = dirname(join(root, ...path.split("/")));
  while (current !== root && isInside(root, current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function treeProofs(root, path = root, result = new Map()) {
  const details = await lstat(path);
  const name = relative(root, path).split(sep).join("/");
  if (details.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) {
      await treeProofs(root, join(path, entry), result);
    }
  } else if (details.isFile()) {
    result.set(name, {
      digest: await new Promise((resolveDigest, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.once("error", reject);
        stream.once("end", () => resolveDigest(hash.digest("hex")));
      }),
      mode: details.mode & 0o7777,
      type: "file",
    });
  } else if (details.isSymbolicLink()) {
    result.set(name, {
      mode: details.mode & 0o7777,
      target: await readlink(path),
      type: "link",
    });
  }
  return result;
}

function changedProofPaths(before, after) {
  const changed = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path))) {
      changed.push(path);
    }
  }
  return changed.sort();
}

export function createVerificationWorkspaceManager({
  roots = resolveWorkspaceOptions().roots,
  run = execFile,
  discoverRepositories = discover,
  makeTemporary = (prefix) => mkdtemp(prefix),
  remove = (path) => rm(path, { recursive: true, force: true }),
  temporaryRoot = join(homedir(), ".puller", "verification-workspaces"),
} = {}) {
  const manager = {
    async prepare({ commitOid, repository, tag }) {
      const normalized = normalizeRepository(repository);
      if (!normalized || normalized !== repository.toLowerCase()) {
        throw new WorkspaceError(
          "The release repository is invalid.",
          "release_repository_invalid",
        );
      }
      if (!validateReleaseTag(tag)) {
        throw new WorkspaceError(
          "The release tag is invalid.",
          "release_tag_invalid",
        );
      }
      if (typeof commitOid !== "string" || !SHA.test(commitOid)) {
        throw new WorkspaceError(
          "The release commit is invalid.",
          "release_commit_invalid",
        );
      }
      const expected = commitOid.toLowerCase();

      const canonical = await canonicalRoots(roots);
      if (canonical.length === 0) {
        throw new WorkspaceError("No trusted workspace roots are available.");
      }
      const paths = new Set();
      for (const root of canonical) {
        for (const candidate of await discoverRepositories(root))
          paths.add(candidate);
      }
      const candidates = [];
      for (const path of paths) {
        const candidate = await archiveCandidate(run, canonical, path);
        if (candidate?.repository === normalized)
          candidates.push(candidate.cwd);
      }
      candidates.sort();
      if (candidates.length === 0) {
        throw new WorkspaceError(
          "No trusted local worktree matches this release repository.",
          "workspace_missing",
        );
      }

      let source = null;
      for (const candidate of candidates) {
        try {
          await verifiedCommand(run, [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            "-C",
            candidate,
            "cat-file",
            "-e",
            `${expected}^{commit}`,
          ]);
          source = candidate;
          break;
        } catch {
          // Another trusted clone may already contain the pinned release commit.
        }
      }
      if (!source) {
        throw new WorkspaceError(
          "The authorized release commit is not available in a trusted local repository.",
          "release_commit_missing",
        );
      }

      const objectPath = await verifiedCommand(run, [
        ...SAFE_GIT_CONFIGURATION,
        "--no-replace-objects",
        "-C",
        source,
        "rev-parse",
        "--git-path",
        "objects",
      ]);
      let objects;
      try {
        objects = await realpath(
          isAbsolute(objectPath) ? objectPath : resolve(source, objectPath),
        );
      } catch {
        throw new WorkspaceError(
          "The release object store is unavailable.",
          "release_commit_missing",
        );
      }
      if (!canonical.some((root) => isInside(root, objects))) {
        throw new WorkspaceError(
          "The release object store is outside trusted roots.",
          "release_commit_missing",
        );
      }

      let trustedTemporaryRoot;
      try {
        await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
        trustedTemporaryRoot = await realpath(temporaryRoot);
      } catch {
        throw new WorkspaceError(
          "The verification temporary root is unavailable.",
          "release_workspace_failed",
        );
      }
      let created;
      try {
        created = await makeTemporary(
          join(trustedTemporaryRoot, "puller-verify-"),
        );
      } catch {
        throw new WorkspaceError(
          "The verification temporary directory could not be created.",
          "release_workspace_failed",
        );
      }
      let base;
      try {
        base = await realpath(created);
      } catch {
        throw new WorkspaceError(
          "The verification temporary directory is invalid.",
          "release_workspace_failed",
        );
      }
      const location = relative(trustedTemporaryRoot, base);
      if (
        location === "" ||
        location.includes(sep) ||
        !location.startsWith("puller-verify-") ||
        !isInside(trustedTemporaryRoot, base)
      ) {
        throw new WorkspaceError(
          "The verification temporary directory is invalid.",
          "release_workspace_failed",
        );
      }

      const cwd = join(base, "snapshot");
      const executionCwd = join(base, "execution");
      const archive = join(base, "snapshot.tar");
      const metadata = join(base, "repository.git");
      let protectedSnapshot = false;
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        if (protectedSnapshot) {
          try {
            await setSnapshotPermissions(cwd, false);
          } catch {
            // Recursive removal below remains the final containment boundary.
          }
        }
        try {
          await remove(base);
        } catch {
          // Cleanup is best effort and never exposes the local temporary path.
        }
      };

      try {
        await mkdir(cwd);
        await mkdir(join(metadata, "objects", "info"), { recursive: true });
        await mkdir(join(metadata, "refs", "heads"), { recursive: true });
        await writeFile(join(metadata, "HEAD"), "ref: refs/heads/main\n", {
          mode: 0o600,
        });
        await writeFile(join(metadata, "config"), "[core]\n\tbare = true\n", {
          mode: 0o600,
        });
        await writeFile(
          join(metadata, "objects", "info", "alternates"),
          `${objects}\n`,
          {
            mode: 0o600,
          },
        );
        const environment = {
          ...process.env,
          GIT_ATTR_NOSYSTEM: "1",
          GIT_ATTR_SOURCE: EMPTY_TREE,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
        };
        const empty = await verifiedCommand(
          run,
          [
            ...SAFE_GIT_CONFIGURATION,
            `--git-dir=${metadata}`,
            "hash-object",
            "-w",
            "-t",
            "tree",
            "/dev/null",
          ],
          { env: environment },
        );
        if (empty !== EMPTY_TREE) {
          throw new WorkspaceError(
            "The isolated release repository could not be initialized.",
            "release_workspace_failed",
          );
        }
        await verifiedCommand(
          run,
          [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            `--git-dir=${metadata}`,
            "archive",
            "--format=tar",
            `--output=${archive}`,
            expected,
          ],
          { env: environment },
        );
        await run(
          "tar",
          [
            "-xf",
            archive,
            "-C",
            cwd,
            "--no-same-owner",
            "--no-same-permissions",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, TAR_OPTIONS: "" },
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
        );
        await remove(archive);
        await remove(metadata);
        await removeEscapingLinks(cwd);
        await cp(cwd, executionCwd, {
          dereference: false,
          errorOnExist: true,
          recursive: true,
        });
        await setSnapshotPermissions(executionCwd, false);
        await setSnapshotPermissions(cwd, true);
        protectedSnapshot = true;
        const digest = await snapshotDigest(cwd);
        return {
          cleanup,
          commitOid: expected,
          cwd,
          executionCwd,
          headSha: expected,
          repository,
          tag,
          verifyIntegrity: async () => {
            try {
              return (await snapshotDigest(cwd)) === digest;
            } catch {
              return false;
            }
          },
        };
      } catch (error) {
        await cleanup();
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError(
          "The release snapshot could not be prepared.",
          "release_workspace_failed",
        );
      }
    },
  };
  manager.preparePair = async ({
    predecessorCommitOid,
    predecessorTag,
    releaseCommitOid,
    repository,
    tag,
    targetDelta: rawTargetDelta,
  }) => {
    const normalized = normalizeRepository(repository);
    const targetDelta = normalizeTargetDelta(rawTargetDelta, normalized);
    if (
      !normalized ||
      normalized !== String(repository).toLowerCase() ||
      !validateReleaseTag(tag) ||
      !validateReleaseTag(predecessorTag) ||
      typeof predecessorCommitOid !== "string" ||
      !SHA.test(predecessorCommitOid) ||
      typeof releaseCommitOid !== "string" ||
      !SHA.test(releaseCommitOid) ||
      targetDelta === null
    ) {
      throw new WorkspaceError(
        "Complete exact-target verification evidence is required.",
        "verification_delta_unavailable",
      );
    }
    const predecessorOid = predecessorCommitOid.toLowerCase();
    const releaseOid = releaseCommitOid.toLowerCase();
    const required = [
      predecessorOid,
      releaseOid,
      targetDelta.baseSha,
      targetDelta.headSha,
      targetDelta.mergeCommitSha,
    ];
    const canonical = await canonicalRoots(roots);
    if (canonical.length === 0) {
      throw new WorkspaceError("No trusted workspace roots are available.");
    }
    const paths = new Set();
    for (const root of canonical) {
      for (const candidate of await discoverRepositories(root))
        paths.add(candidate);
    }
    const candidates = [];
    for (const path of paths) {
      const candidate = await archiveCandidate(run, canonical, path);
      if (candidate?.repository === normalized) candidates.push(candidate.cwd);
    }
    candidates.sort();
    let source = null;
    for (const candidate of candidates) {
      let complete = true;
      for (const oid of required) {
        try {
          await verifiedCommand(run, [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            "-C",
            candidate,
            "cat-file",
            "-e",
            `${oid}^{commit}`,
          ]);
        } catch {
          complete = false;
          break;
        }
      }
      if (complete) {
        source = candidate;
        break;
      }
    }
    if (source === null) {
      throw new WorkspaceError(
        "The exact pull request Git objects are unavailable locally.",
        "verification_delta_unavailable",
      );
    }
    const ancestry = async (ancestor, descendant) => {
      try {
        await run(
          "git",
          [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            "-C",
            source,
            "merge-base",
            "--is-ancestor",
            ancestor,
            descendant,
          ],
          {
            encoding: "utf8",
            env: gitEnvironment(),
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        );
        return true;
      } catch {
        return false;
      }
    };
    if (
      !(await ancestry(predecessorOid, releaseOid)) ||
      !(await ancestry(targetDelta.mergeCommitSha, releaseOid))
    ) {
      throw new WorkspaceError(
        "The live release does not contain the pinned pull request merge.",
        "verification_delta_unavailable",
      );
    }
    const parentLine = await verifiedCommand(run, [
      ...SAFE_GIT_CONFIGURATION,
      "--no-replace-objects",
      "-C",
      source,
      "rev-list",
      "--parents",
      "-n",
      "1",
      targetDelta.mergeCommitSha,
    ]);
    const parents = parentLine.split(" ");
    if (
      parents[0] !== targetDelta.mergeCommitSha ||
      ![2, 3].includes(parents.length) ||
      !parents.slice(1).every((oid) => SHA.test(oid))
    ) {
      throw new WorkspaceError(
        "The pull request merge topology is unsupported.",
        "verification_delta_unavailable",
      );
    }
    const firstParent = parents[1].toLowerCase();
    if (
      !(await ancestry(predecessorOid, firstParent)) ||
      (parents.length === 3 && parents[2].toLowerCase() !== targetDelta.headSha)
    ) {
      throw new WorkspaceError(
        "The pull request merge topology cannot prove an exact target delta.",
        "verification_delta_unavailable",
      );
    }
    const intendedBase = await verifiedCommand(run, [
      ...SAFE_GIT_CONFIGURATION,
      "--no-replace-objects",
      "-C",
      source,
      "merge-base",
      firstParent,
      targetDelta.headSha,
    ]);
    if (
      !SHA.test(intendedBase) ||
      intendedBase.toLowerCase() !== targetDelta.baseSha
    ) {
      throw new WorkspaceError(
        "The pull request merge base no longer matches GitHub.",
        "verification_delta_unavailable",
      );
    }
    const manifestBytes =
      targetDelta.files.reduce(
        (total, file) => total + Buffer.byteLength(file.path, "utf8") + 256,
        64 * 1024,
      ) * 2;
    const [actual, intended] = await Promise.all([
      localManifest(
        run,
        source,
        firstParent,
        targetDelta.mergeCommitSha,
        manifestBytes,
      ),
      localManifest(
        run,
        source,
        intendedBase,
        targetDelta.headSha,
        manifestBytes,
      ),
    ]);
    let integrated = sameManifest(actual, intended);
    if (parents.length === 3) {
      const [mergedTree, recordedTree] = await Promise.all([
        verifiedCommand(
          run,
          [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            "-C",
            source,
            "merge-tree",
            "--write-tree",
            "--no-messages",
            firstParent,
            targetDelta.headSha,
          ],
          { env: gitEnvironment() },
        ),
        verifiedCommand(run, [
          ...SAFE_GIT_CONFIGURATION,
          "--no-replace-objects",
          "-C",
          source,
          "rev-parse",
          `${targetDelta.mergeCommitSha}^{tree}`,
        ]),
      ]);
      integrated =
        SHA.test(mergedTree) &&
        SHA.test(recordedTree) &&
        mergedTree.toLowerCase() === recordedTree.toLowerCase();
    }
    if (
      actual.length === 0 ||
      intended.length === 0 ||
      !integrated ||
      !(await corroborateDelta(
        run,
        source,
        intendedBase,
        targetDelta.headSha,
        intended,
        targetDelta,
      ))
    ) {
      throw new WorkspaceError(
        "GitHub and local Git cannot prove the exact target pull request delta.",
        "verification_delta_unavailable",
      );
    }
    const delta = intended;

    const predecessor = await manager.prepare({
      commitOid: predecessorOid,
      repository,
      tag: predecessorTag,
    });
    let trustedTemporaryRoot;
    let base = null;
    let protectedSnapshot = false;
    let cleaned = false;
    const cleanupCandidate = async () => {
      if (cleaned) return;
      cleaned = true;
      if (protectedSnapshot && base !== null) {
        await setSnapshotPermissions(join(base, "snapshot"), false).catch(
          () => undefined,
        );
      }
      if (base !== null) await remove(base).catch(() => undefined);
    };
    try {
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      trustedTemporaryRoot = await realpath(temporaryRoot);
      const created = await makeTemporary(
        join(trustedTemporaryRoot, "puller-target-"),
      );
      base = await realpath(created);
      const location = relative(trustedTemporaryRoot, base);
      if (
        location === "" ||
        location.includes(sep) ||
        !location.startsWith("puller-target-") ||
        !isInside(trustedTemporaryRoot, base)
      ) {
        throw new WorkspaceError(
          "The verification target directory is invalid.",
          "verification_delta_unavailable",
        );
      }
      const snapshot = join(base, "snapshot");
      const executionCwd = join(base, "execution");
      const staging = join(base, "staging");
      const archive = join(base, "target.tar");
      const beforeProofs = await treeProofs(predecessor.cwd);
      await cp(predecessor.cwd, snapshot, {
        dereference: false,
        errorOnExist: true,
        recursive: true,
      });
      await setSnapshotPermissions(snapshot, false);
      await mkdir(staging);
      const afterPaths = delta
        .filter((entry) => entry.status !== "D")
        .map((entry) => entry.path);
      if (afterPaths.length > 0) {
        await verifiedCommand(
          run,
          [
            ...SAFE_GIT_CONFIGURATION,
            "--no-replace-objects",
            "-C",
            source,
            "archive",
            "--format=tar",
            `--output=${archive}`,
            targetDelta.headSha,
            "--",
            ...afterPaths,
          ],
          { env: gitEnvironment() },
        );
        await run(
          "tar",
          [
            "-xf",
            archive,
            "-C",
            staging,
            "--no-same-owner",
            "--no-same-permissions",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, TAR_OPTIONS: "" },
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
        );
        await remove(archive);
        await removeEscapingLinks(staging);
        const staged = await treeProofs(staging);
        if (
          [...staged.keys()].sort().join("\0") !==
          [...afterPaths].sort().join("\0")
        ) {
          throw new WorkspaceError(
            "The exact target blob archive contained unexpected paths.",
            "verification_delta_unavailable",
          );
        }
      }
      for (const entry of delta) {
        const existing = await regularPath(snapshot, entry.path);
        if (entry.status === "A") {
          if (existing !== null) {
            throw new WorkspaceError(
              "The predecessor does not match the target delta preimage.",
              "verification_delta_unavailable",
            );
          }
        } else if (
          existing === null ||
          (await hashFileWithGit(run, existing)) !== entry.beforeOid ||
          fileMode(await lstat(existing)) !== entry.beforeMode
        ) {
          throw new WorkspaceError(
            "The predecessor does not match the target delta preimage.",
            "verification_delta_unavailable",
          );
        }
        if (entry.status === "D") {
          await rm(existing);
          await removeEmptyParents(snapshot, entry.path);
          continue;
        }
        const staged = await regularPath(staging, entry.path);
        if (
          staged === null ||
          (await hashFileWithGit(run, staged)) !== entry.afterOid ||
          fileMode(await lstat(staged)) !== entry.afterMode
        ) {
          throw new WorkspaceError(
            "The target pull request blob archive did not match its manifest.",
            "verification_delta_unavailable",
          );
        }
        await ensureParent(snapshot, entry.path);
        if (existing !== null) await rm(existing);
        const destination = join(snapshot, ...entry.path.split("/"));
        await cp(staged, destination, {
          dereference: false,
          errorOnExist: true,
        });
        await chmod(destination, entry.afterMode === "100755" ? 0o700 : 0o600);
      }
      await setSnapshotPermissions(snapshot, true);
      protectedSnapshot = true;
      const afterProofs = await treeProofs(snapshot);
      const changed = changedProofPaths(beforeProofs, afterProofs);
      if (
        changed.join("\0") !==
        delta
          .map((entry) => entry.path)
          .sort()
          .join("\0")
      ) {
        throw new WorkspaceError(
          "The synthetic target changed files outside the exact pull request delta.",
          "verification_delta_unavailable",
        );
      }
      await cp(snapshot, executionCwd, {
        dereference: false,
        errorOnExist: true,
        recursive: true,
      });
      await setSnapshotPermissions(executionCwd, false);
      const digest = await snapshotDigest(snapshot);
      const candidate = Object.freeze({
        cleanup: cleanupCandidate,
        cwd: snapshot,
        deltaDigest: targetDelta.digest,
        executionCwd,
        headSha: targetDelta.headSha,
        repository,
        synthetic: true,
        tag,
        verifyIntegrity: async () => {
          try {
            return (await snapshotDigest(snapshot)) === digest;
          } catch {
            return false;
          }
        },
      });
      return Object.freeze({
        candidate,
        deltaDigest: targetDelta.digest,
        predecessor,
        releaseCommitOid: releaseOid,
      });
    } catch (error) {
      await cleanupCandidate();
      await predecessor.cleanup();
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "The exact target pull request workspace could not be prepared.",
        "verification_delta_unavailable",
      );
    }
  };
  return Object.freeze(manager);
}
