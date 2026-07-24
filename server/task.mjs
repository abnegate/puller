import {
  execFile as executeFile,
  spawn as spawnProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  createLineDecoder,
  createStreamRedactor,
  streamingClaudeArguments,
} from "./claude.mjs";
import { agentLabel, migrateAgent, validateAgent } from "./agent.mjs";
import {
  CodexError,
  createCodexInvocation,
  eventsForCodexLine,
} from "./codex.mjs";
import {
  createTaskRepositoryCatalog,
  resolveTaskWorkspaceOptions,
  validateGitBranch,
} from "./workspace.mjs";

const execFile = promisify(executeFile);
const IDENTIFIER = /^[A-Za-z0-9_-]{8,80}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_PHASES = new Set([
  "queued",
  "preparing",
  "pushing",
  "opening-pr",
  "running",
]);
const MANIFEST_VERSION = 2;
const DEFAULT_PROMPT_LIMIT = 32 * 1024;
const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_REPLAY_LIMIT = 1024 * 1024;
const DEFAULT_LINE_LIMIT = 1024 * 1024;
const DEFAULT_RUNTIME = 60 * 60 * 1_000;
const DEFAULT_KILL_GRACE = 2_000;
const CANCEL_RECONCILE_TIMEOUT = 5_000;
const RECOVERY_RECONCILE_TIMEOUT = 5_000;
const SAFE_GIT_CONFIGURATION = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

export class TaskError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "TaskError";
    this.status = status;
    this.code = code;
  }
}

class TaskCancellation extends Error {}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function normalizeTitle(value, prompt) {
  const supplied = typeof value === "string" ? value.trim() : "";
  const firstLine =
    prompt
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? "New task";
  const title = supplied || firstLine;
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
}

export function validateTaskStartInput(
  value,
  promptLimit = DEFAULT_PROMPT_LIMIT,
  createId = randomUUID,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskError(400, "invalid_request", "The task request is invalid.");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (
    prompt === "" ||
    prompt.includes("\0") ||
    byteLength(prompt) > promptLimit
  ) {
    throw new TaskError(
      400,
      "prompt_invalid",
      "Enter a task prompt of 32 KiB or less.",
    );
  }
  const repository =
    typeof value.repository === "string" ? value.repository.toLowerCase() : "";
  if (
    !REPOSITORY.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TaskError(
      400,
      "repository_invalid",
      "Select a trusted local repository.",
    );
  }
  if (!validateGitBranch(value.base)) {
    throw new TaskError(
      400,
      "branch_invalid",
      "Select a valid remote base branch.",
    );
  }
  const id = value.id === undefined ? createId() : value.id;
  if (typeof id !== "string" || !IDENTIFIER.test(id)) {
    throw new TaskError(
      400,
      "task_id_invalid",
      "The task identifier is invalid.",
    );
  }
  return Object.freeze({
    agent: validateAgent(value.agent),
    base: value.base,
    id,
    prompt,
    repository,
    title: normalizeTitle(value.title, prompt),
  });
}

function sameInput(left, right) {
  return (
    left.agent === right.agent &&
    left.base === right.base &&
    left.id === right.id &&
    left.prompt === right.prompt &&
    left.repository === right.repository &&
    left.title === right.title
  );
}

function publicTask(task) {
  const value = {
    agent: task.agent,
    id: task.id,
    repository: task.repository,
    title: task.title,
    base: task.base,
    phase: task.phase,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.branch) value.branch = task.branch;
  if (task.worktree) value.worktree = task.worktree;
  if (task.pullRequest) value.pullRequest = { ...task.pullRequest };
  if (task.error) value.error = task.error;
  return Object.freeze(value);
}

function slug(value) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 42);
  return normalized || "task";
}

function isInside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function taskMarker(id) {
  return `<!-- puller-task:${id} -->`;
}

function taskBody(input) {
  return [
    taskMarker(input.id),
    "## Task",
    "",
    input.prompt,
    "",
    `_This draft pull request was opened by Puller before ${agentLabel(input.agent)} started._`,
  ].join("\n");
}

function taskPrompt(task, input) {
  return [
    `You are implementing task ${task.id} in ${task.repository}.`,
    `An existing draft pull request is already open: ${task.pullRequest.url}`,
    `The checked-out task branch is ${task.branch}, based on ${task.base}.`,
    "",
    input.agent === "codex"
      ? "Implement the task below completely. Inspect the repository, make the changes, add or update tests, and run the relevant validation. Do not use Git or publish remote state; Puller will validate, commit, and push the intended changes after you finish."
      : "Implement the task below completely. Inspect the repository, make the changes, add or update tests, run the relevant validation, commit every intended change, and push this existing branch to origin.",
    "Do not create another branch, worktree, pull request, or release. Do not close or merge the existing pull request.",
    "",
    input.prompt,
  ].join("\n");
}

function parsePullURL(value, repository) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
  );
  if (
    !match ||
    `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()
  )
    return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    number,
    url: `https://github.com/${repository.toLowerCase()}/pull/${number}`,
  };
}

function confirmedPull(value, task, input) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.isDraft !== true ||
    value.state !== "OPEN" ||
    value.isCrossRepository !== false ||
    value.headRefName !== task.branch ||
    typeof value.headRefOid !== "string" ||
    value.headRefOid.toLowerCase() !== task.headRefOid ||
    value.baseRefName !== input.base ||
    typeof value.body !== "string" ||
    !value.body.includes(taskMarker(task.id))
  )
    return null;
  const pull = parsePullURL(value.url, input.repository);
  if (!pull || value.number !== pull.number) return null;
  return pull;
}

function commandEnvironment(environment) {
  return {
    ...environment,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function processError(error, fallback) {
  if (error instanceof TaskError || error instanceof TaskCancellation)
    return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR")
    return new TaskCancellation();
  if (
    Number.isSafeInteger(error?.status) &&
    typeof error?.code === "string" &&
    typeof error?.message === "string"
  ) {
    return new TaskError(error.status, error.code, error.message);
  }
  return new TaskError(500, "task_failed", fallback);
}

function safeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function canonicalWorktree(value, root) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAbsolute(value)) return null;
  try {
    const canonical = realpathSync(value);
    if (canonical === root || !isInside(root, canonical)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function persistedTask(value, input, worktreeRoot) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.base !== input.base ||
    migrateAgent(value.agent) !== input.agent ||
    value.id !== input.id ||
    value.repository !== input.repository ||
    value.title !== input.title ||
    (!ACTIVE_PHASES.has(value.phase) && !TERMINAL_PHASES.has(value.phase)) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.branch !== undefined && !validateGitBranch(value.branch)) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error === "")) ||
    (value.headRefOid !== undefined && !SHA.test(value.headRefOid))
  ) {
    return null;
  }

  const worktree = canonicalWorktree(value.worktree, worktreeRoot);
  if (worktree === null) return null;

  let pullRequest;
  if (value.pullRequest !== undefined) {
    const parsed = parsePullURL(value.pullRequest?.url, input.repository);
    if (!parsed || parsed.number !== value.pullRequest?.number) return null;
    pullRequest = parsed;
  }
  return {
    agent: input.agent,
    base: input.base,
    createdAt: value.createdAt,
    id: input.id,
    phase: value.phase,
    repository: input.repository,
    title: input.title,
    updatedAt: value.updatedAt,
    ...(value.branch ? { branch: value.branch } : {}),
    ...(worktree ? { worktree } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(value.error ? { error: value.error } : {}),
    ...(value.headRefOid ? { headRefOid: value.headRefOid.toLowerCase() } : {}),
  };
}

function persistedManifest(value, worktreeRoot) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.version !== 1 && value.version !== MANIFEST_VERSION) ||
    !value.input ||
    !value.task ||
    !Array.isArray(value.events)
  )
    return null;
  try {
    const migratedInput =
      value.version === 1 && value.input?.agent === undefined
        ? { ...value.input, agent: "claude" }
        : value.input;
    const input = validateTaskStartInput(
      migratedInput,
      DEFAULT_PROMPT_LIMIT,
      () => migratedInput.id,
    );
    const task = persistedTask(value.task, input, worktreeRoot);
    if (!task) return null;
    let sequence = 0;
    const events = [];
    for (const event of value.events) {
      if (!Number.isSafeInteger(event?.sequence) || event.sequence <= sequence)
        continue;
      if (event.type === "task") {
        const eventTask = persistedTask(event.task, input, worktreeRoot);
        if (!eventTask) continue;
        events.push({
          sequence: event.sequence,
          task: publicTask(eventTask),
          type: "task",
        });
        sequence = event.sequence;
      } else if (
        event.type === "output" &&
        event.id === input.id &&
        (event.stream === "stdout" || event.stream === "stderr") &&
        typeof event.text === "string"
      ) {
        events.push({
          id: input.id,
          sequence: event.sequence,
          stream: event.stream,
          text: event.text,
          type: "output",
        });
        sequence = event.sequence;
      }
    }
    return {
      events,
      input,
      task,
    };
  } catch {
    return null;
  }
}

function quarantineManifest(stateRoot, name) {
  try {
    const quarantine = join(stateRoot, "quarantine");
    mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    renameSync(
      join(stateRoot, name),
      join(quarantine, `${name}.${randomUUID()}`),
    );
  } catch {
    // An unreadable manifest remains ignored if it cannot be quarantined.
  }
}

function loadManifests(stateRoot, worktreeRoot) {
  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
    const canonicalWorktreeRoot = realpathSync(worktreeRoot);
    const records = [];
    for (const name of readdirSync(stateRoot)) {
      if (!name.endsWith(".json")) continue;
      try {
        const manifest = persistedManifest(
          JSON.parse(readFileSync(join(stateRoot, name), "utf8")),
          canonicalWorktreeRoot,
        );
        if (manifest) {
          records.push(manifest);
        } else {
          quarantineManifest(stateRoot, name);
        }
      } catch {
        quarantineManifest(stateRoot, name);
      }
    }
    return records;
  } catch {
    return [];
  }
}

export function createTaskManager({
  scheduler = null,
  environment = process.env,
  catalog = null,
  run = execFile,
  spawn = spawnProcess,
  createId = randomUUID,
  now = () => new Date(),
  defer = (callback) => setImmediate(callback),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  kill = process.kill.bind(process),
  promptLimit = DEFAULT_PROMPT_LIMIT,
  lineLimit = DEFAULT_LINE_LIMIT,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  replayLimit = DEFAULT_REPLAY_LIMIT,
  runtime = DEFAULT_RUNTIME,
  killGrace = DEFAULT_KILL_GRACE,
  recoveryTimeout = RECOVERY_RECONCILE_TIMEOUT,
  stateRoot: configuredStateRoot,
  worktreeRoot: configuredWorktreeRoot,
  repositoryRoot,
  write = writeFile,
  prepareCodex = createCodexInvocation,
} = {}) {
  const configured = resolveTaskWorkspaceOptions(environment);
  const stateRoot = resolve(configuredStateRoot || configured.stateRoot);
  const worktreeRoot = resolve(
    configuredWorktreeRoot || configured.worktreeRoot,
  );
  const repositories =
    catalog ??
    createTaskRepositoryCatalog({
      root: repositoryRoot || configured.repositoryRoot,
      run,
    });
  const records = new Map();
  let stopping = false;

  function timestamp() {
    return now().toISOString();
  }

  function notify(record) {
    for (const wake of record.waiters) wake();
    record.waiters.clear();
  }

  function trimReplay(record) {
    while (record.events.length > 1 && record.replayBytes > replayLimit) {
      record.replayBytes -= byteLength(JSON.stringify(record.events.shift()));
    }
  }

  function manifest(record) {
    return JSON.stringify({
      version: MANIFEST_VERSION,
      input: record.input,
      task: record.task,
      events: record.events,
    });
  }

  function writeLatest(record) {
    if (record.writer) return record.writer;

    const writer = (async () => {
      while (record.persistedRevision < record.revision) {
        const revision = record.revision;
        const content = manifest(record);
        await mkdir(stateRoot, { recursive: true, mode: 0o700 });
        const target = join(stateRoot, `${record.task.id}.json`);
        const temporary = join(
          stateRoot,
          `.${record.task.id}.${createId()}.tmp`,
        );
        await write(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
        record.persistedRevision = revision;
      }
    })();
    record.writer = writer;
    void writer.then(
      () => {
        if (record.writer !== writer) return;
        record.writer = null;
        if (record.persistedRevision < record.revision) {
          void writeLatest(record).catch(() => {});
        }
      },
      () => {
        if (record.writer === writer) record.writer = null;
      },
    );
    return writer;
  }

  function dirty(record) {
    record.revision += 1;
    void writeLatest(record).catch(() => {});
  }

  async function persist(record) {
    const revision = record.revision;
    while (record.persistedRevision < revision) {
      await writeLatest(record);
    }
  }

  function append(record, event) {
    record.sequence += 1;
    const sequenced = Object.freeze({ sequence: record.sequence, ...event });
    record.events.push(sequenced);
    record.replayBytes += byteLength(JSON.stringify(sequenced));
    trimReplay(record);
    notify(record);
    dirty(record);
    return sequenced;
  }

  async function update(record, patch) {
    Object.assign(record.task, patch, { updatedAt: timestamp() });
    append(record, { type: "task", task: publicTask(record.task) });
    await persist(record);
  }

  function output(record, stream, text) {
    if (TERMINAL_PHASES.has(record.task.phase) || record.failure || text === "")
      return;
    append(record, {
      type: "output",
      id: record.task.id,
      stream,
      text,
    });
  }

  function throwIfCancelled(record) {
    if (record.cancelled || stopping) throw new TaskCancellation();
  }

  async function execute(executable, args, options = {}) {
    try {
      return await run(executable, args, {
        encoding: "utf8",
        env: commandEnvironment(environment),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...options,
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORT_ERR")
        throw new TaskCancellation();
      throw error;
    }
  }

  async function uniqueBranch(source, input, signal) {
    const prefix = `puller/${slug(input.title)}-${input.id.slice(0, 8).toLowerCase()}`;
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const branch = suffix === 0 ? prefix : `${prefix}-${suffix + 1}`;
      if (!validateGitBranch(branch)) continue;
      const reference = `refs/heads/${branch}`;
      try {
        await execute(
          "git",
          ["-C", source, "show-ref", "--verify", "--quiet", reference],
          { signal },
        );
      } catch (error) {
        if (error instanceof TaskCancellation) throw error;
        if (error?.code === 1 || error?.status === 1) {
          try {
            await execute(
              "git",
              [
                ...SAFE_GIT_CONFIGURATION,
                "-C",
                source,
                "ls-remote",
                "--exit-code",
                "--heads",
                "origin",
                reference,
              ],
              { signal },
            );
          } catch (remoteError) {
            if (remoteError instanceof TaskCancellation) throw remoteError;
            if (remoteError?.code === 2 || remoteError?.status === 2)
              return branch;
            throw new TaskError(
              500,
              "branch_unavailable",
              "The remote task branch could not be checked.",
            );
          }
          continue;
        }
        throw new TaskError(
          500,
          "branch_unavailable",
          "The local task branch could not be checked.",
        );
      }
    }
    throw new TaskError(
      409,
      "branch_unavailable",
      "A unique task branch could not be created.",
    );
  }

  async function prepareWorktree(record, selected) {
    const signal = record.controller.signal;
    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-C",
        selected.cwd,
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${record.input.base}:refs/remotes/origin/${record.input.base}`,
      ],
      { signal },
    );
    throwIfCancelled(record);

    const refreshed = await repositories.resolve(
      record.input.repository,
      record.input.base,
      {
        signal,
      },
    );
    if (
      refreshed.cwd !== selected.cwd ||
      refreshed.origin !== selected.origin
    ) {
      throw new TaskError(
        409,
        "repository_changed",
        "The selected local repository changed.",
      );
    }
    const oidResult = await execute(
      "git",
      [
        "-C",
        selected.cwd,
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${record.input.base}^{commit}`,
      ],
      { signal },
    );
    const oid = String(oidResult.stdout ?? "")
      .trim()
      .toLowerCase();
    if (!SHA.test(oid)) {
      throw new TaskError(
        409,
        "branch_unavailable",
        "The selected remote base branch is unavailable.",
      );
    }

    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(worktreeRoot);
    const name = `${slug(record.input.title)}-${record.input.id.toLowerCase()}`;
    const worktree = join(canonicalRoot, name);
    if (
      !isInside(canonicalRoot, worktree) ||
      worktree === canonicalRoot ||
      existsSync(worktree)
    ) {
      throw new TaskError(
        409,
        "worktree_unavailable",
        "A unique task worktree could not be created.",
      );
    }
    const branch = await uniqueBranch(selected.cwd, record.input, signal);
    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-C",
        selected.cwd,
        "worktree",
        "add",
        "-b",
        branch,
        worktree,
        oid,
      ],
      { signal },
    );
    const canonicalWorktree = await realpath(worktree);
    if (
      !isInside(canonicalRoot, canonicalWorktree) ||
      canonicalWorktree === canonicalRoot
    ) {
      throw new TaskError(
        500,
        "worktree_unavailable",
        "The task worktree escaped its trusted root.",
      );
    }
    await update(record, { branch, worktree: canonicalWorktree });

    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Puller",
        "-c",
        "user.email=puller@localhost",
        "-C",
        canonicalWorktree,
        "commit",
        "--allow-empty",
        "--no-verify",
        "-m",
        `chore: start ${record.input.title}`,
      ],
      { signal },
    );
    const head = await execute(
      "git",
      ["-C", canonicalWorktree, "rev-parse", "--verify", "HEAD"],
      { signal },
    );
    const headRefOid = String(head.stdout ?? "")
      .trim()
      .toLowerCase();
    if (!SHA.test(headRefOid)) {
      throw new TaskError(
        500,
        "branch_unavailable",
        "The task branch could not be verified.",
      );
    }
    record.task.headRefOid = headRefOid;
    return canonicalWorktree;
  }

  async function push(record) {
    await update(record, { phase: "pushing" });
    const reference = `refs/heads/${record.task.branch}`;
    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-C",
        record.task.worktree,
        "push",
        "--no-verify",
        "--set-upstream",
        `--force-with-lease=${reference}:`,
        "origin",
        `${reference}:${reference}`,
      ],
      { signal: record.controller.signal },
    );
  }

  async function viewPull(
    record,
    reference,
    signal = record.controller.signal,
  ) {
    const result = await execute(
      "gh",
      [
        "pr",
        "view",
        reference,
        "--repo",
        record.input.repository,
        "--json",
        "number,url,body,isDraft,state,headRefName,headRefOid,baseRefName,isCrossRepository",
      ],
      signal ? { signal } : {},
    );
    return confirmedPull(
      safeJSON(String(result.stdout ?? "")),
      record.task,
      record.input,
    );
  }

  async function reconcilePull(record, signal = record.controller.signal) {
    const result = await execute(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        record.input.repository,
        "--head",
        record.task.branch,
        "--state",
        "open",
        "--json",
        "number,url,body,isDraft,state,headRefName,headRefOid,baseRefName,isCrossRepository",
      ],
      signal ? { signal } : {},
    );
    const values = safeJSON(String(result.stdout ?? ""));
    if (!Array.isArray(values)) return null;
    const matches = values
      .map((value) => confirmedPull(value, record.task, record.input))
      .filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
  }

  async function openPull(record) {
    await update(record, { phase: "opening-pr" });
    let created = null;
    let cancelled = false;
    try {
      const result = await execute(
        "gh",
        [
          "pr",
          "create",
          "--draft",
          "--repo",
          record.input.repository,
          "--base",
          record.input.base,
          "--head",
          record.task.branch,
          "--title",
          record.input.title,
          "--body",
          taskBody(record.input),
        ],
        { signal: record.controller.signal },
      );
      created = parsePullURL(
        String(result.stdout ?? ""),
        record.input.repository,
      );
    } catch (error) {
      if (error instanceof TaskCancellation) cancelled = true;
      // `gh` can lose the response after GitHub creates the PR. Reconcile by both branch and marker.
    }

    let pull = null;
    if (created && !cancelled) {
      try {
        pull = await viewPull(record, created.url);
      } catch (error) {
        if (error instanceof TaskCancellation) cancelled = true;
      }
    }
    try {
      pull ??= await reconcilePull(record, record.controller.signal);
    } catch (error) {
      if (!(error instanceof TaskCancellation)) throw error;
      cancelled = true;
    }
    if (cancelled && !pull) {
      try {
        pull = await reconcilePull(
          record,
          AbortSignal.timeout(CANCEL_RECONCILE_TIMEOUT),
        );
      } catch (error) {
        if (!(error instanceof TaskCancellation)) throw error;
      }
    }
    if (pull) await update(record, { pullRequest: pull });
    if (cancelled) throw new TaskCancellation();
    if (!pull) {
      throw new TaskError(
        502,
        "pull_request_unconfirmed",
        "The draft pull request could not be confirmed.",
      );
    }
  }

  function terminate(
    record,
    signal = record.input.agent === "codex" ? "SIGINT" : "SIGTERM",
  ) {
    if (!record.child || record.childClosed) return;
    try {
      kill(-record.child.pid, signal);
    } catch {
      try {
        record.child.kill(signal);
      } catch {
        // The one-shot process may already have exited.
      }
    }
  }

  function release(record, force = false) {
    clearTimer(record.runtimeTimer);
    record.runtimeTimer = null;
    if (record.released || (record.child && !record.childClosed && !force))
      return;
    record.released = true;
    clearTimer(record.killTimer);
    record.killTimer = null;
    clearTimer(record.forceTimer);
    record.forceTimer = null;
    record.reservation?.release();
    record.reservation = null;
  }

  function scheduleKill(record) {
    if (!record.child || record.childClosed || record.killDone)
      return record.killDone;
    record.killDone = new Promise((resolveKill) => {
      record.resolveKill = resolveKill;
    });
    record.killTimer = setTimer(() => {
      record.killTimer = null;
      terminate(record, record.input.agent === "codex" ? "SIGTERM" : "SIGKILL");
      record.forceTimer = setTimer(() => {
        record.forceTimer = null;
        if (record.input.agent === "codex") terminate(record, "SIGKILL");
        release(record, true);
        record.resolveKill?.();
        record.resolveKill = null;
      }, killGrace);
      record.forceTimer.unref?.();
    }, killGrace);
    record.killTimer.unref?.();
    return record.killDone;
  }

  function terminateGracefully(record) {
    if (!record.child || record.childClosed) {
      release(record);
      return Promise.resolve();
    }
    terminate(record);
    try {
      const fallback = scheduleKill(record) ?? Promise.resolve();
      return record.childDone
        ? Promise.race([record.childDone, fallback])
        : fallback;
    } catch {
      terminate(record, "SIGKILL");
      release(record, true);
      return Promise.resolve();
    }
  }

  function flushOutput(record, stream = null) {
    for (const name of ["stdout", "stderr"]) {
      if (stream && stream !== name) continue;
      const text = record.redactors?.[name]?.flush() ?? "";
      if (text) output(record, name, text);
    }
  }

  async function finish(record, phase, error) {
    flushOutput(record);
    clearTimer(record.runtimeTimer);
    record.runtimeTimer = null;
    if (TERMINAL_PHASES.has(record.task.phase)) {
      release(record);
      return;
    }
    try {
      await update(record, { phase, ...(error ? { error } : {}) });
    } finally {
      release(record);
    }
  }

  function stop(record, message) {
    if (record.failure || TERMINAL_PHASES.has(record.task.phase)) return;
    flushOutput(record);
    record.failure = message;
    void terminateGracefully(record);
    void finish(record, "failed", message).catch(() => {});
  }

  function closeChild(record, releaseNow = true) {
    if (record.childClosed) return;
    record.childClosed = true;
    clearTimer(record.killTimer);
    record.killTimer = null;
    clearTimer(record.forceTimer);
    record.forceTimer = null;
    record.resolveKill?.();
    record.resolveKill = null;
    flushOutput(record);
    record.resolveChildDone?.();
    if (releaseNow) release(record);
  }

  function createDecoders(record) {
    record.redactors = {
      stderr: createStreamRedactor({ cwd: record.task.worktree }),
      stdout: createStreamRedactor({ cwd: record.task.worktree }),
    };
    const redact = (stream, text) => {
      const ready = record.redactors[stream].push(text);
      if (ready) output(record, stream, ready);
    };
    const label = agentLabel(record.input.agent);
    const limit = () =>
      stop(record, `${label} exceeded the per-line output limit.`);
    return {
      stderr: createLineDecoder({
        maximum: lineLimit,
        onLimit: limit,
        onLine: (line) => {
          if (line) redact("stderr", `${line}\n`);
        },
      }),
      stdout: createLineDecoder({
        maximum: lineLimit,
        onLimit: limit,
        onLine: (line) => {
          if (!line.trim()) return;
          if (record.input.agent === "codex") {
            for (const event of eventsForCodexLine(
              line,
              record.task.worktree,
            )) {
              if (event.type === "protocol") {
                record.codexCompleted = event.status === "completed";
              } else if (event.type === "error") {
                stop(record, event.message);
              } else if (event.type === "text") {
                redact("stdout", event.text);
              } else if (event.type === "tool") {
                flushOutput(record, "stdout");
                output(
                  record,
                  "stdout",
                  `${event.name}${event.status ? ` (${event.status})` : ""}\n`,
                );
              } else if (event.type === "diagnostic") {
                flushOutput(record, "stdout");
                output(record, "stderr", `${event.text}\n`);
              }
            }
            return;
          }
          const value = safeJSON(line);
          const delta =
            value?.type === "stream_event" &&
            value.event?.type === "content_block_delta" &&
            value.event.delta?.type === "text_delta"
              ? value.event.delta.text
              : null;
          if (typeof delta === "string") {
            redact("stdout", delta);
          } else if (value?.type === "system" && value.subtype === "init") {
            flushOutput(record, "stdout");
            output(record, "stdout", "Claude Code started.\n");
          } else if (value === null) {
            flushOutput(record, "stdout");
            output(
              record,
              "stdout",
              "Claude Code emitted an unreadable event.\n",
            );
          }
        },
      }),
    };
  }

  function consume(record, decoder) {
    return (chunk) => {
      if (record.failure || TERMINAL_PHASES.has(record.task.phase)) return;
      record.output += chunk.byteLength;
      if (record.output > outputLimit) {
        stop(
          record,
          `${agentLabel(record.input.agent)} exceeded the total output limit.`,
        );
        return;
      }
      decoder.push(chunk);
    };
  }

  async function publishCodexTask(record) {
    throwIfCancelled(record);
    const head = await execute(
      "git",
      ["-C", record.task.worktree, "rev-parse", "--verify", "HEAD"],
      { signal: record.controller.signal },
    );
    if (
      String(head.stdout ?? "")
        .trim()
        .toLowerCase() !== record.task.headRefOid
    ) {
      throw new TaskError(
        409,
        "task_head_changed",
        "The task branch changed while Codex was running.",
      );
    }
    const status = await execute(
      "git",
      ["-C", record.task.worktree, "status", "--porcelain=v1", "-z"],
      { signal: record.controller.signal },
    );
    if (String(status.stdout ?? "") === "") {
      throw new TaskError(
        409,
        "task_no_changes",
        "Codex completed without making task changes.",
      );
    }
    await execute(
      "git",
      [...SAFE_GIT_CONFIGURATION, "-C", record.task.worktree, "add", "--all"],
      { signal: record.controller.signal },
    );
    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Puller",
        "-c",
        "user.email=puller@localhost",
        "-C",
        record.task.worktree,
        "commit",
        "--no-verify",
        "-m",
        `feat: ${record.input.title}`,
      ],
      { signal: record.controller.signal },
    );
    await execute(
      "git",
      [
        ...SAFE_GIT_CONFIGURATION,
        "-C",
        record.task.worktree,
        "push",
        "--no-verify",
        "origin",
        `HEAD:refs/heads/${record.task.branch}`,
      ],
      { signal: record.controller.signal },
    );
    const next = await execute(
      "git",
      ["-C", record.task.worktree, "rev-parse", "--verify", "HEAD"],
      { signal: record.controller.signal },
    );
    const headRefOid = String(next.stdout ?? "")
      .trim()
      .toLowerCase();
    if (!SHA.test(headRefOid)) {
      throw new TaskError(
        500,
        "task_head_invalid",
        "The published task head could not be verified.",
      );
    }
    const clean = await execute(
      "git",
      ["-C", record.task.worktree, "status", "--porcelain=v1", "-z"],
      { signal: record.controller.signal },
    );
    if (String(clean.stdout ?? "") !== "") {
      throw new TaskError(
        409,
        "task_worktree_dirty",
        "The task worktree was not clean after publishing.",
      );
    }
    record.task.headRefOid = headRefOid;
    if (record.task.pullRequest) {
      record.task.pullRequest = {
        ...record.task.pullRequest,
        headRefOid,
      };
    }
  }

  async function cleanupCodex(record) {
    const invocation = record.codex;
    record.codex = null;
    if (invocation) await invocation.cleanup();
  }

  async function runAgent(record) {
    throwIfCancelled(record);
    const reservation = scheduler
      ? await scheduler.reserveQueued(
          {
            key: `task:${record.task.id}`,
            duplicateCode: "task_running",
            duplicateMessage: "This task is already running.",
          },
          { signal: record.controller.signal },
        )
      : null;
    record.reservation = reservation;
    reservation?.reserveWorkspace(record.task.worktree);
    throwIfCancelled(record);
    await update(record, { phase: "running" });
    throwIfCancelled(record);

    const prompt = taskPrompt(record.task, record.input);
    const decoders = createDecoders(record);
    let child;
    try {
      if (record.input.agent === "codex") {
        record.codex = await prepareCodex({
          environment,
          newTask: true,
          prompt,
          purpose: "task",
          target: record.task.worktree,
        });
        child = spawn(record.codex.command, record.codex.args, {
          cwd: record.codex.cwd,
          detached: true,
          env: record.codex.environment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        if (
          !child.stdin ||
          typeof child.stdin.end !== "function" ||
          typeof child.stdin.once !== "function"
        ) {
          throw new TaskError(
            500,
            "codex_start_failed",
            "Codex could not be started safely.",
          );
        }
      } else {
        child = spawn(
          "claude",
          [
            ...streamingClaudeArguments(),
            "--dangerously-skip-permissions",
            "--",
            prompt,
          ],
          {
            cwd: record.task.worktree,
            detached: true,
            env: {
              ...environment,
              CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
            },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      }
    } catch (cause) {
      await cleanupCodex(record).catch(() => {});
      throw new TaskError(
        500,
        `${record.input.agent}_start_failed`,
        `${agentLabel(record.input.agent)} could not be started.`,
        cause,
      );
    }
    record.child = child;
    record.childDone = new Promise((resolveDone) => {
      record.resolveChildDone = resolveDone;
    });

    try {
      child.once("close", (code, signal) => {
        closeChild(record, record.input.agent !== "codex");
        void (async () => {
          try {
            if (record.shutdown) {
              await finish(
                record,
                "failed",
                "The server stopped before this task completed.",
              );
            } else if (record.cancelled) {
              await finish(record, "cancelled", "Task cancelled.");
            } else if (record.failure) {
              await finish(record, "failed", record.failure);
            } else if (
              record.input.agent === "codex" &&
              (code !== 0 || !record.codexCompleted)
            ) {
              await finish(
                record,
                "failed",
                signal
                  ? "Codex was terminated unexpectedly."
                  : code === 0
                    ? "Codex exited without completing its turn."
                    : "Codex exited with an error.",
              );
            } else if (code === 0) {
              if (record.input.agent === "codex") {
                await publishCodexTask(record);
                await cleanupCodex(record);
              }
              await finish(record, "completed");
            } else {
              await finish(
                record,
                "failed",
                signal
                  ? `${agentLabel(record.input.agent)} was terminated unexpectedly.`
                  : `${agentLabel(record.input.agent)} exited with an error.`,
              );
            }
          } catch (error) {
            await finish(
              record,
              "failed",
              processError(error, "The task could not be published.").message,
            );
          } finally {
            await cleanupCodex(record).catch(() => {});
          }
        })().catch(() => {});
      });
      child.once("error", () => {
        stop(record, `${agentLabel(record.input.agent)} could not be started.`);
      });
      child.stdin?.once?.("error", () => {
        stop(
          record,
          `${agentLabel(record.input.agent)} could not receive the task instructions.`,
        );
      });
      child.stdout?.on("data", consume(record, decoders.stdout));
      child.stdout?.once("end", () => {
        decoders.stdout.end();
        flushOutput(record, "stdout");
      });
      child.stderr?.on("data", consume(record, decoders.stderr));
      child.stderr?.once("end", () => {
        decoders.stderr.end();
        flushOutput(record, "stderr");
      });
      if (record.input.agent === "codex") {
        try {
          child.stdin.end(record.codex.prompt);
        } catch {
          stop(record, "Codex could not receive the task instructions.");
        }
      }
      record.runtimeTimer = setTimer(() => {
        stop(
          record,
          `${agentLabel(record.input.agent)} exceeded the runtime limit.`,
        );
      }, runtime);
      record.runtimeTimer.unref?.();
    } catch {
      record.failure = `${agentLabel(record.input.agent)} could not be started.`;
      await terminateGracefully(record);
      throw new TaskError(
        500,
        `${record.input.agent}_start_failed`,
        record.failure,
      );
    }
  }

  async function prepare(record) {
    try {
      throwIfCancelled(record);
      await update(record, { phase: "preparing" });
      const selected = await repositories.resolve(
        record.input.repository,
        record.input.base,
        {
          signal: record.controller.signal,
        },
      );
      throwIfCancelled(record);
      await prepareWorktree(record, selected);
      throwIfCancelled(record);
      await push(record);
      throwIfCancelled(record);
      await openPull(record);
      throwIfCancelled(record);
      await runAgent(record);
    } catch (caught) {
      const error = processError(caught, "The task could not be prepared.");
      if (record.shutdown || stopping) {
        await finish(
          record,
          "failed",
          "The server stopped before this task completed.",
        );
      } else if (error instanceof TaskCancellation || record.cancelled) {
        await finish(record, "cancelled", "Task cancelled.");
      } else {
        await finish(record, "failed", error.message);
      }
    }
  }

  function recordFor(input, task, events = []) {
    return {
      cancelled: false,
      child: null,
      childClosed: false,
      childDone: null,
      codex: null,
      codexCompleted: false,
      controller: new AbortController(),
      events,
      failure: null,
      forceTimer: null,
      input,
      killDone: null,
      killTimer: null,
      output: 0,
      persistedRevision: 0,
      preparation: null,
      recovery: null,
      redactors: null,
      released: false,
      replayBytes: events.reduce(
        (total, event) => total + byteLength(JSON.stringify(event)),
        0,
      ),
      resolveChildDone: null,
      resolveKill: null,
      reservation: null,
      revision: 0,
      runtimeTimer: null,
      scheduled: false,
      sequence: events.reduce(
        (maximum, event) => Math.max(maximum, event.sequence),
        0,
      ),
      shutdown: false,
      starting: null,
      task,
      waiters: new Set(),
      writer: null,
    };
  }

  async function recoverPull(record) {
    if (
      record.task.pullRequest ||
      !record.task.branch ||
      !record.task.headRefOid
    ) {
      return;
    }
    try {
      const signal = AbortSignal.any([
        record.controller.signal,
        AbortSignal.timeout(recoveryTimeout),
      ]);
      const pull = await reconcilePull(record, signal);
      if (pull && !record.task.pullRequest) {
        await update(record, { pullRequest: pull });
      }
    } catch {
      // Recovery is best-effort and bounded; artifacts remain for manual inspection.
    }
  }

  async function waitForRecovery(recovery, signal) {
    if (!signal) {
      await recovery.catch(() => {});
      return;
    }
    if (signal.aborted) return;
    await new Promise((resolveWait) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolveWait();
      };
      signal.addEventListener("abort", done, { once: true });
      void recovery.then(done, done);
      if (signal.aborted) done();
    });
  }

  for (const recovered of loadManifests(stateRoot, worktreeRoot)) {
    const record = recordFor(recovered.input, recovered.task, recovered.events);
    records.set(record.task.id, record);
    if (ACTIVE_PHASES.has(record.task.phase)) {
      const interrupted = record.task.phase;
      record.task.phase = "failed";
      record.task.error = "The server restarted before this task completed.";
      record.task.updatedAt = timestamp();
      append(record, { type: "task", task: publicTask(record.task) });
      if (interrupted === "opening-pr" || interrupted === "running") {
        record.recovery = recoverPull(record);
      }
    }
  }

  let closing = null;

  return Object.freeze({
    options: (...args) => repositories.options(...args),

    list() {
      return [...records.values()]
        .map((record) => publicTask(record.task))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async start(value) {
      if (stopping)
        throw new TaskError(
          503,
          "shutting_down",
          "The server is shutting down.",
        );
      const input = validateTaskStartInput(value, promptLimit, createId);
      const existing = records.get(input.id);
      if (existing) {
        if (!sameInput(existing.input, input)) {
          throw new TaskError(
            409,
            "task_id_conflict",
            "This task identifier belongs to another request.",
          );
        }
        const startError = await existing.starting;
        if (startError) throw startError;
        return publicTask(existing.task);
      }

      const createdAt = timestamp();
      const task = {
        agent: input.agent,
        base: input.base,
        createdAt,
        id: input.id,
        phase: "queued",
        repository: input.repository,
        title: input.title,
        updatedAt: createdAt,
      };
      const record = recordFor(input, task);
      records.set(input.id, record);
      append(record, { type: "task", task: publicTask(task) });
      record.starting = (async () => {
        try {
          await persist(record);
          await repositories.resolve(input.repository, input.base, {
            signal: record.controller.signal,
          });
          throwIfCancelled(record);
          return null;
        } catch (caught) {
          const error = processError(caught, "The repository is unavailable.");
          if (record.shutdown || stopping) {
            await finish(
              record,
              "failed",
              "The server stopped before this task completed.",
            );
            return new TaskError(
              503,
              "shutting_down",
              "The server is shutting down.",
            );
          }
          if (error instanceof TaskCancellation || record.cancelled) {
            await finish(record, "cancelled", "Task cancelled.");
            return null;
          }
          await finish(record, "failed", error.message);
          return error;
        }
      })();
      const startError = await record.starting;
      record.starting = null;
      if (startError) throw startError;
      if (!TERMINAL_PHASES.has(record.task.phase) && !stopping) {
        record.scheduled = true;
        defer(() => {
          if (stopping || TERMINAL_PHASES.has(record.task.phase)) return;
          record.preparation = prepare(record);
          void record.preparation.catch(() => {});
        });
      }
      return publicTask(record.task);
    },

    subscribe(id, { after = 0, signal } = {}) {
      if (typeof id !== "string" || !IDENTIFIER.test(id)) {
        throw new TaskError(
          400,
          "task_id_invalid",
          "The task identifier is invalid.",
        );
      }
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new TaskError(
          400,
          "sequence_invalid",
          "The replay sequence is invalid.",
        );
      }
      const record = records.get(id);
      if (!record)
        throw new TaskError(404, "task_missing", "The task was not found.");

      return (async function* stream() {
        let cursor = after;
        let recoveryWaited = false;
        while (!signal?.aborted) {
          const available = record.events.filter(
            (event) => event.sequence > cursor,
          );
          for (const event of available) {
            cursor = event.sequence;
            yield event;
          }
          if (TERMINAL_PHASES.has(record.task.phase)) {
            if (!recoveryWaited && record.recovery) {
              recoveryWaited = true;
              await waitForRecovery(record.recovery, signal);
              continue;
            }
            return;
          }
          await new Promise((resolvePromise) => {
            const wake = () => {
              record.waiters.delete(wake);
              signal?.removeEventListener("abort", wake);
              resolvePromise();
            };
            record.waiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
            if (
              signal?.aborted ||
              record.sequence > cursor ||
              TERMINAL_PHASES.has(record.task.phase)
            )
              wake();
          });
        }
      })();
    },

    async cancel(id) {
      if (typeof id !== "string" || !IDENTIFIER.test(id)) {
        throw new TaskError(
          400,
          "task_id_invalid",
          "The task identifier is invalid.",
        );
      }
      const record = records.get(id);
      if (!record)
        throw new TaskError(404, "task_missing", "The task was not found.");
      if (TERMINAL_PHASES.has(record.task.phase))
        return publicTask(record.task);
      record.cancelled = true;
      record.controller.abort();
      void terminateGracefully(record);
      if (record.preparation && !record.child) {
        await record.preparation.catch(() => {});
      }
      await finish(record, "cancelled", "Task cancelled.");
      return publicTask(record.task);
    },

    close() {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        const all = [...records.values()];
        const active = [...records.values()].filter((record) =>
          ACTIVE_PHASES.has(record.task.phase),
        );
        for (const record of all) record.controller.abort();
        for (const record of active) {
          record.shutdown = true;
          void terminateGracefully(record);
          await finish(
            record,
            "failed",
            "The server stopped before this task completed.",
          ).catch(() => {});
        }
        await Promise.allSettled(
          all.flatMap((record) =>
            [record.starting, record.preparation, record.recovery].filter(
              Boolean,
            ),
          ),
        );
        const children = all.filter(
          (record) => record.child && !record.childClosed,
        );
        await Promise.allSettled(children.map(terminateGracefully));
        await Promise.allSettled(all.map((record) => persist(record)));
      })();
      return closing;
    },
  });
}
