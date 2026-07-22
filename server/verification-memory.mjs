import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { TextDecoder } from "node:util";

import { validateReleaseTag } from "./workspace.mjs";

const VERSION = 1;
const OPEN_MARKER = "<puller-verification-memory>";
const CLOSE_MARKER = "</puller-verification-memory>";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const RELEASE_ID = /^[1-9]\d*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,63}$/;
const TERM = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_@+.,()\-]+$/;
const TOKEN_CHARACTER = /[A-Za-z0-9_.:@/+\-]/;
const KNOWN_SECRET =
  /(?:^|[^A-Za-z0-9])(?:(?:npm_|gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_.:/+\-]{8,}|glpat-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|AIzaSy[A-Za-z0-9_-]{20,})/i;
const JWT =
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
const ENCODED_SECRET = /[A-Za-z0-9+/_-]{32,}/g;
const LOCK = ".verification-memory.lock";
const LOCK_VERSION = 1;
const LOCK_NONCE = /^[a-f0-9-]{36}$/i;
const MODULE_QUEUES = new Map();
const MANIFESTS = new Set(["composer.json", "package.json"]);
const ROLES = new Set([
  "configuration",
  "documentation",
  "entrypoint",
  "fixture",
  "implementation",
  "manifest",
  "migration",
  "schema",
  "test",
  "workflow",
]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const VERIFICATION_MEMORY_LIMITS = Object.freeze({
  entries: 32,
  fieldBytes: 256,
  fileBytes: 128 * 1024,
  finalMessageBytes: 64 * 1024,
  lockBytes: 256,
  lockLease: 60_000,
  lockRetry: 20,
  lockTimeout: 2_000,
  manifestBytes: 256 * 1024,
  markerBytes: 32 * 1024,
  promptBytes: 32 * 1024,
  recipes: 32,
  sourceBytes: 64 * 1024,
  storeBytes: 2 * 1024 * 1024,
  terms: 8,
  totalRecipes: 128,
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizeRepository(repository, maximum = Number.POSITIVE_INFINITY) {
  if (
    typeof repository !== "string" ||
    byteLength(repository) > maximum ||
    !REPOSITORY.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError("A valid verification-memory repository is required.");
  }
  return repository.toLowerCase();
}

function validRelativePath(value, fieldBytes) {
  if (
    !boundedString(value, fieldBytes) ||
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\")
  ) {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length > 0 &&
    parts.every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && PATH_SEGMENT.test(part),
    )
  );
}

function validName(value, fieldBytes, pattern = NAME) {
  return (
    boundedString(value, fieldBytes) &&
    pattern.test(value) &&
    !secretLike(value)
  );
}

function entropy(value) {
  if (value.length === 0) return 0;
  const frequencies = new Map();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function secretLike(value) {
  if (KNOWN_SECRET.test(value) || JWT.test(value)) return true;
  ENCODED_SECRET.lastIndex = 0;
  for (const match of value.matchAll(ENCODED_SECRET)) {
    const candidate = match[0];
    if (
      /[A-Za-z]/.test(candidate) &&
      /\d/.test(candidate) &&
      new Set(candidate).size >= 12 &&
      entropy(candidate) >= 3.5
    ) {
      return true;
    }
  }
  return false;
}

function validManifestPath(value, fieldBytes) {
  if (!validRelativePath(value, fieldBytes)) return false;
  return MANIFESTS.has(value.split("/").at(-1));
}

function recipeFrom(value, limits) {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (
    value.kind === "file" &&
    exactKeys(value, ["kind", "path", "role"]) &&
    validRelativePath(value.path, limits.fieldBytes) &&
    ROLES.has(value.role)
  ) {
    return { kind: "file", path: value.path, role: value.role };
  }
  if (
    value.kind === "grep" &&
    exactKeys(value, ["kind", "path", "terms"]) &&
    validRelativePath(value.path, limits.fieldBytes) &&
    Array.isArray(value.terms) &&
    value.terms.length > 0 &&
    value.terms.length <= limits.terms &&
    value.terms.every((term) => validName(term, limits.fieldBytes, TERM)) &&
    new Set(value.terms).size === value.terms.length
  ) {
    return { kind: "grep", path: value.path, terms: [...value.terms] };
  }
  if (
    value.kind === "script" &&
    exactKeys(value, ["kind", "manifestPath", "name"]) &&
    validManifestPath(value.manifestPath, limits.fieldBytes) &&
    validName(value.name, limits.fieldBytes)
  ) {
    return {
      kind: "script",
      manifestPath: value.manifestPath,
      name: value.name,
    };
  }
  if (
    value.kind === "tool" &&
    exactKeys(value, ["kind", "name", "sourcePath"]) &&
    validName(value.name, limits.fieldBytes) &&
    validRelativePath(value.sourcePath, limits.fieldBytes)
  ) {
    return { kind: "tool", name: value.name, sourcePath: value.sourcePath };
  }
  return null;
}

function recipesFrom(value, limits) {
  if (!Array.isArray(value) || value.length > limits.recipes) return null;
  const recipes = [];
  const identities = new Set();
  for (const candidate of value) {
    const recipe = recipeFrom(candidate, limits);
    if (!recipe) return null;
    const identity = JSON.stringify(recipe);
    if (identities.has(identity)) return null;
    identities.add(identity);
    recipes.push(recipe);
  }
  return recipes;
}

function configuredLimits(options = {}) {
  const limits = { ...VERIFICATION_MEMORY_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] === undefined) continue;
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) {
      throw new TypeError(`Verification-memory ${key} must be positive.`);
    }
    limits[key] = options[key];
  }
  return limits;
}

function markerCount(content, marker) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(marker, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + marker.length;
  }
}

export function parseVerificationMemoryMarker(content, options = {}) {
  const limits = configuredLimits(options);
  if (
    typeof content !== "string" ||
    byteLength(content) > limits.finalMessageBytes ||
    markerCount(content, OPEN_MARKER) !== 1 ||
    markerCount(content, CLOSE_MARKER) !== 1
  ) {
    return null;
  }
  const start = content.indexOf(OPEN_MARKER) + OPEN_MARKER.length;
  const end = content.indexOf(CLOSE_MARKER);
  if (end < start) return null;
  const encoded = content.slice(start, end);
  if (encoded.length === 0 || byteLength(encoded) > limits.markerBytes) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["outcome", "recipes", "version"]) ||
    value.version !== VERSION ||
    (value.outcome !== "verified" && value.outcome !== "not_verified")
  ) {
    return null;
  }
  const recipes = recipesFrom(value.recipes, limits);
  if (!recipes) return null;
  return { outcome: value.outcome, recipes, version: VERSION };
}

function assistantText(value) {
  if (value?.type !== "assistant" || !Array.isArray(value.message?.content)) {
    return undefined;
  }
  const parts = value.message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text);
  return parts.join("");
}

export function createVerificationMemoryCapture(options = {}) {
  const limits = configuredLimits(options);
  let final = null;
  let finalSeen = false;
  let partial = "";
  let partialOversized = false;
  let fallback = null;

  function appendPartial(text) {
    if (partialOversized) return;
    if (byteLength(partial) + byteLength(text) > limits.finalMessageBytes) {
      partial = "";
      partialOversized = true;
      return;
    }
    partial += text;
  }

  function observe(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const text = assistantText(value);
    if (text !== undefined) {
      finalSeen = true;
      final =
        text.length > 0 && byteLength(text) <= limits.finalMessageBytes
          ? text
          : null;
      return;
    }
    if (value?.type !== "stream_event") return;
    if (value.event?.type === "message_start") {
      final = null;
      finalSeen = false;
      partial = "";
      partialOversized = false;
      fallback = null;
      return;
    }
    if (
      value.event?.type === "content_block_delta" &&
      value.event.delta?.type === "text_delta" &&
      typeof value.event.delta.text === "string"
    ) {
      appendPartial(value.event.delta.text);
      return;
    }
    if (value.event?.type === "message_stop") {
      fallback = partialOversized ? null : partial;
    }
  }

  return Object.freeze({
    observe,
    result: () =>
      parseVerificationMemoryMarker(finalSeen ? final : fallback, limits),
  });
}

function pathForRecipe(recipe) {
  if (recipe.kind === "file" || recipe.kind === "grep") return recipe.path;
  if (recipe.kind === "script") return recipe.manifestPath;
  return recipe.sourcePath;
}

async function regularSnapshotFile(snapshotRoot, path) {
  let root;
  try {
    root = await realpath(snapshotRoot);
  } catch {
    return false;
  }
  let candidate = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    candidate = join(candidate, parts[index]);
    let details;
    try {
      details = await lstat(candidate);
    } catch {
      return false;
    }
    if (details.isSymbolicLink()) return false;
    if (
      index === parts.length - 1 ? !details.isFile() : !details.isDirectory()
    ) {
      return false;
    }
  }
  try {
    const canonical = await realpath(candidate);
    const within = relative(root, canonical);
    return (
      within !== "" &&
      within !== ".." &&
      !within.startsWith(`..${sep}`) &&
      !isAbsolute(within)
    );
  } catch {
    return false;
  }
}

async function snapshotText(snapshotRoot, path, maximum) {
  if (!(await regularSnapshotFile(snapshotRoot, path))) return null;
  let root;
  let handle;
  try {
    root = await realpath(snapshotRoot);
    handle = await open(
      join(root, ...path.split("/")),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const details = await handle.stat();
    if (!details.isFile() || details.size > maximum) return null;
    const encoded = await handle.readFile();
    if (encoded.byteLength > maximum || encoded.includes(0)) return null;
    return UTF8.decode(encoded);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validManifestScript(snapshotRoot, recipe, limits) {
  try {
    const encoded = await snapshotText(
      snapshotRoot,
      recipe.manifestPath,
      limits.manifestBytes,
    );
    if (encoded === null) return false;
    const value = JSON.parse(encoded);
    if (
      !isRecord(value?.scripts) ||
      !Object.prototype.hasOwnProperty.call(value.scripts, recipe.name)
    ) {
      return false;
    }
    const script = value.scripts[recipe.name];
    const command = (candidate) =>
      typeof candidate === "string" && candidate.trim().length > 0;
    if (recipe.manifestPath.split("/").at(-1) === "package.json") {
      return command(script);
    }
    return (
      command(script) ||
      (Array.isArray(script) &&
        script.length > 0 &&
        script.every((candidate) => command(candidate)))
    );
  } catch {
    return false;
  }
}

function containsToken(source, token, caseSensitive = false) {
  const value = caseSensitive ? source : source.toLowerCase();
  const target = caseSensitive ? token : token.toLowerCase();
  let offset = 0;
  while (true) {
    const index = value.indexOf(target, offset);
    if (index === -1) return false;
    const before = index === 0 ? null : value[index - 1];
    const end = index + target.length;
    const after = end === value.length ? null : value[end];
    if (
      (before === null || !TOKEN_CHARACTER.test(before)) &&
      (after === null || !TOKEN_CHARACTER.test(after))
    ) {
      return true;
    }
    offset = index + 1;
  }
}

async function validToolSource(snapshotRoot, recipe, limits) {
  const source = await snapshotText(
    snapshotRoot,
    recipe.sourcePath,
    limits.sourceBytes,
  );
  return source !== null && containsToken(source, recipe.name);
}

async function validGrepSource(snapshotRoot, recipe, limits) {
  const source = await snapshotText(
    snapshotRoot,
    recipe.path,
    limits.sourceBytes,
  );
  return (
    source !== null &&
    recipe.terms.every((term) => containsToken(source, term, true))
  );
}

async function revalidateRecipes(recipes, snapshotRoot, limits) {
  const checked = await Promise.all(
    recipes.map(async (recipe) => ({
      recipe,
      valid:
        recipe.kind === "script"
          ? await validManifestScript(snapshotRoot, recipe, limits)
          : recipe.kind === "tool"
            ? await validToolSource(snapshotRoot, recipe, limits)
            : recipe.kind === "grep"
              ? await validGrepSource(snapshotRoot, recipe, limits)
              : await regularSnapshotFile(snapshotRoot, pathForRecipe(recipe)),
    })),
  );
  return checked.filter(({ valid }) => valid).map(({ recipe }) => recipe);
}

function validEntry(value, limits) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "headSha",
      "pullNumber",
      "recordedAt",
      "recipes",
      "releaseId",
      "tag",
    ]) ||
    typeof value.headSha !== "string" ||
    !SHA.test(value.headSha) ||
    !Number.isSafeInteger(value.pullNumber) ||
    value.pullNumber < 1 ||
    !Number.isSafeInteger(value.recordedAt) ||
    value.recordedAt < 0 ||
    typeof value.releaseId !== "string" ||
    !boundedString(value.releaseId, limits.fieldBytes) ||
    !RELEASE_ID.test(value.releaseId) ||
    !boundedString(value.tag, limits.fieldBytes) ||
    !validateReleaseTag(value.tag)
  ) {
    return null;
  }
  const recipes = recipesFrom(value.recipes, limits);
  if (!recipes) return null;
  return {
    headSha: value.headSha.toLowerCase(),
    pullNumber: value.pullNumber,
    recordedAt: value.recordedAt,
    recipes,
    releaseId: value.releaseId,
    tag: value.tag,
  };
}

function documentFrom(value, repository, limits) {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["entries", "repository", "version"]) ||
    value.version !== VERSION ||
    value.repository !== repository ||
    !Array.isArray(value.entries) ||
    value.entries.length > limits.entries
  ) {
    return null;
  }
  const entries = [];
  for (const candidate of value.entries) {
    const entry = validEntry(candidate, limits);
    if (!entry) return null;
    entries.push(entry);
  }
  return { entries, repository, version: VERSION };
}

function filename(repository) {
  return `${createHash("sha256").update(repository).digest("hex")}.json`;
}

function safeMode(details, expected) {
  return (details.mode & 0o7777) === expected;
}

function owned(details, uid) {
  return uid === null || details.uid === uid;
}

function within(base, candidate) {
  const path = relative(base, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function canonicalStorageRoot(root) {
  const normalized = normalize(root);
  const candidates = [tmpdir(), homedir()]
    .map((candidate) => normalize(candidate))
    .filter((candidate, index, values) => values.indexOf(candidate) === index);
  for (const base of candidates) {
    if (!within(base, normalized)) continue;
    const canonicalBase = realpathSync(base);
    return {
      base: canonicalBase,
      root: join(canonicalBase, relative(base, normalized)),
    };
  }
  const anchor = parse(normalized).root;
  const canonicalBase = realpathSync(anchor);
  return {
    base: canonicalBase,
    root: join(canonicalBase, relative(anchor, normalized)),
  };
}

async function ensureRoot(root, base, uid) {
  let candidate = base;
  const segments = relative(base, root).split(sep).filter(Boolean);
  for (const segment of segments) {
    candidate = join(candidate, segment);
    try {
      const details = await lstat(candidate);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error("The verification-memory root has an unsafe ancestor.");
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  await mkdir(root, { mode: 0o700, recursive: true });
  if ((await realpath(root)) !== root) {
    throw new Error("The verification-memory root has an unsafe ancestor.");
  }
  const details = await lstat(root);
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !owned(details, uid)
  ) {
    throw new Error("The verification-memory root is not a private directory.");
  }
  if (!safeMode(details, 0o700)) await chmod(root, 0o700);
}

function enqueueModule(key, operation) {
  const previous = MODULE_QUEUES.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  MODULE_QUEUES.set(key, current);
  return current.finally(() => {
    if (MODULE_QUEUES.get(key) === current) MODULE_QUEUES.delete(key);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function defaultLockProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "ESRCH" ? false : null;
  }
}

function lockTimestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Verification-memory lock time must be non-negative.");
  }
  return value;
}

function parseLockMetadata(encoded, limits) {
  if (
    !Buffer.isBuffer(encoded) ||
    encoded.byteLength === 0 ||
    encoded.byteLength > limits.lockBytes ||
    encoded.includes(0)
  ) {
    return null;
  }
  try {
    const content = UTF8.decode(encoded);
    const value = JSON.parse(content);
    if (
      !isRecord(value) ||
      !exactKeys(value, ["acquiredAt", "nonce", "pid", "version"]) ||
      value.version !== LOCK_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !Number.isSafeInteger(value.acquiredAt) ||
      value.acquiredAt < 0 ||
      !boundedString(value.nonce, 64) ||
      !LOCK_NONCE.test(value.nonce) ||
      JSON.stringify(value) !== content
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function inspectStoreLock(path, limits, uid) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    !owned(entry, uid) ||
    !safeMode(entry, 0o600)
  ) {
    throw new Error("The verification-memory lock is unsafe.");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (
      !details.isFile() ||
      !owned(details, uid) ||
      !safeMode(details, 0o600) ||
      !sameFile(entry, details)
    ) {
      return null;
    }
    if (details.size < 1 || details.size > limits.lockBytes) {
      return { content: null, details, metadata: null, path };
    }
    const content = await handle.readFile();
    const current = await lstat(path).catch(() => null);
    if (
      !current ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !owned(current, uid) ||
      !safeMode(current, 0o600) ||
      !sameFile(current, details)
    ) {
      return null;
    }
    return {
      content,
      details,
      metadata: parseLockMetadata(content, limits),
      path,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function unlinkMatchingLock(root, expected, limits, uid) {
  let current;
  try {
    current = await inspectStoreLock(expected.path, limits, uid);
  } catch {
    return false;
  }
  if (
    current === null ||
    current.content === null ||
    !sameFile(current.details, expected.details) ||
    !current.content.equals(expected.content)
  ) {
    return false;
  }
  const final = await lstat(expected.path).catch(() => null);
  if (
    final === null ||
    final.isSymbolicLink() ||
    !final.isFile() ||
    !owned(final, uid) ||
    !safeMode(final, 0o600) ||
    !sameFile(final, expected.details)
  ) {
    return false;
  }
  await unlink(expected.path);
  await syncDirectory(root, uid);
  return true;
}

async function releaseStoreLock(root, lock, limits, uid) {
  await lock.handle.close().catch(() => undefined);
  await unlinkMatchingLock(root, lock, limits, uid);
}

async function reclaimableLock(lock, limits, lockNow, lockProcessAlive) {
  if (lock.metadata === null || lock.content === null) return false;
  const observedAt = lockTimestamp(lockNow);
  const modifiedAt = Math.floor(lock.details.mtimeMs);
  if (
    lock.metadata.acquiredAt > observedAt ||
    !Number.isSafeInteger(modifiedAt) ||
    modifiedAt < 0 ||
    modifiedAt > observedAt
  ) {
    return false;
  }
  let alive = null;
  try {
    const result = await lockProcessAlive(lock.metadata.pid);
    if (result === true || result === false || result === null) alive = result;
  } catch {
    alive = null;
  }
  if (alive === false) return true;
  if (alive === true) return false;
  return (
    observedAt - lock.metadata.acquiredAt >= limits.lockLease &&
    observedAt - modifiedAt >= limits.lockLease
  );
}

async function acquireStoreLock(
  root,
  limits,
  uid,
  pid,
  lockNow,
  lockProcessAlive,
) {
  const path = join(root, LOCK);
  const deadline = Date.now() + limits.lockTimeout;
  while (true) {
    let handle;
    let content = null;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.chmod(0o600);
      const metadata = {
        acquiredAt: lockTimestamp(lockNow),
        nonce: randomUUID(),
        pid,
        version: LOCK_VERSION,
      };
      content = Buffer.from(JSON.stringify(metadata), "utf8");
      if (content.byteLength > limits.lockBytes) {
        throw new Error("The verification-memory lock metadata is too large.");
      }
      await handle.writeFile(content);
      await handle.sync();
      const details = await handle.stat();
      if (
        !details.isFile() ||
        !owned(details, uid) ||
        !safeMode(details, 0o600) ||
        details.size !== content.byteLength
      ) {
        throw new Error("The verification-memory lock is unsafe.");
      }
      return { content, details, handle, metadata, path };
    } catch (error) {
      if (handle) {
        const details = await handle.stat().catch(() => null);
        await handle.close().catch(() => undefined);
        if (details && content) {
          await unlinkMatchingLock(
            root,
            { content, details, path },
            limits,
            uid,
          ).catch(() => undefined);
        }
      }
      if (error?.code !== "EEXIST") throw error;
      let current = null;
      try {
        current = await inspectStoreLock(path, limits, uid);
      } catch (inspectionError) {
        throw inspectionError;
      }
      if (current === null) continue;
      if (
        (await reclaimableLock(current, limits, lockNow, lockProcessAlive)) &&
        (await unlinkMatchingLock(root, current, limits, uid))
      ) {
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await delay(Math.min(limits.lockRetry, remaining));
    }
  }
}

async function readDocument(root, repository, limits, uid) {
  const target = join(root, filename(repository));
  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const details = await handle.stat();
    if (
      !details.isFile() ||
      !owned(details, uid) ||
      !safeMode(details, 0o600) ||
      details.size > limits.fileBytes
    ) {
      return null;
    }
    const encoded = await handle.readFile({ encoding: "utf8" });
    if (byteLength(encoded) > limits.fileBytes) return null;
    return documentFrom(JSON.parse(encoded), repository, limits);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(root, uid) {
  const handle = await open(
    root,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const details = await handle.stat();
    if (
      !details.isDirectory() ||
      !owned(details, uid) ||
      !safeMode(details, 0o700)
    ) {
      throw new Error("The verification-memory root changed.");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function storedFile(root, name, limits, uid) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) return null;
  const path = join(root, name);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (
      !details.isFile() ||
      !owned(details, uid) ||
      !safeMode(details, 0o600) ||
      details.size > limits.fileBytes
    ) {
      return null;
    }
    const encoded = await handle.readFile({ encoding: "utf8" });
    if (byteLength(encoded) > limits.fileBytes) return null;
    const value = JSON.parse(encoded);
    const repository = normalizeRepository(
      value?.repository,
      limits.fieldBytes,
    );
    if (filename(repository) !== name) return null;
    const document = documentFrom(value, repository, limits);
    if (!document) return null;
    return {
      details,
      document,
      name,
      path,
      size: byteLength(encoded),
      updatedAt: document.entries.reduce(
        (latest, entry) => Math.max(latest, entry.recordedAt),
        0,
      ),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function rootEntries(root, limits, uid, lock) {
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    let details;
    try {
      details = await lstat(path);
    } catch {
      return null;
    }
    if (name === LOCK) {
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        !owned(details, uid) ||
        !safeMode(details, 0o600) ||
        !sameFile(details, lock.details)
      ) {
        return null;
      }
      entries.push({ details, name, path, record: null, size: details.size });
      continue;
    }
    const record = await storedFile(root, name, limits, uid);
    entries.push({ details, name, path, record, size: details.size });
  }
  return entries;
}

async function removeStoredFile(root, record, limits, uid) {
  const current = await storedFile(root, record.name, limits, uid);
  if (!current) {
    throw new Error("A verification-memory eviction target changed.");
  }
  const details = current.details;
  if (
    details.dev !== record.details.dev ||
    details.ino !== record.details.ino
  ) {
    throw new Error("A verification-memory eviction target changed.");
  }
  await unlink(record.path);
}

async function writeDocument(root, repository, document, limits, uid) {
  const encoded = JSON.stringify(document);
  if (byteLength(encoded) > limits.fileBytes) return false;
  const target = join(root, filename(repository));
  const temporary = join(root, `.${filename(repository)}.${randomUUID()}.tmp`);
  let handle;
  try {
    try {
      const existing = await lstat(target);
      if (
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        !owned(existing, uid) ||
        !safeMode(existing, 0o600)
      ) {
        throw new Error("The verification-memory file is unsafe.");
      }
      if (!(await storedFile(root, filename(repository), limits, uid))) {
        throw new Error("The verification-memory file is unreadable.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(encoded, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(root, uid);
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeWithinStoreBudget(
  root,
  repository,
  document,
  limits,
  uid,
  lock,
) {
  const size = byteLength(JSON.stringify(document));
  if (size > limits.fileBytes || size > limits.storeBytes) return false;
  const target = filename(repository);
  const entries = await rootEntries(root, limits, uid, lock);
  if (entries === null) return false;
  const records = [];
  let total = size;
  for (const entry of entries) {
    if (entry.name === LOCK) continue;
    if (entry.name === target && entry.record !== null) continue;
    total += entry.size;
    if (entry.name !== target && entry.record !== null) {
      records.push(entry.record);
    }
  }
  const victims = [];
  for (const record of [...records].sort((first, second) => {
    return (
      first.updatedAt - second.updatedAt ||
      first.name.localeCompare(second.name)
    );
  })) {
    if (total <= limits.storeBytes) break;
    victims.push(record);
    total -= record.size;
  }
  if (total > limits.storeBytes) return false;
  if (!(await writeDocument(root, repository, document, limits, uid))) {
    return false;
  }
  for (const victim of victims) {
    await removeStoredFile(root, victim, limits, uid);
  }
  if (victims.length > 0) await syncDirectory(root, uid);
  return true;
}

function promptDocument(repository, entries) {
  return {
    entries: entries.map((entry) => ({
      pullNumber: entry.pullNumber,
      recipes: entry.recipes,
      tag: entry.tag,
    })),
    repository,
    version: VERSION,
  };
}

function fitEntries(repository, entries, maximum) {
  const fitted = [...entries];
  while (
    fitted.length > 0 &&
    byteLength(JSON.stringify(promptDocument(repository, fitted))) > maximum
  ) {
    fitted.shift();
  }
  return fitted;
}

function pruneDocument(document, limits) {
  const entries = [...document.entries];
  while (
    entries.length > limits.entries ||
    entries.reduce((total, entry) => total + entry.recipes.length, 0) >
      limits.totalRecipes ||
    byteLength(
      JSON.stringify({
        entries,
        repository: document.repository,
        version: VERSION,
      }),
    ) > limits.fileBytes
  ) {
    if (entries.length === 0) break;
    entries.shift();
  }
  return { entries, repository: document.repository, version: VERSION };
}

export function escapeVerificationMemory(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function createVerificationMemory({
  root,
  now = Date.now,
  lockNow = Date.now,
  lockProcessAlive = defaultLockProcessAlive,
  pid = process.pid,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  ...options
} = {}) {
  if (typeof root !== "string" || root === "" || !isAbsolute(root)) {
    throw new TypeError("An absolute verification-memory root is required.");
  }
  if (typeof now !== "function") {
    throw new TypeError("A verification-memory clock is required.");
  }
  if (typeof lockNow !== "function") {
    throw new TypeError("A verification-memory lock clock is required.");
  }
  if (typeof lockProcessAlive !== "function") {
    throw new TypeError("A verification-memory process probe is required.");
  }
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError("A valid verification-memory process is required.");
  }
  if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0)) {
    throw new TypeError("A valid verification-memory owner is required.");
  }
  const storage = canonicalStorageRoot(root);
  const normalizedRoot = storage.root;
  const storageBase = storage.base;
  const limits = configuredLimits(options);
  const storeKey = JSON.stringify(["store", normalizedRoot]);

  function repositoryKey(repository) {
    return JSON.stringify(["repository", normalizedRoot, repository]);
  }

  function load({ repository: value, snapshotRoot }) {
    const repository = normalizeRepository(value, limits.fieldBytes);
    return enqueueModule(repositoryKey(repository), async () => {
      try {
        await ensureRoot(normalizedRoot, storageBase, uid);
        const document = await readDocument(
          normalizedRoot,
          repository,
          limits,
          uid,
        );
        if (!document) return null;
        const entries = [];
        for (const entry of document.entries) {
          const recipes = await revalidateRecipes(
            entry.recipes,
            snapshotRoot,
            limits,
          );
          if (recipes.length > 0) entries.push({ ...entry, recipes });
        }
        const fitted = fitEntries(repository, entries, limits.promptBytes);
        return fitted.length > 0 ? promptDocument(repository, fitted) : null;
      } catch {
        return null;
      }
    });
  }

  async function remember({ input, recipes: value, snapshotRoot }) {
    const repository = normalizeRepository(
      input?.repository,
      limits.fieldBytes,
    );
    if (
      !Number.isSafeInteger(input?.pullNumber) ||
      input.pullNumber < 1 ||
      typeof input?.headSha !== "string" ||
      !SHA.test(input.headSha) ||
      typeof input?.releaseId !== "string" ||
      !boundedString(input.releaseId, limits.fieldBytes) ||
      !RELEASE_ID.test(input.releaseId) ||
      !boundedString(input?.tag, limits.fieldBytes) ||
      !validateReleaseTag(input.tag)
    ) {
      throw new TypeError("Valid verification provenance is required.");
    }
    const recipes = recipesFrom(value, limits);
    if (!recipes)
      throw new TypeError("Valid verification recipes are required.");
    return enqueueModule(repositoryKey(repository), async () => {
      const validated = await revalidateRecipes(recipes, snapshotRoot, limits);
      if (validated.length === 0) return false;
      return enqueueModule(storeKey, async () => {
        await ensureRoot(normalizedRoot, storageBase, uid);
        let lock;
        try {
          lock = await acquireStoreLock(
            normalizedRoot,
            limits,
            uid,
            pid,
            lockNow,
            lockProcessAlive,
          );
        } catch {
          return false;
        }
        if (lock === null) return false;
        try {
          await ensureRoot(normalizedRoot, storageBase, uid);
          const existing = (await readDocument(
            normalizedRoot,
            repository,
            limits,
            uid,
          )) ?? { entries: [], repository, version: VERSION };
          const entries = [];
          for (const entry of existing.entries) {
            const current = await revalidateRecipes(
              entry.recipes,
              snapshotRoot,
              limits,
            );
            if (current.length > 0)
              entries.push({ ...entry, recipes: current });
          }
          const recordedAt = now();
          if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
            throw new TypeError(
              "Verification-memory time must be a non-negative integer.",
            );
          }
          entries.push({
            headSha: input.headSha.toLowerCase(),
            pullNumber: input.pullNumber,
            recordedAt,
            recipes: validated,
            releaseId: input.releaseId,
            tag: input.tag,
          });
          const document = pruneDocument(
            { entries, repository, version: VERSION },
            limits,
          );
          if (document.entries.length === 0) return false;
          return await writeWithinStoreBudget(
            normalizedRoot,
            repository,
            document,
            limits,
            uid,
            lock,
          );
        } finally {
          await releaseStoreLock(normalizedRoot, lock, limits, uid).catch(
            () => undefined,
          );
        }
      });
    });
  }

  return Object.freeze({ load, remember });
}
