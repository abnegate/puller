import {
  execFile as executeFile,
  spawn as spawnProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { createServer } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import { verifyVerificationDependency } from "./verification-dependency-store.mjs";

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const RUNTIME_LIMIT = 10 * 60 * 1_000;
const UNAVAILABLE =
  /\b(?:command not found|connection refused|failed opening required|module not found|network is unreachable|no such file or directory|operation not permitted|permission denied|timed? out|unavailable|unreachable)\b|(?:class|interface|trait)\s+["']?[^"' \n]+["']?\s+not found|(?:missing|required)\s+(?:dependency|environment variable|extension|service)\b/i;
const execFile = promisify(executeFile);

function inside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
}

async function canonical(path, kind = "directory") {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return null;
  try {
    const target = await realpath(path);
    const details = await lstat(path);
    if (
      details.isSymbolicLink() ||
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

function escapeProfile(value) {
  return JSON.stringify(String(value));
}

function runtimeRoot(command) {
  const marker = "/Cellar/";
  const index = command.indexOf(marker);
  if (index === -1) return dirname(command);
  const components = command.slice(index + marker.length).split("/");
  return command.slice(
    0,
    index + marker.length + components.slice(0, 2).join("/").length,
  );
}

async function macRuntimePaths(command) {
  const pending = [command];
  const paths = new Set([command]);
  while (pending.length > 0 && paths.size <= 256) {
    const current = pending.pop();
    let output;
    try {
      output = await execFile("/usr/bin/otool", ["-L", current], {
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const line of String(output.stdout ?? "")
      .split("\n")
      .slice(1)) {
      let path = line.trim().split(/\s+\(/, 1)[0];
      if (path.startsWith("@rpath/")) {
        path = join(runtimeRoot(current), "lib", basename(path));
      } else if (path.startsWith("@loader_path/")) {
        path = resolve(dirname(current), path.slice("@loader_path/".length));
      }
      if (!isAbsolute(path) || paths.has(path)) continue;
      paths.add(path);
      try {
        const target = await realpath(path);
        paths.add(target);
        if (!target.startsWith("/System/") && !target.startsWith("/usr/lib/")) {
          pending.push(target);
        }
      } catch {
        // A missing dependency will make the confined command unavailable.
      }
    }
  }
  if ([...paths].some((path) => path.includes("openssl"))) {
    for (const configuration of [
      "/opt/homebrew/etc/openssl@3/openssl.cnf",
      "/private/etc/ssl/openssl.cnf",
    ]) {
      if ((await canonical(configuration, "file")) !== null) {
        paths.add(configuration);
      }
    }
  }
  return [...paths];
}

function macProfile({ command, reads, runtimes = [], writes }) {
  const readableTrees = new Set([
    "/System",
    "/dev",
    "/usr/lib",
    "/usr/share",
    ...reads,
    ...writes,
  ]);
  const readableFiles = new Set([command, ...runtimes]);
  const runtimeTrees = new Set(
    runtimes
      .filter((path) => !path.endsWith("/openssl.cnf"))
      .map((path) => dirname(path)),
  );
  const metadata = new Set();
  for (const value of [...readableFiles, ...readableTrees]) {
    let path = value;
    while (path !== "/") {
      metadata.add(path);
      path = dirname(path);
    }
  }
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    `(allow process-exec (literal ${escapeProfile(command)}))`,
    "(deny signal)",
    "(allow sysctl-read)",
    ...[...readableTrees].map(
      (path) => `(allow file-read* (subpath ${escapeProfile(path)}))`,
    ),
    ...[...runtimeTrees].map(
      (path) => `(allow file-read* (subpath ${escapeProfile(path)}))`,
    ),
    ...[...readableFiles].map(
      (path) => `(allow file-read* (literal ${escapeProfile(path)}))`,
    ),
    ...[...metadata].map(
      (path) => `(allow file-read-metadata (literal ${escapeProfile(path)}))`,
    ),
    ...writes.map(
      (path) => `(allow file-write* (subpath ${escapeProfile(path)}))`,
    ),
    "(deny network*)",
    '(deny file-read* (literal "/private/etc/hosts"))',
    '(deny file-read* (literal "/private/etc/passwd"))',
  ].join("\n");
}

async function collect(child, maximum = OUTPUT_LIMIT) {
  let output = Buffer.alloc(0);
  let exceeded = false;
  const append = (chunk) => {
    if (exceeded) return;
    const value = Buffer.from(chunk);
    const remaining = maximum - output.byteLength;
    if (value.byteLength > remaining) {
      output = Buffer.concat([
        output,
        value.subarray(0, Math.max(0, remaining)),
      ]);
      exceeded = true;
    } else {
      output = Buffer.concat([output, value]);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return new Promise((resolveResult) => {
    child.once("error", () =>
      resolveResult({ code: null, exceeded, output: output.toString("utf8") }),
    );
    child.once("close", (code, signal) =>
      resolveResult({
        code,
        exceeded,
        output: output.toString("utf8"),
        signal,
      }),
    );
  });
}

async function trustedBinary(path, { owner = null } = {}) {
  const canonicalPath = await canonical(path, "file");
  if (canonicalPath !== path) return null;
  const details = await stat(path);
  if (
    (details.mode & 0o111) === 0 ||
    (owner !== null && details.uid !== owner)
  ) {
    return null;
  }
  return Object.freeze({
    device: details.dev,
    inode: details.ino,
    path,
    size: details.size,
  });
}

async function unchanged(proof) {
  try {
    const details = await stat(proof.path);
    return (
      details.dev === proof.device &&
      details.ino === proof.inode &&
      details.size === proof.size
    );
  } catch {
    return false;
  }
}

function minimalEnvironment(home, temporary, command, extra = {}) {
  return {
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: [...new Set([dirname(command), "/usr/bin", "/bin"])].join(":"),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    ...extra,
  };
}

async function macProbe(binary, root, spawn) {
  const allowed = join(root, "allowed");
  const denied = join(dirname(root), `puller-denied-${randomUUID()}`);
  await Promise.all([
    writeFile(allowed, "allowed\n", { mode: 0o600 }),
    writeFile(denied, "secret\n", { mode: 0o600 }),
  ]);
  const environment = minimalEnvironment(root, root, "/bin/cat");
  const run = (path) =>
    collect(
      spawn(
        binary.path,
        [
          "-p",
          macProfile({
            command: "/bin/cat",
            reads: [root],
            writes: [root],
          }),
          "--",
          "/bin/cat",
          path,
        ],
        {
          cwd: root,
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
      64 * 1024,
    );
  try {
    const positive = await run(allowed);
    const negative = await run(denied);
    const hostConfiguration = await run("/private/etc/hosts");
    const network = await networkProbe((port) =>
      collect(
        spawn(
          binary.path,
          [
            "-p",
            macProfile({
              command: "/usr/bin/nc",
              reads: [root],
              writes: [root],
            }),
            "--",
            "/usr/bin/nc",
            "-w",
            "1",
            "127.0.0.1",
            String(port),
          ],
          {
            cwd: root,
            env: minimalEnvironment(root, root, "/usr/bin/nc"),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        ),
        64 * 1024,
      ),
    );
    return (
      positive.code === 0 &&
      positive.output === "allowed\n" &&
      negative.code !== 0 &&
      hostConfiguration.code !== 0 &&
      network
    );
  } finally {
    await rm(denied, { force: true });
  }
}

async function networkProbe(run) {
  let connected = false;
  const server = createServer((socket) => {
    connected = true;
    socket.destroy();
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") return false;
    const result = await run(address.port);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    return result.code !== 0 && !connected;
  } catch {
    return false;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function linuxArguments({
  command,
  args,
  cwd,
  home,
  reads,
  temporary,
  writes,
}) {
  const values = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-net",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
    values.push("--ro-bind-try", path, path);
  }
  values.push("--dir", "/etc");
  for (const path of [
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/localtime",
  ]) {
    values.push("--ro-bind-try", path, path);
  }
  for (const path of reads) values.push("--ro-bind", path, path);
  for (const path of writes) values.push("--bind", path, path);
  values.push(
    "--setenv",
    "HOME",
    home,
    "--setenv",
    "TMPDIR",
    temporary,
    "--setenv",
    "TMP",
    temporary,
    "--setenv",
    "TEMP",
    temporary,
    "--setenv",
    "PATH",
    [...new Set([dirname(command), "/usr/bin", "/bin"])].join(":"),
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--chdir",
    cwd,
    "--",
    command,
    ...args,
  );
  return values;
}

async function linuxProbe(binary, root, spawn) {
  const allowed = join(root, "allowed");
  const denied = join(dirname(root), `puller-denied-${randomUUID()}`);
  await Promise.all([
    writeFile(allowed, "allowed\n", { mode: 0o600 }),
    writeFile(denied, "secret\n", { mode: 0o600 }),
  ]);
  try {
    const positive = await collect(
      spawn(
        binary.path,
        linuxArguments({
          args: [allowed],
          command: "/bin/cat",
          cwd: root,
          home: join(root, "home"),
          reads: [root],
          temporary: join(root, "tmp"),
          writes: [root],
        }),
        {
          cwd: root,
          env: {},
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
      64 * 1024,
    );
    const negative = await collect(
      spawn(
        binary.path,
        linuxArguments({
          args: [denied],
          command: "/bin/cat",
          cwd: root,
          home: join(root, "home"),
          reads: [root],
          temporary: join(root, "tmp"),
          writes: [root],
        }),
        {
          cwd: root,
          env: {},
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
      64 * 1024,
    );
    const hostConfiguration = await collect(
      spawn(
        binary.path,
        linuxArguments({
          args: ["/etc/hosts"],
          command: "/bin/cat",
          cwd: root,
          home: join(root, "home"),
          reads: [root],
          temporary: join(root, "tmp"),
          writes: [root],
        }),
        {
          cwd: root,
          env: {},
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      ),
      64 * 1024,
    );
    const network = await networkProbe((port) =>
      collect(
        spawn(
          binary.path,
          linuxArguments({
            args: ["-w", "1", "127.0.0.1", String(port)],
            command: "/usr/bin/nc",
            cwd: root,
            home: join(root, "home"),
            reads: [root],
            temporary: join(root, "tmp"),
            writes: [root],
          }),
          {
            cwd: root,
            env: {},
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        ),
        64 * 1024,
      ),
    );
    return (
      positive.code === 0 &&
      positive.output === "allowed\n" &&
      negative.code !== 0 &&
      hostConfiguration.code !== 0 &&
      network
    );
  } finally {
    await rm(denied, { force: true });
  }
}

function safeBindingPath(path) {
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

async function readBinding(sourceRoot, binding) {
  if (
    !safeBindingPath(binding?.path) ||
    !/^[a-f0-9]{64}$/.test(binding.digest) ||
    !Number.isSafeInteger(binding.mode) ||
    !Number.isSafeInteger(binding.size) ||
    binding.size < 0
  ) {
    return null;
  }
  const root = await canonical(sourceRoot);
  if (root === null) return null;
  let path = root;
  try {
    for (const part of binding.path.split("/")) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) return null;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (
        !details.isFile() ||
        details.nlink !== 1 ||
        (details.mode & 0o7777) !== binding.mode ||
        details.size !== binding.size
      ) {
        return null;
      }
      const content = await handle.readFile();
      if (
        content.byteLength !== binding.size ||
        createHash("sha256").update(content).digest("hex") !== binding.digest
      ) {
        return null;
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function dependencyPaths(root) {
  const canonicalRoot = await canonical(root);
  if (canonicalRoot === null) return null;
  const paths = [];
  const pending = [{ path: canonicalRoot, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const directories = [];
    for (const entry of entries) {
      const path =
        current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
      if (!safeBindingPath(path)) return null;
      const target = join(current.path, entry.name);
      let details;
      try {
        details = await lstat(target);
      } catch {
        return null;
      }
      if (details.isSymbolicLink()) return null;
      if (details.isDirectory()) {
        const directory = await canonical(target);
        if (
          directory === null ||
          directory !== resolve(target) ||
          !inside(canonicalRoot, directory)
        ) {
          return null;
        }
        directories.push({ path: directory, prefix: path });
      } else if (details.isFile() && details.nlink === 1) {
        paths.push(path);
      } else {
        return null;
      }
    }
    for (const directory of directories.reverse()) pending.push(directory);
  }
  return paths.sort();
}

async function verifyDependencyTree(tree) {
  if (
    !tree ||
    typeof tree !== "object" ||
    !Array.isArray(tree.files) ||
    tree.files.length === 0
  ) {
    return false;
  }
  const root = await canonical(tree.root);
  if (root === null || root !== tree.root) return false;
  if (
    !(await verifyVerificationDependency(tree.provenance)) ||
    tree.provenance.root !== root
  ) {
    return false;
  }
  const expected = tree.files.map(({ path }) => path);
  if (
    new Set(expected).size !== expected.length ||
    expected.some((path) => !safeBindingPath(path))
  ) {
    return false;
  }
  const actual = await dependencyPaths(root);
  const sorted = [...expected].sort();
  if (
    actual === null ||
    actual.length !== sorted.length ||
    actual.some((path, index) => path !== sorted[index])
  ) {
    return false;
  }
  for (const binding of tree.files) {
    if ((await readBinding(root, binding)) === null) return false;
  }
  return true;
}

async function sealDependencyTree(base, tree) {
  if (!(await verifyDependencyTree(tree))) return null;
  const root = await mkdtemp(join(base, "dependency-"));
  const files = [];
  try {
    for (const binding of tree.files) {
      const content = await readBinding(tree.root, binding);
      if (content === null) {
        await rm(root, { force: true, recursive: true });
        return null;
      }
      const destination = join(root, binding.path);
      await mkdir(dirname(destination), { mode: 0o700, recursive: true });
      await writeFile(destination, content, { flag: "wx", mode: 0o400 });
      await chmod(destination, 0o400);
      files.push(
        Object.freeze({
          ...binding,
          mode: 0o400,
          origin: "dependency",
        }),
      );
    }
    return Object.freeze({
      files: Object.freeze(files),
      root,
    });
  } catch {
    await rm(root, { force: true, recursive: true });
    return null;
  }
}

async function verifySealedDependencyTree(tree) {
  if (
    !tree ||
    typeof tree !== "object" ||
    !Array.isArray(tree.files) ||
    tree.files.length === 0
  ) {
    return false;
  }
  const root = await canonical(tree.root);
  if (root === null || root !== tree.root) return false;
  const actual = await dependencyPaths(root);
  const expected = tree.files.map(({ path }) => path).sort();
  if (
    actual === null ||
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    return false;
  }
  for (const binding of tree.files) {
    if ((await readBinding(root, binding)) === null) return false;
  }
  return true;
}

export async function verifyVerificationRuntime(runtime) {
  if (
    typeof runtime?.path !== "string" ||
    !isAbsolute(runtime.path) ||
    !/^[a-f0-9]{64}$/.test(runtime.digest) ||
    !Number.isSafeInteger(runtime.device) ||
    !Number.isSafeInteger(runtime.inode) ||
    !Number.isSafeInteger(runtime.mode) ||
    !Number.isSafeInteger(runtime.size) ||
    runtime.size < 0
  ) {
    return false;
  }
  try {
    if ((await realpath(runtime.path)) !== runtime.path) return false;
    const handle = await open(
      runtime.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const details = await handle.stat();
      if (
        !details.isFile() ||
        details.dev !== runtime.device ||
        details.ino !== runtime.inode ||
        (details.mode & 0o7777) !== runtime.mode ||
        details.size !== runtime.size
      ) {
        return false;
      }
      const content = await handle.readFile();
      return (
        content.byteLength === runtime.size &&
        createHash("sha256").update(content).digest("hex") === runtime.digest
      );
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function materialize(
  base,
  {
    bindings,
    dependencies = [],
    directory,
    generated = [],
    links = [],
    predecessorRoot = null,
    sourceRoot,
  },
) {
  if (
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    (directory !== "." && !safeBindingPath(directory))
  ) {
    return null;
  }
  const phase = await mkdtemp(join(base, "phase-"));
  const workspace = join(phase, "workspace");
  const home = join(phase, "home");
  const temporary = join(phase, "tmp");
  try {
    await Promise.all([
      mkdir(workspace, { mode: 0o700 }),
      mkdir(home, { mode: 0o700 }),
      mkdir(temporary, { mode: 0o700 }),
    ]);
    for (const binding of bindings) {
      if (
        binding?.origin !== undefined &&
        !["dependency", "phase", "predecessor"].includes(binding.origin)
      ) {
        await rm(phase, { force: true, recursive: true });
        return null;
      }
      const origin =
        binding?.origin === "predecessor" ? predecessorRoot : sourceRoot;
      if (origin === null) {
        await rm(phase, { force: true, recursive: true });
        return null;
      }
      const content = await readBinding(origin, binding);
      if (content === null) {
        await rm(phase, { force: true, recursive: true });
        return null;
      }
      const destination = join(workspace, binding.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { mode: 0o400 });
      await chmod(destination, 0o400);
    }
    for (const file of generated) {
      if (
        !safeBindingPath(file?.path) ||
        typeof file.content !== "string" ||
        Buffer.byteLength(file.content, "utf8") > 1024 * 1024 ||
        file.mode !== 0o400
      ) {
        await rm(phase, { force: true, recursive: true });
        return null;
      }
      const destination = join(workspace, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, {
        flag: "wx",
        mode: file.mode,
      });
      await chmod(destination, file.mode);
    }
    const dependencyRoots = new Set(dependencies.map(({ root }) => root));
    for (const link of links) {
      if (
        !safeBindingPath(link?.path) ||
        !dependencyRoots.has(link.target) ||
        (await canonical(link.target)) !== link.target
      ) {
        await rm(phase, { force: true, recursive: true });
        return null;
      }
      const destination = join(workspace, link.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await symlink(link.target, destination, "dir");
    }
    const cwd =
      directory === "."
        ? workspace
        : await canonical(join(workspace, directory));
    if (cwd === null) {
      await rm(phase, { force: true, recursive: true });
      return null;
    }
    return { cwd, home, phase, temporary, workspace };
  } catch {
    await rm(phase, { force: true, recursive: true });
    return null;
  }
}

export function createVerificationConfinement({
  platform = hostPlatform(),
  spawn = spawnProcess,
} = {}) {
  const executable =
    platform === "darwin"
      ? "/usr/bin/sandbox-exec"
      : platform === "linux"
        ? "/usr/bin/bwrap"
        : null;
  let proof = null;

  async function prepare({ root }) {
    const canonicalRoot = await canonical(root);
    if (canonicalRoot === null || executable === null) return null;
    const base = await mkdtemp(join(canonicalRoot, "confinement-"));
    await chmod(base, 0o700);
    try {
      if (proof === null) {
        proof = await trustedBinary(executable, {
          owner: platform === "linux" ? 0 : null,
        });
        if (
          proof === null ||
          !(platform === "darwin"
            ? await macProbe(proof, base, spawn)
            : await linuxProbe(proof, base, spawn))
        ) {
          proof = null;
          await rm(base, { force: true, recursive: true });
          return null;
        }
      } else if (!(await unchanged(proof))) {
        proof = null;
        await rm(base, { force: true, recursive: true });
        return null;
      }
      let cleaned = false;
      const sealedDependencies = new WeakMap();
      const seal = (tree) => {
        if (!sealedDependencies.has(tree)) {
          sealedDependencies.set(tree, sealDependencyTree(base, tree));
        }
        return sealedDependencies.get(tree);
      };
      return Object.freeze({
        async cleanup() {
          if (cleaned) return;
          cleaned = true;
          await rm(base, { force: true, recursive: true });
        },
        async run({
          args,
          bindings,
          dependencies = [],
          directory,
          generated = [],
          links = [],
          predecessorRoot = null,
          runtime,
          sourceRoot,
          timeout = RUNTIME_LIMIT,
          tools = {},
        }) {
          if (!(await unchanged(proof))) {
            return Object.freeze({
              code: null,
              output: "",
              reason: "confinement_changed",
              unavailable: true,
            });
          }
          const runtimeValid = await verifyVerificationRuntime(runtime);
          const dependenciesValid =
            Array.isArray(dependencies) &&
            (
              await Promise.all(
                dependencies.map((tree) => verifyDependencyTree(tree)),
              )
            ).every(Boolean);
          const toolsValid =
            tools &&
            typeof tools === "object" &&
            !Array.isArray(tools) &&
            (
              await Promise.all(
                Object.entries(tools).map(async ([name, tool]) => {
                  if (name === "phpunit") {
                    const tree = dependencies.find(({ root }) =>
                      inside(root, tool?.path ?? ""),
                    );
                    if (tree === undefined) return false;
                    const path = relative(tree.root, tool.path).replaceAll(
                      "\\",
                      "/",
                    );
                    const binding = tree.files.find(
                      (candidate) => candidate.path === path,
                    );
                    return (
                      binding !== undefined &&
                      binding.digest === tool.digest &&
                      binding.mode === tool.mode &&
                      binding.size === tool.size
                    );
                  }
                  return false;
                }),
              )
            ).every(Boolean);
          const sealed = dependenciesValid
            ? await Promise.all(dependencies.map((tree) => seal(tree)))
            : [];
          const sealedValid =
            sealed.length === dependencies.length &&
            sealed.every((tree) => tree !== null) &&
            (
              await Promise.all(
                sealed.map((tree) => verifySealedDependencyTree(tree)),
              )
            ).every(Boolean);
          const translated = new Map(
            dependencies.map((tree, index) => [tree.root, sealed[index]?.root]),
          );
          const sealedLinks = links.map((link) =>
            Object.freeze({
              ...link,
              target: translated.get(link.target) ?? "",
            }),
          );
          const staged = await materialize(base, {
            bindings,
            dependencies: sealed,
            directory,
            generated,
            links: sealedLinks,
            predecessorRoot,
            sourceRoot,
          });
          if (
            !runtimeValid ||
            !dependenciesValid ||
            !sealedValid ||
            !toolsValid ||
            staged === null
          ) {
            return Object.freeze({
              code: null,
              output: "",
              reason: "execution_changed",
              unavailable: true,
            });
          }
          try {
            const canonicalCommand = runtime.path;
            const runtimes =
              platform === "darwin"
                ? await macRuntimePaths(canonicalCommand)
                : [];
            const openssl = runtimes.find((path) =>
              path.endsWith("/openssl.cnf"),
            );
            const environment = minimalEnvironment(
              staged.home,
              staged.temporary,
              canonicalCommand,
              {
                COMPOSER_ALLOW_SUPERUSER: "0",
                COMPOSER_DISABLE_NETWORK: "1",
                COMPOSER_NO_INTERACTION: "1",
                XDEBUG_MODE: "off",
                ...(openssl === undefined ? {} : { OPENSSL_CONF: openssl }),
              },
            );
            const reads = [staged.workspace, ...sealed.map(({ root }) => root)];
            const invocation =
              platform === "darwin"
                ? {
                    args: [
                      "-p",
                      macProfile({
                        command: canonicalCommand,
                        reads,
                        runtimes,
                        writes: [staged.home, staged.temporary],
                      }),
                      "--",
                      canonicalCommand,
                      ...args,
                    ],
                    command: proof.path,
                    environment,
                  }
                : {
                    args: linuxArguments({
                      args,
                      command: canonicalCommand,
                      cwd: staged.cwd,
                      home: staged.home,
                      reads,
                      temporary: staged.temporary,
                      writes: [staged.home, staged.temporary],
                    }),
                    command: proof.path,
                    environment: {},
                  };
            const dependenciesReady = (
              await Promise.all(
                dependencies.map((tree) => verifyDependencyTree(tree)),
              )
            ).every(Boolean);
            const sealedReady = (
              await Promise.all(
                sealed.map((tree) => verifySealedDependencyTree(tree)),
              )
            ).every(Boolean);
            if (
              !(await verifyVerificationRuntime(runtime)) ||
              !dependenciesReady ||
              !sealedReady
            ) {
              return Object.freeze({
                code: null,
                output: "",
                reason:
                  dependenciesReady && sealedReady
                    ? "execution_changed"
                    : "dependency_changed",
                unavailable: true,
              });
            }
            const child = spawn(invocation.command, invocation.args, {
              cwd: staged.cwd,
              env: invocation.environment,
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });
            const timer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // A completed process no longer needs termination.
              }
            }, timeout);
            timer.unref?.();
            const result = await collect(child);
            clearTimeout(timer);
            const dependenciesIntact = (
              await Promise.all(
                dependencies.map((tree) => verifyDependencyTree(tree)),
              )
            ).every(Boolean);
            const sealedIntact = (
              await Promise.all(
                sealed.map((tree) => verifySealedDependencyTree(tree)),
              )
            ).every(Boolean);
            if (!dependenciesIntact || !sealedIntact) {
              return Object.freeze({
                code: null,
                output: "",
                reason: "dependency_changed",
                unavailable: true,
              });
            }
            return Object.freeze({
              code: result.code,
              output: result.output,
              reason: result.exceeded ? "output_limit" : null,
              unavailable:
                result.exceeded ||
                result.code === null ||
                (result.code !== 0 && UNAVAILABLE.test(result.output)),
            });
          } finally {
            await rm(staged.phase, { force: true, recursive: true });
          }
        },
      });
    } catch {
      await rm(base, { force: true, recursive: true });
      return null;
    }
  }

  return Object.freeze({ prepare });
}

function recipeLabel(recipe) {
  if (recipe?.kind === "tool") {
    return `${recipe.name} ${recipe.sourcePath}`;
  }
  if (recipe?.kind === "script") {
    return `${recipe.manifestPath} script ${recipe.name}`;
  }
  return "trusted behavioral probe";
}

function exitLabel(result) {
  return Number.isInteger(result?.code)
    ? `exit ${result.code}`
    : "no exit code";
}

export async function executeVerificationPlan({
  confinement,
  plan,
  roots,
} = {}) {
  if (!confinement || plan?.outcome !== "ready") {
    const reason = plan?.reason ?? "confinement_unavailable";
    return Object.freeze({
      diagnostics: Object.freeze([
        `No trusted behavioral probe ran (${reason}).`,
      ]),
      outcome: "unavailable",
      reason,
      recipes: Object.freeze([]),
    });
  }
  const diagnostics = [];
  for (const candidate of plan.plans) {
    const label = recipeLabel(candidate.recipe);
    const common = {
      args: candidate.args,
      dependencies: candidate.dependencies,
      directory: candidate.directory,
      generated: candidate.generated,
      links: candidate.links,
      predecessorRoot: roots.predecessorRoot,
      runtime: candidate.runtime,
      tools: candidate.tools,
    };
    const predecessor = await confinement.run({
      ...common,
      bindings: candidate.bindings.predecessor,
      sourceRoot: roots.predecessorRoot,
    });
    if (predecessor.unavailable) {
      const reason = predecessor.reason ?? "predecessor_unavailable";
      return Object.freeze({
        diagnostics: Object.freeze([
          ...diagnostics,
          `${label}: the predecessor probe was unavailable (${reason}).`,
        ]),
        outcome: "unavailable",
        reason,
        recipes: Object.freeze([]),
      });
    }
    if (predecessor.code === 0) {
      diagnostics.push(
        `${label}: the predecessor already passed, so this probe cannot distinguish the pull request behavior.`,
      );
      continue;
    }
    const release = await confinement.run({
      ...common,
      bindings: candidate.bindings.release,
      sourceRoot: roots.releaseRoot,
    });
    if (release.unavailable) {
      const reason = release.reason ?? "release_unavailable";
      return Object.freeze({
        diagnostics: Object.freeze([
          ...diagnostics,
          `${label}: the predecessor failed (${exitLabel(predecessor)}), but the exact-target probe was unavailable (${reason}).`,
        ]),
        outcome: "unavailable",
        reason,
        recipes: Object.freeze([]),
      });
    }
    if (release.code === 0) {
      return Object.freeze({
        diagnostics: Object.freeze([
          ...diagnostics,
          `${label}: the predecessor failed (${exitLabel(predecessor)}) and the exact target passed.`,
        ]),
        outcome: "verified",
        reason: "behavior_passed",
        recipes: Object.freeze([candidate.recipe]),
      });
    }
    diagnostics.push(
      `${label}: the predecessor failed (${exitLabel(predecessor)}) and the exact target also failed (${exitLabel(release)}).`,
    );
  }
  return Object.freeze({
    diagnostics: Object.freeze(
      diagnostics.length > 0
        ? diagnostics
        : [
            "No unchanged predecessor-owned behavioral probe was available; pull-request-added or modified tests were excluded.",
          ],
    ),
    outcome: "not_verified",
    reason: "behavior_not_distinguished",
    recipes: Object.freeze([]),
  });
}
