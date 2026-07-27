import { execFile as executeFile } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const COMPOSER_VERSION = "2.10.2";
const INSTALL_TIMEOUT = 15 * 60 * 1_000;
const LOCK_STALE_AFTER = INSTALL_TIMEOUT + 60_000;
const LOCK_WAIT_TIMEOUT = INSTALL_TIMEOUT + 2 * 60_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const PACKAGE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const PROOF_KEYS = [
  "authentication",
  "inputs",
  "key",
  "store",
  "target",
  "tools",
  "tree",
  "version",
];
const REFERENCE = /^[a-f0-9]{40}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const entries = new WeakMap();
const execute = promisify(executeFile);
const processKey = randomBytes(32);
const processNamespace = randomBytes(32);
const processStores = new Map();

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function authenticate(value) {
  return createHmac("sha256", processKey)
    .update(processNamespace)
    .update(canonicalJson(value))
    .digest("hex");
}

function authenticated(value, authentication) {
  if (
    typeof authentication !== "string" ||
    !/^[a-f0-9]{64}$/.test(authentication)
  ) {
    return false;
  }
  const actual = Buffer.from(authentication, "hex");
  const expected = Buffer.from(authenticate(value), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function owner() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function owned(details) {
  const uid = owner();
  return uid === null || details.uid === uid;
}

function inside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
}

function safePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function canonical(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return null;
  try {
    const target = await realpath(path);
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
      !owned(details) ||
      (kind === "directory" && !details.isDirectory()) ||
      (kind === "file" && !details.isFile())
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function runtime(path) {
  try {
    if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
      return null;
    }
    const target = await realpath(path);
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (
        !details.isFile() ||
        !owned(details) ||
        details.nlink !== 1 ||
        (details.mode & 0o111) === 0
      ) {
        return null;
      }
      const content = await handle.readFile();
      return Object.freeze({
        device: details.dev,
        digest: digest(content),
        inode: details.ino,
        mode: details.mode & 0o7777,
        path: target,
        size: details.size,
      });
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function runtimeIntact(value) {
  if (!value || typeof value !== "object") return false;
  const current = await runtime(value.path);
  return (
    current !== null &&
    current.device === value.device &&
    current.digest === value.digest &&
    current.inode === value.inode &&
    current.mode === value.mode &&
    current.size === value.size
  );
}

async function executable(name, path) {
  for (const directory of String(path ?? "").split(":")) {
    if (directory === "") continue;
    const value = await runtime(join(directory, name));
    if (value !== null) return value;
  }
  return null;
}

function immutableHttps(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function githubRepository(value) {
  if (!immutableHttps(value)) return null;
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const repository = parts[1].replace(/\.git$/i, "");
  if (
    repository === "" ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    return null;
  }
  return `${parts[0]}/${repository}`.toLowerCase();
}

function githubArchiveRepository(value, reference) {
  if (!immutableHttps(value)) return null;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let repository = null;
  let candidate = null;
  if (
    host === "api.github.com" &&
    parts.length === 5 &&
    parts[0].toLowerCase() === "repos" &&
    parts[3].toLowerCase() === "zipball"
  ) {
    repository = `${parts[1]}/${parts[2]}`;
    candidate = parts[4];
  } else if (
    host === "github.com" &&
    parts.length === 4 &&
    parts[2].toLowerCase() === "archive" &&
    parts[3].toLowerCase().endsWith(".zip")
  ) {
    repository = `${parts[0]}/${parts[1]}`;
    candidate = parts[3].slice(0, -4);
  } else if (
    host === "codeload.github.com" &&
    parts.length === 4 &&
    parts[2].toLowerCase() === "zip"
  ) {
    repository = `${parts[0]}/${parts[1]}`;
    candidate = parts[3];
  }
  if (
    repository === null ||
    candidate?.toLowerCase() !== reference.toLowerCase() ||
    !PACKAGE.test(repository.toLowerCase())
  ) {
    return null;
  }
  return repository.toLowerCase();
}

function repositoryPolicy(manifest, packages) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest?.config?.["vendor-dir"] !== undefined ||
    manifest?.config?.["bin-dir"] !== undefined ||
    manifest?.config?.["cache-dir"] !== undefined ||
    manifest?.config?.home !== undefined ||
    manifest?.config?.["use-parent-dir"] !== undefined ||
    manifest?.config?.["secure-http"] === false ||
    manifest?.config?.["disable-tls"] === true ||
    manifest?.config?.["github-oauth"] !== undefined
  ) {
    return false;
  }
  const configured = manifest.repositories;
  if (configured === undefined) return true;
  if (!configured || typeof configured !== "object") return false;
  const values = Array.isArray(configured)
    ? configured
    : Object.values(configured);
  return values.every((repository) => {
    if (repository === false) return true;
    if (
      !repository ||
      typeof repository !== "object" ||
      Array.isArray(repository) ||
      !["composer", "vcs"].includes(repository.type) ||
      !immutableHttps(repository.url)
    ) {
      return false;
    }
    if (
      repository.type === "vcs" &&
      !packages.some(
        (value) =>
          githubRepository(value?.source?.url) ===
          githubRepository(repository.url),
      )
    ) {
      return false;
    }
    return Object.keys(repository).every((key) =>
      ["canonical", "exclude", "only", "type", "url"].includes(key),
    );
  });
}

function packagePolicy(lock) {
  if (
    !Array.isArray(lock?.packages) ||
    !Array.isArray(lock?.["packages-dev"])
  ) {
    return null;
  }
  const packages = [...lock.packages, ...lock["packages-dev"]];
  if (packages.length === 0) return null;
  const names = new Set();
  for (const value of packages) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.name !== "string" ||
      !PACKAGE.test(value.name) ||
      names.has(value.name) ||
      typeof value.version !== "string" ||
      value.version === ""
    ) {
      return null;
    }
    names.add(value.name);
    if (value.type === "metapackage") {
      if (value.dist !== undefined || value.source !== undefined) return null;
      continue;
    }
    const reference = value?.dist?.reference;
    const source = value.source;
    const sourceReference = source?.reference;
    if (
      value?.dist?.type !== "zip" ||
      typeof value.dist.url !== "string" ||
      !immutableHttps(value.dist.url) ||
      typeof reference !== "string" ||
      !REFERENCE.test(reference) ||
      (source !== undefined &&
        (source?.type !== "git" ||
          typeof source.url !== "string" ||
          githubRepository(source.url) === null ||
          typeof sourceReference !== "string" ||
          sourceReference.toLowerCase() !== reference.toLowerCase() ||
          !REFERENCE.test(sourceReference)))
    ) {
      return null;
    }
    const repository =
      source === undefined
        ? value.name.toLowerCase()
        : githubRepository(source.url);
    const archive = githubArchiveRepository(value.dist.url, reference);
    const checksum = value.dist.shasum;
    if (
      typeof checksum !== "string" ||
      (checksum === ""
        ? repository === null || archive !== repository
        : !SHA1.test(checksum))
    ) {
      return null;
    }
  }
  return Object.freeze(packages.map((value) => Object.freeze({ ...value })));
}

function samePackage(left, right) {
  return (
    left?.name === right?.name &&
    left?.version === right?.version &&
    (left?.source?.reference ?? null) === (right?.source?.reference ?? null) &&
    (left?.dist?.reference ?? null) === (right?.dist?.reference ?? null) &&
    (left?.type ?? "library") === (right?.type ?? "library")
  );
}

function installedMatches(packages, installed) {
  const values = installed?.packages;
  if (!Array.isArray(values) || values.length !== packages.length) return false;
  const byName = new Map(values.map((value) => [value?.name, value]));
  return (
    byName.size === values.length &&
    packages.every((value) => samePackage(value, byName.get(value.name)))
  );
}

async function readRegular(path, maximum = 32 * 1024 * 1024) {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (
        !details.isFile() ||
        !owned(details) ||
        details.nlink !== 1 ||
        details.size > maximum
      ) {
        return null;
      }
      const content = await handle.readFile();
      return content.byteLength === details.size ? { content, details } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function inputIdentity(value) {
  return Object.freeze({
    digest: digest(value),
    size: Buffer.byteLength(value, "utf8"),
  });
}

async function sourceIntact(project, inputs) {
  for (const [name, expected] of [
    ["composer.json", inputs.manifest],
    ["composer.lock", inputs.lock],
  ]) {
    const file = await readRegular(join(project, name));
    if (
      file === null ||
      (file.details.mode & 0o7777) !== 0o400 ||
      file.details.nlink !== 1 ||
      file.details.size !== expected.size ||
      digest(file.content) !== expected.digest
    ) {
      return false;
    }
  }
  return true;
}

async function tree(root) {
  const canonicalRoot = await canonical(root);
  if (canonicalRoot === null || canonicalRoot !== resolve(root)) return null;
  const rootDetails = await lstat(canonicalRoot).catch(() => null);
  if (
    rootDetails === null ||
    !rootDetails.isDirectory() ||
    rootDetails.isSymbolicLink() ||
    !owned(rootDetails)
  ) {
    return null;
  }
  const result = [
    Object.freeze({
      mode: rootDetails.mode & 0o7777,
      nlink: rootDetails.nlink,
      path: ".",
      type: "directory",
    }),
  ];
  const pending = [{ path: canonicalRoot, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    let values;
    try {
      values = await readdir(current.path, { withFileTypes: true });
    } catch {
      return null;
    }
    values.sort((left, right) => left.name.localeCompare(right.name));
    const directories = [];
    for (const value of values) {
      const path =
        current.prefix === "" ? value.name : `${current.prefix}/${value.name}`;
      if (!safePath(path)) return null;
      const target = join(current.path, value.name);
      const details = await lstat(target).catch(() => null);
      if (
        details === null ||
        details.isSymbolicLink() ||
        !owned(details) ||
        !inside(canonicalRoot, resolve(target))
      ) {
        return null;
      }
      if (details.isDirectory()) {
        const directory = await canonical(target);
        if (directory === null || directory !== resolve(target)) return null;
        result.push(
          Object.freeze({
            mode: details.mode & 0o7777,
            nlink: details.nlink,
            path,
            type: "directory",
          }),
        );
        directories.push({ path: directory, prefix: path });
        continue;
      }
      if (!details.isFile() || details.nlink !== 1) return null;
      const file = await readRegular(target);
      if (
        file === null ||
        file.details.dev !== details.dev ||
        file.details.ino !== details.ino ||
        file.details.mode !== details.mode ||
        file.details.size !== details.size
      ) {
        return null;
      }
      result.push(
        Object.freeze({
          digest: digest(file.content),
          mode: details.mode & 0o7777,
          nlink: details.nlink,
          path,
          size: details.size,
          type: "file",
        }),
      );
    }
    for (const directory of directories.reverse()) pending.push(directory);
  }
  return Object.freeze(
    result.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

async function readJson(path) {
  const file = await readRegular(path);
  if (file === null) return null;
  try {
    return JSON.parse(file.content.toString("utf8"));
  } catch {
    return null;
  }
}

function proofPayload(proof) {
  return {
    inputs: proof.inputs,
    key: proof.key,
    store: proof.store,
    target: proof.target,
    tools: proof.tools,
    tree: proof.tree,
    version: proof.version,
  };
}

async function storedEntry(path, expected, targetPath = path) {
  if (!(await processStoreIntact(expected.store))) return null;
  const root = await canonical(path);
  if (
    root === null ||
    root !== path ||
    dirname(root) !== expected.store.path ||
    !inside(expected.store.path, root) ||
    dirname(targetPath) !== expected.store.path ||
    !inside(expected.store.path, targetPath)
  ) {
    return null;
  }
  const details = await lstat(root).catch(() => null);
  if (
    details === null ||
    (details.mode & 0o7777) !== 0o500 ||
    !owned(details)
  ) {
    return null;
  }
  const names = await readdir(root).catch(() => null);
  if (
    names === null ||
    names.length !== 2 ||
    !names.includes("proof.json") ||
    !names.includes("vendor")
  ) {
    return null;
  }
  const proofPath = join(root, "proof.json");
  const proofFile = await readRegular(proofPath);
  if (proofFile === null || (proofFile.details.mode & 0o7777) !== 0o400) {
    return null;
  }
  let proof;
  try {
    proof = JSON.parse(proofFile.content.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    canonicalJson(Object.keys(proof).sort()) !== canonicalJson(PROOF_KEYS) ||
    proof?.version !== 2 ||
    proof.key !== expected.key ||
    canonicalJson(proof.inputs) !== canonicalJson(expected.inputs) ||
    canonicalJson(proof.store) !== canonicalJson(expected.store) ||
    JSON.stringify(proof.tools) !== JSON.stringify(expected.tools) ||
    proof.target?.device !== details.dev ||
    proof.target?.inode !== details.ino ||
    proof.target?.mode !== 0o500 ||
    proof.target?.nlink !== details.nlink ||
    proof.target?.path !== targetPath ||
    !authenticated(proofPayload(proof), proof.authentication) ||
    !Array.isArray(proof.tree)
  ) {
    return null;
  }
  const vendor = join(root, "vendor");
  const actual = await tree(vendor);
  if (
    actual === null ||
    JSON.stringify(actual) !== JSON.stringify(proof.tree)
  ) {
    return null;
  }
  const files = actual
    .filter(({ type }) => type === "file")
    .map(({ digest: fileDigest, mode, path: filePath, size }) =>
      Object.freeze({ digest: fileDigest, mode, path: filePath, size }),
    );
  const value = Object.freeze({
    files: Object.freeze(files),
    key: proof.key,
    root: vendor,
    tools: expected.tools,
  });
  entries.set(
    value,
    Object.freeze({
      authentication: proof.authentication,
      inputs: expected.inputs,
      key: proof.key,
      proof: digest(proofFile.content),
      root: vendor,
      store: expected.store,
      tools: expected.tools,
    }),
  );
  return value;
}

export async function verifyVerificationDependency(value) {
  if (!value || typeof value !== "object") return false;
  const expected = entries.get(value);
  if (expected === undefined) return false;
  const target = dirname(expected.root);
  const current = await storedEntry(target, {
    inputs: expected.inputs,
    key: expected.key,
    store: expected.store,
    tools: expected.tools,
  });
  if (current === null) return false;
  const actual = entries.get(current);
  return (
    actual !== undefined &&
    actual.root === expected.root &&
    actual.proof === expected.proof &&
    actual.authentication === expected.authentication
  );
}

async function makeWritable(path) {
  const details = await lstat(path).catch(() => null);
  if (details === null || details.isSymbolicLink() || !owned(details)) return;
  if (details.isDirectory()) {
    await chmod(path, 0o700).catch(() => undefined);
    for (const value of await readdir(path).catch(() => [])) {
      await makeWritable(join(path, value));
    }
  } else {
    await chmod(path, 0o600).catch(() => undefined);
  }
}

async function removePrivate(path) {
  await makeWritable(path);
  await rm(path, { force: true, recursive: true });
}

async function seal(path) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !owned(details)) {
    throw new Error("Unsafe dependency entry.");
  }
  if (details.isDirectory()) {
    for (const value of await readdir(path)) await seal(join(path, value));
    await chmod(path, 0o500);
    return;
  }
  if (!details.isFile() || details.nlink !== 1) {
    throw new Error("Unsafe dependency entry.");
  }
  await chmod(path, 0o400);
}

async function secureRoot(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const root = await canonical(path);
  if (root === null || root !== resolve(path)) return null;
  const details = await lstat(root);
  if (!details.isDirectory() || !owned(details)) return null;
  if ((details.mode & 0o077) !== 0) await chmod(root, 0o700);
  return root;
}

async function processStore(base) {
  const path = resolve(base);
  let operation = processStores.get(path);
  if (operation === undefined) {
    operation = (async () => {
      const root = await secureRoot(path);
      if (root === null) return null;
      // Warm reuse is deliberately process-local. A restart creates another
      // disposable temp namespace and cold-installs from trusted Composer
      // inputs; old namespaces are ignored and left to the OS temp lifecycle.
      // The directory suffix is storage identity, not authentication material.
      // Authentication remains process-private and is never persisted.
      const directory = await mkdtemp(join(root, ".process-"));
      await chmod(directory, 0o700);
      const target = await canonical(directory);
      const details = await lstat(directory).catch(() => null);
      if (
        target === null ||
        target !== resolve(directory) ||
        details === null ||
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        !owned(details)
      ) {
        await removePrivate(directory).catch(() => undefined);
        return null;
      }
      return Object.freeze({
        device: details.dev,
        inode: details.ino,
        mode: details.mode & 0o7777,
        path: target,
      });
    })();
    processStores.set(path, operation);
  }
  return operation;
}

async function processStoreIntact(value) {
  if (!value || typeof value !== "object") return false;
  const path = await canonical(value.path);
  const details = await lstat(value.path).catch(() => null);
  return (
    path === value.path &&
    details !== null &&
    details.isDirectory() &&
    !details.isSymbolicLink() &&
    owned(details) &&
    details.dev === value.device &&
    details.ino === value.inode &&
    (details.mode & 0o7777) === value.mode
  );
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lockRecord(path) {
  const details = await lstat(path).catch(() => null);
  if (
    details === null ||
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    !owned(details)
  ) {
    return { details, record: null };
  }
  return {
    details,
    record: await readJson(join(path, "owner.json")),
  };
}

async function releaseLock(path, nonce) {
  const { record } = await lockRecord(path);
  if (record?.nonce !== nonce || record?.pid !== process.pid) return;
  const released = `${path}.released-${nonce}`;
  try {
    await rename(path, released);
    await removePrivate(released);
  } catch {
    // A lost ownership race must never remove a replacement lock.
  }
}

async function acquireLock({
  interval,
  key,
  now,
  root,
  staleAfter,
  waitTimeout,
}) {
  const path = join(root, `${key}.lock`);
  const started = now();
  while (now() - started <= waitTimeout) {
    const nonce = randomUUID();
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({ createdAt: now(), nonce, pid: process.pid }),
        { flag: "wx", mode: 0o400 },
      );
      return Object.freeze({ nonce, path });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await removePrivate(path).catch(() => undefined);
        return null;
      }
    }
    const { details, record } = await lockRecord(path);
    const age = now() - Number(record?.createdAt ?? details?.mtimeMs ?? now());
    const stale =
      details === null ||
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      !owned(details) ||
      (age >= staleAfter && !alive(record?.pid));
    if (stale) {
      const abandoned = join(root, `.stale-${key}-${randomUUID()}`);
      try {
        await rename(path, abandoned);
        await removePrivate(abandoned);
      } catch {
        // Another waiter either recovered or replaced the stale lock.
      }
      continue;
    }
    await delay(interval);
  }
  return null;
}

async function cleanOrphans(root, key) {
  const prefixes = [
    `.building-${key}-`,
    `.publishing-${key}-`,
    `.invalid-${key}-`,
  ];
  for (const name of await readdir(root).catch(() => [])) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(root, name);
    const details = await lstat(path).catch(() => null);
    if (
      details !== null &&
      !details.isSymbolicLink() &&
      details.isDirectory() &&
      owned(details)
    ) {
      await removePrivate(path);
    }
  }
}

async function toolIdentity({ composer, php, run, root, version }) {
  const probe = await mkdtemp(join(root, ".probe-"));
  await chmod(probe, 0o700);
  try {
    const options = {
      cwd: probe,
      encoding: "utf8",
      env: {
        HOME: probe,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: [dirname(php.path), dirname(composer.path), "/bin"].join(":"),
        TEMP: probe,
        TMP: probe,
        TMPDIR: probe,
      },
      maxBuffer: OUTPUT_LIMIT,
      timeout: 30_000,
      windowsHide: true,
    };
    const [composerResult, phpResult] = await Promise.all([
      run(php.path, [composer.path, "--version", "--no-ansi"], options),
      run(php.path, ["--version"], options),
    ]);
    const composerOutput = String(composerResult.stdout ?? "").trim();
    const phpOutput = String(phpResult.stdout ?? "").trim();
    if (
      !composerOutput.startsWith(`Composer version ${version} `) ||
      !/^PHP \d+\.\d+\.\d+/m.test(phpOutput) ||
      !(await runtimeIntact(composer)) ||
      !(await runtimeIntact(php))
    ) {
      return null;
    }
    return Object.freeze({
      composer: Object.freeze({
        ...composer,
        output: composerOutput,
        version,
      }),
      php: Object.freeze({ ...php, output: phpOutput }),
    });
  } catch {
    return null;
  } finally {
    await removePrivate(probe);
  }
}

export function createVerificationDependencyStore({
  interval = 50,
  root = join(tmpdir(), "puller-verification-dependencies"),
  run = execute,
  staleAfter = LOCK_STALE_AFTER,
  version = COMPOSER_VERSION,
  waitTimeout = LOCK_WAIT_TIMEOUT,
} = {}) {
  const pending = new Map();

  async function prepare({
    environment = process.env,
    lockSource,
    manifestSource,
  }) {
    if (
      typeof manifestSource !== "string" ||
      typeof lockSource !== "string" ||
      Buffer.byteLength(manifestSource, "utf8") > 16 * 1024 * 1024 ||
      Buffer.byteLength(lockSource, "utf8") > 32 * 1024 * 1024
    ) {
      return null;
    }
    let manifest;
    let lock;
    try {
      manifest = JSON.parse(manifestSource);
      lock = JSON.parse(lockSource);
    } catch {
      return null;
    }
    const packages = packagePolicy(lock);
    if (
      !repositoryPolicy(manifest, packages ?? []) ||
      packages === null ||
      typeof lock?.["content-hash"] !== "string" ||
      !/^[a-f0-9]{32}$/i.test(lock["content-hash"])
    ) {
      return null;
    }
    const store = await processStore(root);
    if (store === null || !(await processStoreIntact(store))) return null;
    const [composer, php] = await Promise.all([
      executable("composer", environment.PATH),
      executable("php", environment.PATH),
    ]);
    if (composer === null || php === null) return null;
    const tools = await toolIdentity({
      composer,
      php,
      root: store.path,
      run,
      version,
    });
    if (tools === null) return null;
    const inputs = Object.freeze({
      lock: inputIdentity(lockSource),
      manifest: inputIdentity(manifestSource),
    });
    const key = digest(
      canonicalJson({
        lock: lockSource,
        manifest: manifestSource,
        tools,
        version: 2,
      }),
    );
    const identity = Object.freeze({ inputs, key, store, tools });
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      if (!(await processStoreIntact(store))) return null;
      const target = join(store.path, key);
      const warm = await storedEntry(target, identity);
      if (warm !== null) return warm;
      const lockHandle = await acquireLock({
        interval,
        key,
        now: Date.now,
        root: store.path,
        staleAfter,
        waitTimeout,
      });
      if (lockHandle === null) return null;
      let build = null;
      let publication = null;
      try {
        const winner = await storedEntry(target, identity);
        if (winner !== null) return winner;
        await cleanOrphans(store.path, key);
        if ((await lstat(target).catch(() => null)) !== null) {
          const invalid = join(store.path, `.invalid-${key}-${randomUUID()}`);
          await rename(target, invalid);
          await removePrivate(invalid);
        }
        build = await mkdtemp(join(store.path, `.building-${key}-`));
        await chmod(build, 0o700);
        const project = join(build, "project");
        const home = join(build, "home");
        const composerHome = join(build, "composer-home");
        const cache = join(build, "cache");
        const temporary = join(build, "tmp");
        await Promise.all([
          mkdir(project, { mode: 0o700 }),
          mkdir(home, { mode: 0o700 }),
          mkdir(composerHome, { mode: 0o700 }),
          mkdir(cache, { mode: 0o700 }),
          mkdir(temporary, { mode: 0o700 }),
        ]);
        await Promise.all([
          writeFile(join(project, "composer.json"), manifestSource, {
            flag: "wx",
            mode: 0o400,
          }),
          writeFile(join(project, "composer.lock"), lockSource, {
            flag: "wx",
            mode: 0o400,
          }),
        ]);
        const options = {
          cwd: project,
          encoding: "utf8",
          env: {
            COMPOSER_ALLOW_SUPERUSER: "0",
            COMPOSER_AUTH: "{}",
            COMPOSER_CACHE_DIR: cache,
            COMPOSER_HOME: composerHome,
            COMPOSER_NO_AUDIT: "1",
            COMPOSER_NO_INTERACTION: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: home,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: [dirname(php.path), dirname(composer.path), "/bin"].join(":"),
            TEMP: temporary,
            TMP: temporary,
            TMPDIR: temporary,
            XDG_CACHE_HOME: cache,
            XDG_CONFIG_HOME: composerHome,
          },
          maxBuffer: OUTPUT_LIMIT,
          timeout: INSTALL_TIMEOUT,
          windowsHide: true,
        };
        if (!(await sourceIntact(project, inputs))) {
          throw new Error("Dependency sources changed before validation.");
        }
        await run(
          php.path,
          [
            composer.path,
            "validate",
            "--no-check-publish",
            "--no-interaction",
            "--no-plugins",
            "--no-ansi",
          ],
          options,
        );
        if (!(await sourceIntact(project, inputs))) {
          throw new Error("Dependency sources changed during validation.");
        }
        await run(
          php.path,
          [
            composer.path,
            "install",
            "--prefer-dist",
            "--ignore-platform-req=ext-*",
            "--no-cache",
            "--no-interaction",
            "--no-plugins",
            "--no-scripts",
            "--no-progress",
            "--no-ansi",
          ],
          options,
        );
        if (
          !(await sourceIntact(project, inputs)) ||
          !(await runtimeIntact(composer)) ||
          !(await runtimeIntact(php)) ||
          !installedMatches(
            packages,
            await readJson(
              join(project, "vendor", "composer", "installed.json"),
            ),
          )
        ) {
          throw new Error("Installed dependency integrity failed.");
        }
        publication = await mkdtemp(join(store.path, `.publishing-${key}-`));
        await chmod(publication, 0o700);
        await rename(join(project, "vendor"), join(publication, "vendor"));
        await seal(join(publication, "vendor"));
        const manifestTree = await tree(join(publication, "vendor"));
        if (
          manifestTree === null ||
          !manifestTree.some(
            ({ path: filePath, type }) =>
              filePath === "autoload.php" && type === "file",
          ) ||
          !manifestTree.some(
            ({ path: filePath, type }) =>
              filePath === "phpunit/phpunit/phpunit" && type === "file",
          )
        ) {
          throw new Error("Installed dependency tree is incomplete.");
        }
        const proofPath = join(publication, "proof.json");
        await writeFile(proofPath, "", {
          flag: "wx",
          mode: 0o600,
        });
        const publicationDetails = await stat(publication);
        const proof = {
          inputs,
          key,
          store,
          target: {
            device: publicationDetails.dev,
            inode: publicationDetails.ino,
            mode: 0o500,
            nlink: publicationDetails.nlink,
            path: target,
          },
          tools,
          tree: manifestTree,
          version: 2,
        };
        proof.authentication = authenticate(proofPayload(proof));
        await writeFile(proofPath, JSON.stringify(proof));
        await chmod(proofPath, 0o400);
        await chmod(publication, 0o500);
        const staged = await storedEntry(publication, identity, target);
        if (staged === null) {
          throw new Error("Staged dependency proof failed validation.");
        }
        await rename(publication, target);
        publication = null;
        return storedEntry(target, identity);
      } catch {
        const winner = await storedEntry(target, identity);
        return winner;
      } finally {
        if (build !== null) await removePrivate(build).catch(() => undefined);
        if (publication !== null) {
          await removePrivate(publication).catch(() => undefined);
        }
        await releaseLock(lockHandle.path, lockHandle.nonce);
      }
    })().finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return Object.freeze({ prepare });
}
