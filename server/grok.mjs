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
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
const GROK_NAME = "grok";
const GROK_VERSION = "grok 1.0.5 (5115b46bc909)";
const VERSION = /^grok 1\.0\.5 \(5115b46bc909\)\s*$/;
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
const EDIT_DISALLOWED_TOOLS = "web_search,web_fetch,open_page,image_gen,Agent";
const VERIFICATION_DISALLOWED_TOOLS =
  "run_terminal_cmd,search_replace,write_file,web_search,web_fetch,open_page,image_gen,Agent";
const VERIFICATION_TOOLS = "read_file,grep,list_dir";
const GIT_DENY_RULES = Object.freeze([
  "Bash(git *)",
  "Bash(gh *)",
  "Bash(hub *)",
]);
const VERIFICATION_INSTRUCTIONS = [
  "The target is an immutable release snapshot, but this verification turn has no command or filesystem write tools. Evaluate only the supplied untrusted evidence; do not run commands, modify files, access credentials, or use the network.",
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
const FAILED_STOP_REASONS = new Set([
  "error",
  "refusal",
  "cancelled",
  "max_tokens",
  "max_turn_requests",
  "max_turns_reached",
]);

let executableProof = null;

function cleanText(value, cwd = "") {
  let text = String(value ?? "");
  if (cwd) text = text.replaceAll(cwd, "[workspace]");
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,})\b/g,
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

export class GrokError extends Error {
  constructor(status, code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "GrokError";
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

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

export function defaultGrokSearchDirectories(home = homedir()) {
  return Object.freeze([
    join(home, ".grok", "bin"),
    join(home, ".local", "bin"),
    ...OPTIONAL_PATH_DIRECTORIES,
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

function configuredGrokPath(environment) {
  const value = environment?.GROK_PATH;
  if (typeof value !== "string" || value.trim() === "") return null;
  const path = value.trim();
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "GROK_PATH must be an absolute path to the Grok executable.",
    );
  }
  return path;
}

function discoverGrokCandidates({ directories, environment, path } = {}) {
  if (typeof path === "string" && path !== "") {
    return { exclusive: true, paths: [path] };
  }
  const configured = configuredGrokPath(environment);
  if (configured) {
    return { exclusive: true, paths: [configured] };
  }
  const home =
    typeof environment?.HOME === "string" && environment.HOME !== ""
      ? environment.HOME
      : homedir();
  const search = directories ?? defaultGrokSearchDirectories(home);
  return {
    exclusive: false,
    paths: uniqueDirectories([
      ...search.map((directory) => join(directory, GROK_NAME)),
      ...environmentPath(environment)
        .split(HOST_PATH_SEPARATOR)
        .filter((directory) => directory !== "")
        .map((directory) => join(directory, GROK_NAME)),
    ]),
  };
}

async function canonical(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "A Grok runtime path is invalid.",
    );
  }
  const resolved = await realpath(path);
  const details = await lstat(resolved);
  if (details.isSymbolicLink()) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "A Grok runtime path cannot be a symbolic link.",
    );
  }
  if (kind === "directory" && !details.isDirectory()) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "A Grok runtime directory is invalid.",
    );
  }
  if (kind === "file" && !details.isFile()) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "A Grok runtime file is invalid.",
    );
  }
  return resolved;
}

async function canonicalComponents(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
    throw new GrokError(
      500,
      "grok_path_invalid",
      "A Grok runtime path is invalid.",
    );
  }
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep)) {
    if (component === "") continue;
    current = join(current, component);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw new GrokError(
        500,
        "grok_path_invalid",
        "A Grok runtime path contains a symbolic link.",
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
      throw new GrokError(
        500,
        "grok_state_insecure",
        "Protected Grok state cannot be stored in a global temporary directory.",
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
    throw new GrokError(
      503,
      "grok_unavailable",
      "The supported Grok executable is unavailable.",
    );
  }
  const result = await run(resolved, ["--version"], {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: runtimePath(dirname(resolved)),
    },
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!VERSION.test(String(output).trimEnd())) {
    throw new GrokError(
      503,
      "grok_version_unsupported",
      `Puller supports ${GROK_VERSION}; re-audit the installed Grok version before enabling it.`,
    );
  }
  return Object.freeze({
    device: details.dev,
    inode: details.ino,
    path: resolved,
    size: details.size,
  });
}

export async function resolveGrokExecutable({
  directories,
  environment = process.env,
  path,
  run = execFile,
} = {}) {
  if (!executableProof) {
    const candidates = discoverGrokCandidates({
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
          error instanceof GrokError &&
          error.code === "grok_version_unsupported"
        ) {
          sawUnsupportedVersion = true;
        }
        if (candidates.exclusive) break;
      }
    }
    if (!executableProof) {
      if (candidates.exclusive && lastError instanceof GrokError) {
        throw lastError;
      }
      if (sawUnsupportedVersion) {
        throw new GrokError(
          503,
          "grok_version_unsupported",
          `Puller supports ${GROK_VERSION}; re-audit the installed Grok version before enabling it.`,
        );
      }
      const location = candidates.exclusive ? candidates.paths[0] : null;
      throw new GrokError(
        503,
        "grok_unavailable",
        location
          ? `Grok 1.0.5 is not available at ${location}.`
          : "Grok 1.0.5 is not available. Install the audited Grok CLI or set GROK_PATH to its executable.",
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
    throw new GrokError(
      503,
      "grok_changed",
      "The Grok executable changed after validation; restart Puller to re-audit it.",
    );
  }
  return executableProof.path;
}

export function resetGrokExecutableForTests() {
  executableProof = null;
}

function sourceGrokHome(environment) {
  if (
    typeof environment.GROK_HOME === "string" &&
    environment.GROK_HOME !== "" &&
    !environment.GROK_HOME.includes("\0")
  ) {
    return environment.GROK_HOME;
  }
  return join(
    typeof environment.HOME === "string" && environment.HOME !== ""
      ? environment.HOME
      : homedir(),
    ".grok",
  );
}

async function copyAuthentication(environment, grokHome) {
  const source = join(sourceGrokHome(environment), "auth.json");
  try {
    const canonicalSource = await canonicalComponents(source, "file");
    const destination = join(grokHome, "auth.json");
    await copyFile(canonicalSource, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    throw new GrokError(
      503,
      "grok_auth_unavailable",
      "Grok authentication could not be isolated for this run.",
      error,
    );
  }
}

function childEnvironment(
  environment,
  home,
  grokHome,
  temporary,
  binaryDirectory,
  profile,
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
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_HOME: grokHome,
    GROK_MEMORY: "0",
    GROK_SANDBOX: profile,
    HOME: home,
    LANG: selected.LANG ?? "C.UTF-8",
    LC_ALL: selected.LC_ALL ?? "C.UTF-8",
    PATH: selected.PATH ?? runtimePath(binaryDirectory),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
}

function grokPrompt(prompt, target, purpose) {
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

function purposeBase(purpose) {
  return purpose === "verification" ? "read-only" : "strict";
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

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    if (typeof value !== "string" || value === "" || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

async function sandboxConfiguration({ deniedPaths, profile, purpose, target }) {
  const denied = [];
  for (const path of deniedPaths) {
    denied.push(await canonicalComponents(path));
    denied.push(`${await canonicalComponents(path)}/**`);
  }
  if (purpose !== "verification" && purpose !== "conflict") {
    const metadata = await gitMetadata(target);
    if (metadata) {
      denied.push(metadata);
      denied.push(`${metadata}/**`);
    }
  }
  const lines = [
    `[profiles.${profile}]`,
    `extends = ${tomlString(purposeBase(purpose))}`,
    "restrict_network = true",
  ];
  const uniqueDenied = uniquePaths(denied);
  if (uniqueDenied.length > 0) {
    lines.push(`deny = ${tomlArray(uniqueDenied)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function createGrokInvocation({
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
    throw new TypeError("purpose must identify a supported Grok run.");
  }
  if (typeof prompt !== "string" || prompt === "") {
    throw new TypeError("prompt must be a non-empty string.");
  }
  if (typeof newTask !== "boolean") {
    throw new TypeError("newTask must be a boolean.");
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
    throw new GrokError(
      500,
      "grok_state_insecure",
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
    throw new GrokError(
      500,
      "grok_state_insecure",
      "Grok control state must be outside the target and every Git worktree.",
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
    throw new GrokError(
      500,
      "grok_state_insecure",
      "Grok control state must be outside the target and every Git worktree.",
    );
  }
  const runRoot = await mkdtemp(join(stateRoot, "grok-"));
  await chmod(runRoot, 0o700);
  const runStat = await stat(runRoot);
  let prepared = false;

  try {
    const home = join(runRoot, "home");
    const grokHome = join(home, ".grok");
    const temporary = join(runRoot, "tmp");
    await Promise.all([
      mkdir(grokHome, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { mode: 0o700 }),
    ]);
    await copyAuthentication(environment, grokHome);
    const binary = await resolveGrokExecutable({
      environment,
      path: executable,
      run,
    });
    const binaryDirectory = dirname(binary);
    const profile = purposeProfile(purpose);
    const sandbox = await sandboxConfiguration({
      deniedPaths,
      profile,
      purpose,
      target: canonicalTarget,
    });
    const sandboxPath = join(grokHome, "sandbox.toml");
    await writeFile(sandboxPath, sandbox, { mode: 0o600 });
    await chmod(sandboxPath, 0o600);
    const cwd = canonicalTarget;
    const composed = grokPrompt(prompt, canonicalTarget, purpose);
    const args = [
      "-p",
      composed,
      "--output-format",
      "streaming-json",
      "--cwd",
      cwd,
      "--sandbox",
      profile,
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--verbatim",
      "--no-auto-update",
      "--disallowed-tools",
      purpose === "verification"
        ? VERIFICATION_DISALLOWED_TOOLS
        : EDIT_DISALLOWED_TOOLS,
    ];
    if (purpose === "verification") {
      args.push("--tools", VERIFICATION_TOOLS, "--permission-mode", "dontAsk");
    } else {
      args.push("--always-approve");
    }
    for (const rule of GIT_DENY_RULES) {
      args.push("--deny", rule);
    }
    prepared = true;
    let cleaned = false;
    return Object.freeze({
      agent: "grok",
      args: Object.freeze(args),
      command: binary,
      cwd,
      environment: Object.freeze(
        childEnvironment(
          environment,
          home,
          grokHome,
          temporary,
          binaryDirectory,
          profile,
        ),
      ),
      prompt: composed,
      sandbox,
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
          throw new GrokError(
            500,
            "grok_cleanup_unsafe",
            "Puller refused to remove a replaced Grok runtime directory.",
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

function toolName(value) {
  if (typeof value?.toolName === "string" && value.toolName !== "") {
    return value.toolName;
  }
  if (typeof value?.title === "string" && value.title !== "") {
    return value.title;
  }
  if (typeof value?.kind === "string" && value.kind !== "") {
    return value.kind;
  }
  return "tool";
}

function toolStatus(value) {
  const status = String(value?.status ?? "");
  if (
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "rejected"
  ) {
    return "failed";
  }
  if (status === "completed" || status === "success") return "completed";
  return "started";
}

function failureMessage(value, cwd) {
  return cleanText(
    value?.message ??
      value?.error?.message ??
      value?.data ??
      "Grok reported that the run failed.",
    cwd,
  );
}

function grokErrorEvent(message) {
  return /weekly limit|rate limit|out of credits|no weighted tokens|usage limit|\bquota\b/i.test(
    message,
  )
    ? { type: "error", message, code: "rate_limit" }
    : { type: "error", message };
}

export function eventsForGrokLine(line, cwd = "") {
  if (line === "") return [];
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return [{ type: "diagnostic", text: "Grok emitted an unreadable event." }];
  }

  if (value?.type === "error") {
    return [grokErrorEvent(failureMessage(value, cwd))];
  }
  if (value?.type === "max_turns_reached") {
    return [
      {
        type: "error",
        message: cleanText(
          value.message ?? "Grok stopped after reaching its turn limit.",
          cwd,
        ),
      },
    ];
  }
  if (value?.type === "end") {
    const reason = String(value.stopReason ?? "");
    if (FAILED_STOP_REASONS.has(reason)) {
      return [
        {
          type: "error",
          message: cleanText(value.message ?? `Grok stopped (${reason}).`, cwd),
        },
      ];
    }
    return [{ type: "protocol", status: "completed" }];
  }
  if (value?.type === "text" && typeof value.data === "string") {
    return [{ type: "text", text: value.data }];
  }
  if (value?.type === "tool_call") {
    const events = [
      {
        type: "tool",
        name: cleanText(toolName(value), cwd),
        status: toolStatus(value),
      },
    ];
    if (typeof value.rawOutput === "string" && value.rawOutput !== "") {
      events.push({
        type: "diagnostic",
        text: cleanText(bounded(value.rawOutput), cwd),
      });
    }
    return events;
  }
  if (value?.type === "tool_call_update") {
    const events = [
      {
        type: "tool",
        name: cleanText(toolName(value), cwd),
        status: toolStatus(value),
      },
    ];
    if (typeof value.rawOutput === "string" && value.rawOutput !== "") {
      events.push({
        type: "diagnostic",
        text: cleanText(bounded(value.rawOutput), cwd),
      });
    } else if (
      value.rawOutput &&
      typeof value.rawOutput === "object" &&
      typeof value.rawOutput.output === "string"
    ) {
      events.push({
        type: "diagnostic",
        text: cleanText(bounded(value.rawOutput.output), cwd),
      });
    }
    return events;
  }
  return [];
}

export async function readGrokFixture(path) {
  return readFile(path, "utf8");
}
