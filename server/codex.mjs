import { execFile as executeFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

const execFile = promisify(executeFile);
const CODEX_NAME = "codex";
const CODEX_VERSION = "codex-cli-exec 0.144.6";
const VERSION = /^codex-cli-exec 0\.144\.6\s*$/;
const HOST_PATH_SEPARATOR = ":";
const SAFE_PATH_DIRECTORIES = Object.freeze([
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);
const OPTIONAL_PATH_DIRECTORIES = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/home/linuxbrew/.linuxbrew/bin",
]);
const STANDARD_TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
];
const RUNTIME_ROOTS =
  platform() === "darwin" ? ["/System/Library/OpenSSL"] : [];
const FEATURE_DISABLES = [
  "plugins",
  "apps",
  "remote_plugin",
  "hooks",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "workspace_dependencies",
  "tool_suggest",
  "auth_elicitation",
];
const VERIFICATION_FEATURE_DISABLES = [
  "code_mode_host",
  "shell_tool",
  "unified_exec",
];
const VERIFICATION_INSTRUCTIONS = [
  "The target is an immutable release snapshot, but this verification turn has no command or filesystem tools. Evaluate only the supplied untrusted evidence; do not run commands, modify files, access credentials, or use the network.",
  "Puller independently validates any nominated recipe against immutable predecessor/current source and executes a server-owned command predecessor-first under operating-system confinement. Your output is never authorization.",
  'Your final message must contain exactly one marker. Example: <puller-verification-memory>{"version":1,"outcome":"verified","recipes":[]}</puller-verification-memory>. Outcome must be "verified", "not_verified", or "unavailable". Recipes may only be {"kind":"script","manifestPath":"package.json","name":"test"} or {"kind":"tool","name":"node","sourcePath":"test/example.test.mjs"} shapes, using safe relative paths. Use "verified" when the evidence supports trying a behavioral check; leave recipes empty to request deterministic Puller-owned discovery, or include only advisory candidates for Puller to validate. Use "not_verified" when evidence contradicts the claim and "unavailable" when no safe relevant check is evident. The marker is never proof or execution authority; Puller proves predecessor identity, harness safety, exact-target relevance, and the confined fail-before/pass-after result independently.',
].join("\n");
const SAFE_ENVIRONMENT = [
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TERM",
  "COLORTERM",
];
const MAX_DIAGNOSTIC = 32 * 1024;
const PURPOSES = new Set(["fix", "review", "task", "verification", "conflict"]);

let executableProof = null;

function cleanText(value, cwd = "") {
  let text = String(value ?? "");
  if (cwd) text = text.replaceAll(cwd, "[workspace]");
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-ant-[A-Za-z0-9_-]{12,})\b/g,
      "[secret]",
    )
    .replace(
      /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s]+/gi,
      "[secret]",
    )
    .replace(
      /(^|[\s("'`])\/(?:Users|home|private|tmp|var)\/[^\s)"'`]+/g,
      "$1[path]",
    );
}

export class CodexError extends Error {
  constructor(status, code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "CodexError";
    this.status = status;
    this.code = code;
  }
}

function inside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlInline(entries) {
  return `{${Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")}}`;
}

function profileValue(filesystem) {
  return `{filesystem=${tomlInline(filesystem)},network={enabled=false}}`;
}

export function defaultCodexSearchDirectories(home = homedir()) {
  return Object.freeze([
    ...OPTIONAL_PATH_DIRECTORIES,
    join(home, ".local", "bin"),
  ]);
}

function uniqueDirectories(values) {
  const seen = new Set();
  const directories = [];
  for (const value of values) {
    if (typeof value !== "string" || value === "" || seen.has(value)) continue;
    seen.add(value);
    directories.push(value);
  }
  return directories;
}

export function runtimePath(binaryDirectory) {
  return uniqueDirectories([
    ...SAFE_PATH_DIRECTORIES,
    binaryDirectory,
    ...OPTIONAL_PATH_DIRECTORIES,
  ]).join(HOST_PATH_SEPARATOR);
}

function environmentPath(environment) {
  const value = environment?.PATH;
  return typeof value === "string" && value !== "" && !value.includes("\0")
    ? value
    : "";
}

function configuredCodexPath(environment) {
  const value = environment?.CODEX_PATH;
  if (typeof value !== "string" || value.trim() === "") return null;
  const path = value.trim();
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "CODEX_PATH must be an absolute path to the Codex executable.",
    );
  }
  return path;
}

function discoverCodexCandidates({ directories, environment, path } = {}) {
  if (typeof path === "string" && path !== "") {
    return { exclusive: true, paths: [path] };
  }
  const configured = configuredCodexPath(environment);
  if (configured) {
    return { exclusive: true, paths: [configured] };
  }
  const home =
    typeof environment?.HOME === "string" && environment.HOME !== ""
      ? environment.HOME
      : homedir();
  const search = directories ?? defaultCodexSearchDirectories(home);
  return {
    exclusive: false,
    paths: uniqueDirectories([
      ...search.map((directory) => join(directory, CODEX_NAME)),
      ...environmentPath(environment)
        .split(HOST_PATH_SEPARATOR)
        .filter((directory) => directory !== "")
        .map((directory) => join(directory, CODEX_NAME)),
    ]),
  };
}

function shellPolicy(environment, home, temporary, binaryDirectory) {
  const path =
    typeof environment.PATH === "string" && !environment.PATH.includes("\0")
      ? environment.PATH
      : runtimePath(binaryDirectory);
  return `{inherit="none",set=${tomlInline({
    PATH: path,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  })}}`;
}

async function canonical(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "A Codex runtime path is invalid.",
    );
  }
  const resolved = await realpath(path);
  const details = await lstat(resolved);
  if (details.isSymbolicLink()) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "A Codex runtime path cannot be a symbolic link.",
    );
  }
  if (kind === "directory" && !details.isDirectory()) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "A Codex runtime directory is invalid.",
    );
  }
  if (kind === "file" && !details.isFile()) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "A Codex runtime file is invalid.",
    );
  }
  return resolved;
}

async function canonicalComponents(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new CodexError(
      500,
      "codex_path_invalid",
      "A Codex runtime path is invalid.",
    );
  }
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep)) {
    if (component === "") continue;
    current = join(current, component);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new CodexError(
        500,
        "codex_path_invalid",
        "A Codex runtime path contains a symbolic link.",
      );
    }
  }
  return canonical(absolute, kind);
}

async function tempRoots() {
  const roots = new Set(STANDARD_TEMP_ROOTS);
  for (const path of [tmpdir(), ...STANDARD_TEMP_ROOTS]) {
    try {
      roots.add(await realpath(path));
    } catch {
      // A platform-specific temporary alias may not exist.
    }
  }
  return [...roots];
}

async function requireProtectedRoot(path) {
  const target = await canonicalComponents(path);
  for (const root of await tempRoots()) {
    if (inside(root, target)) {
      throw new CodexError(
        500,
        "codex_state_insecure",
        "Protected Codex state cannot be stored in a global temporary directory.",
      );
    }
  }
  return target;
}

async function belongsToGitWorktree(path) {
  let current = path;
  while (true) {
    try {
      const marker = await lstat(join(current, ".git"));
      if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) {
        return true;
      }
    } catch {
      // This ancestor is not a Git worktree root.
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function executableIdentity(path, run) {
  const resolved = await realpath(path);
  const details = await stat(resolved);
  if (!details.isFile()) {
    throw new CodexError(
      503,
      "codex_unavailable",
      "The supported Codex executable is unavailable.",
    );
  }
  const result = await run(resolved, ["exec", "--version"], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: runtimePath(dirname(resolved)),
    },
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (!VERSION.test(String(result.stdout ?? ""))) {
    throw new CodexError(
      503,
      "codex_version_unsupported",
      `Puller supports ${CODEX_VERSION}; re-audit the installed Codex version before enabling it.`,
    );
  }
  return Object.freeze({
    device: details.dev,
    inode: details.ino,
    path: resolved,
    size: details.size,
  });
}

export async function resolveCodexExecutable({
  directories,
  environment = process.env,
  path,
  run = execFile,
} = {}) {
  if (!executableProof) {
    const candidates = discoverCodexCandidates({
      directories,
      environment,
      path,
    });
    let lastError = null;
    let sawUnsupportedVersion = false;
    for (const candidate of candidates.paths) {
      try {
        executableProof = await executableIdentity(candidate, run);
        lastError = null;
        break;
      } catch (error) {
        executableProof = null;
        lastError = error;
        if (
          error instanceof CodexError &&
          error.code === "codex_version_unsupported"
        ) {
          sawUnsupportedVersion = true;
        }
        if (candidates.exclusive) break;
      }
    }
    if (!executableProof) {
      if (candidates.exclusive && lastError instanceof CodexError) {
        throw lastError;
      }
      if (sawUnsupportedVersion) {
        throw new CodexError(
          503,
          "codex_version_unsupported",
          `Puller supports ${CODEX_VERSION}; re-audit the installed Codex version before enabling it.`,
        );
      }
      const location = candidates.exclusive ? candidates.paths[0] : null;
      throw new CodexError(
        503,
        "codex_unavailable",
        location
          ? `Codex 0.144.6 is not available at ${location}.`
          : "Codex 0.144.6 is not available. Install the audited Codex CLI or set CODEX_PATH to its executable.",
        lastError instanceof Error ? lastError : undefined,
      );
    }
  }
  const details = await stat(executableProof.path);
  if (
    details.dev !== executableProof.device ||
    details.ino !== executableProof.inode ||
    details.size !== executableProof.size
  ) {
    executableProof = null;
    throw new CodexError(
      503,
      "codex_changed",
      "The Codex executable changed after validation; restart Puller to re-audit it.",
    );
  }
  return executableProof.path;
}

export function resetCodexExecutableForTests() {
  executableProof = null;
}

async function copyAuthentication(environment, codexHome) {
  const sourceHome =
    typeof environment.CODEX_HOME === "string" &&
    environment.CODEX_HOME !== "" &&
    !environment.CODEX_HOME.includes("\0")
      ? environment.CODEX_HOME
      : join(
          typeof environment.HOME === "string" && environment.HOME !== ""
            ? environment.HOME
            : homedir(),
          ".codex",
        );
  const source = join(sourceHome, "auth.json");
  try {
    const canonicalSource = await canonicalComponents(source, "file");
    const destination = join(codexHome, "auth.json");
    await copyFile(canonicalSource, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    throw new CodexError(
      503,
      "codex_auth_unavailable",
      "Codex authentication could not be isolated for this run.",
      error,
    );
  }
}

function childEnvironment(
  environment,
  home,
  codexHome,
  temporary,
  binaryDirectory,
) {
  const selected = {};
  for (const name of SAFE_ENVIRONMENT) {
    const value = environment[name];
    if (typeof value === "string" && !value.includes("\0")) {
      selected[name] = value;
    }
  }
  return {
    ...selected,
    CODEX_HOME: codexHome,
    HOME: home,
    LANG: selected.LANG ?? "C.UTF-8",
    LC_ALL: selected.LC_ALL ?? "C.UTF-8",
    PATH: selected.PATH ?? runtimePath(binaryDirectory),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
}

function codexPrompt(prompt, target, purpose) {
  const instruction =
    purpose === "verification"
      ? VERIFICATION_INSTRUCTIONS
      : purpose === "conflict"
        ? "Only the regular files already present in the disposable target mirror may be changed."
        : "Work only inside the trusted target. Do not modify Git metadata or publish remote state; Puller owns Git.";
  return [`Trusted target directory: ${target}`, instruction, "", prompt].join(
    "\n",
  );
}

function purposeProfile(purpose) {
  if (purpose === "verification") return "puller-read";
  if (purpose === "conflict") return "puller-conflict";
  return "puller-edit";
}

async function gitMetadata(target) {
  const candidate = join(target, ".git");
  try {
    return await canonical(candidate, "file");
  } catch {
    try {
      return await canonical(candidate);
    } catch {
      return null;
    }
  }
}

export async function createCodexInvocation({
  deniedPaths = [],
  environment = process.env,
  executable,
  newTask = false,
  prompt,
  purpose,
  run = execFile,
  stateRoot: configuredStateRoot,
  target,
  writablePaths = [],
} = {}) {
  if (!PURPOSES.has(purpose)) {
    throw new TypeError("purpose must identify a supported Codex run.");
  }
  if (typeof prompt !== "string" || prompt === "") {
    throw new TypeError("prompt must be a non-empty string.");
  }
  if (!Array.isArray(deniedPaths)) {
    throw new TypeError("deniedPaths must be an array.");
  }
  if (!Array.isArray(writablePaths) || writablePaths.length > 0) {
    throw new TypeError(
      "Verification agents cannot receive additional writable paths.",
    );
  }
  const canonicalTarget = await canonicalComponents(target);
  if (
    (purpose === "verification" || purpose === "conflict") &&
    (await tempRoots()).some((root) => inside(root, canonicalTarget))
  ) {
    throw new CodexError(
      500,
      "codex_state_insecure",
      "Protected verification and conflict state must be outside global temporary directories.",
    );
  }

  const root = resolve(
    configuredStateRoot ??
      environment.PULLER_AGENT_STATE_ROOT ??
      join(
        typeof environment.HOME === "string" && environment.HOME !== ""
          ? environment.HOME
          : homedir(),
        ".puller",
        "agents",
      ),
  );
  if (
    inside(root, canonicalTarget) ||
    inside(canonicalTarget, root) ||
    (await belongsToGitWorktree(root))
  ) {
    throw new CodexError(
      500,
      "codex_state_insecure",
      "Codex control state must be outside the target and every Git worktree.",
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stateRoot = await requireProtectedRoot(root);
  await chmod(stateRoot, 0o700);
  if (
    inside(stateRoot, canonicalTarget) ||
    inside(canonicalTarget, stateRoot) ||
    (await belongsToGitWorktree(stateRoot))
  ) {
    throw new CodexError(
      500,
      "codex_state_insecure",
      "Codex control state must be outside the target and every Git worktree.",
    );
  }
  const runRoot = await mkdtemp(join(stateRoot, "codex-"));
  await chmod(runRoot, 0o700);
  const runStat = await stat(runRoot);
  let prepared = false;

  try {
    const control = join(runRoot, "control");
    const home = join(runRoot, "home");
    const codexHome = join(home, ".codex");
    const temporary = join(runRoot, "tmp");
    await Promise.all([
      mkdir(control, { mode: 0o700 }),
      mkdir(codexHome, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { mode: 0o700 }),
    ]);
    await copyAuthentication(environment, codexHome);
    const binary = await resolveCodexExecutable({
      environment,
      path: executable,
      run,
    });
    const binaryDirectory = dirname(binary);
    const profile = purposeProfile(purpose);
    const filesystem = {
      ":minimal": "read",
      [await canonical(control)]: "read",
      [await canonical(temporary)]: "write",
      [canonicalTarget]: purpose === "verification" ? "read" : "write",
    };
    for (const path of RUNTIME_ROOTS) {
      try {
        filesystem[await canonical(path)] = "read";
      } catch {
        // Optional system runtime configuration may not exist on every host.
      }
    }
    for (const denied of deniedPaths) {
      filesystem[await canonicalComponents(denied)] = "deny";
    }
    if (purpose !== "verification" && purpose !== "conflict") {
      const metadata = await gitMetadata(canonicalTarget);
      if (metadata) filesystem[metadata] = "read";
    }
    const cwd = newTask ? canonicalTarget : await canonical(control);
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--color",
      "never",
      ...[
        ...FEATURE_DISABLES,
        ...(purpose === "verification" ? VERIFICATION_FEATURE_DISABLES : []),
      ].flatMap((feature) => ["--disable", feature]),
      "-c",
      'web_search="disabled"',
      "-c",
      "tools.experimental_request_user_input.enabled=false",
      "-c",
      `shell_environment_policy=${shellPolicy(
        environment,
        home,
        temporary,
        binaryDirectory,
      )}`,
      "-c",
      `default_permissions=${tomlString(profile)}`,
      "-c",
      `permissions.${profile}=${profileValue(filesystem)}`,
    ];
    if (!newTask) {
      args.push(
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "project_root_markers=[]",
        "-c",
        "skills={bundled={enabled=false},include_instructions=false}",
        "--skip-git-repo-check",
      );
    }
    args.push("-C", cwd, "-");
    prepared = true;
    let cleaned = false;
    return Object.freeze({
      agent: "codex",
      args: Object.freeze(args),
      command: binary,
      cwd,
      environment: Object.freeze(
        childEnvironment(
          environment,
          home,
          codexHome,
          temporary,
          binaryDirectory,
        ),
      ),
      prompt: codexPrompt(prompt, canonicalTarget, purpose),
      target: canonicalTarget,
      temporary,
      async cleanup() {
        if (cleaned) return;
        const details = await lstat(runRoot);
        const current = await realpath(runRoot);
        if (
          details.isSymbolicLink() ||
          current !== runRoot ||
          details.dev !== runStat.dev ||
          details.ino !== runStat.ino ||
          !inside(stateRoot, current)
        ) {
          throw new CodexError(
            500,
            "codex_cleanup_unsafe",
            "Puller refused to remove a replaced Codex runtime directory.",
          );
        }
        await rm(current, { force: true, recursive: true });
        cleaned = true;
      },
    });
  } finally {
    if (!prepared) {
      try {
        const details = await lstat(runRoot);
        if (
          !details.isSymbolicLink() &&
          details.dev === runStat.dev &&
          details.ino === runStat.ino
        ) {
          await rm(runRoot, { force: true, recursive: true });
        }
      } catch {
        // Preparation failure preserves an unsafe replacement for inspection.
      }
    }
  }
}

function bounded(value) {
  const text = String(value ?? "");
  return text.length <= MAX_DIAGNOSTIC
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC)}\n[diagnostic truncated]`;
}

function codexErrorEvent(value, cwd) {
  const message = cleanText(
    value.error?.message ??
      value.message ??
      "Codex reported that the run failed.",
    cwd,
  );
  const text = [message, value.error?.message, value.message]
    .filter((part) => typeof part === "string")
    .join(" ");
  return /weekly limit|rate limit|out of credits|no weighted tokens|usage limit|\bquota\b/i.test(
    text,
  )
    ? { type: "error", message, code: "rate_limit" }
    : { type: "error", message };
}

export function eventsForCodexLine(line, cwd = "") {
  if (line === "") return [];
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return [{ type: "diagnostic", text: "Codex emitted an unreadable event." }];
  }

  if (value?.type === "thread.started") {
    return [{ type: "diagnostic", text: "Codex started." }];
  }
  if (value?.type === "turn.completed") {
    return [{ type: "protocol", status: "completed" }];
  }
  if (value?.type === "turn.failed") {
    return [codexErrorEvent(value, cwd)];
  }
  if (value?.type === "error") {
    return [codexErrorEvent(value, cwd)];
  }
  if (
    (value?.type === "item.started" ||
      value?.type === "item.updated" ||
      value?.type === "item.completed") &&
    value.item?.type === "command_execution"
  ) {
    const events = [];
    if (value.type === "item.started") {
      events.push({
        type: "tool",
        name: cleanText(value.item.command ?? "command", cwd),
        status: "started",
      });
    }
    if (value.type === "item.completed") {
      events.push({
        type: "tool",
        name: cleanText(value.item.command ?? "command", cwd),
        status:
          value.item.status === "completed" && value.item.exit_code === 0
            ? "completed"
            : "failed",
      });
      if (value.item.aggregated_output) {
        events.push({
          type: "diagnostic",
          text: cleanText(bounded(value.item.aggregated_output), cwd),
        });
      }
    }
    return events;
  }
  if (
    value?.type === "item.completed" &&
    value.item?.type === "agent_message" &&
    typeof value.item.text === "string"
  ) {
    return [{ type: "text", text: value.item.text }];
  }
  if (
    (value?.type === "item.started" ||
      value?.type === "item.updated" ||
      value?.type === "item.completed") &&
    value.item?.type === "error"
  ) {
    return [
      {
        type: "diagnostic",
        text: cleanText(
          value.item.message ?? "Codex reported a non-terminal item error.",
          cwd,
        ),
      },
    ];
  }
  return [];
}

export async function readCodexFixture(path) {
  return readFile(path, "utf8");
}
