import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVerificationDependencyStore,
  verifyVerificationDependency,
} from "../verification-dependency-store.mjs";

const roots = [];
const reference = "a".repeat(40);
const execute = promisify(execFile);
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifest(overrides = {}) {
  return JSON.stringify({
    scripts: { test: "vendor/bin/phpunit" },
    ...overrides,
  });
}

function lockedPackage(overrides = {}) {
  return {
    dist: {
      reference,
      shasum: "",
      type: "zip",
      url: `https://api.github.com/repos/phpunit/phpunit/zipball/${reference}`,
    },
    name: "phpunit/phpunit",
    source: {
      reference,
      type: "git",
      url: "https://github.com/phpunit/phpunit.git",
    },
    type: "library",
    version: "12.5.31",
    ...overrides,
  };
}

function lockfile({ development = [lockedPackage()], packages = [] } = {}) {
  return JSON.stringify({
    "content-hash": "b".repeat(32),
    packages,
    "packages-dev": development,
  });
}

async function fixture({ failInstall = false, installDelay = 0 } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "puller-dependency-store-")),
  );
  roots.push(root);
  const tools = join(root, "tools");
  const storeRoot = join(root, "store");
  const poison = join(root, "poison");
  await Promise.all([
    mkdir(tools, { mode: 0o700 }),
    mkdir(poison, { mode: 0o700 }),
  ]);
  const php = join(tools, "php");
  const composer = join(tools, "composer");
  await Promise.all([
    writeFile(php, "#!/bin/sh\nexit 99\n", { mode: 0o700 }),
    writeFile(composer, "#!/bin/sh\nexit 99\n", { mode: 0o700 }),
    writeFile(join(poison, "autoload.php"), "<?php throw new Exception();\n"),
  ]);
  let installs = 0;
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ args: [...args], command, options });
    if (args.length === 1 && args[0] === "--version") {
      return { stderr: "", stdout: "PHP 8.5.8 (cli)\n" };
    }
    if (args.includes("--version")) {
      return {
        stderr: "",
        stdout: "Composer version 2.10.2 2026-07-01 11:24:45\n",
      };
    }
    if (args.includes("validate")) return { stderr: "", stdout: "" };
    if (!args.includes("install")) throw new Error("Unexpected invocation.");
    installs += 1;
    if (failInstall) throw new Error("Composer failed.");
    if (installDelay > 0) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, installDelay),
      );
    }
    const vendor = join(options.cwd, "vendor");
    await Promise.all([
      mkdir(join(vendor, "composer"), { recursive: true, mode: 0o700 }),
      mkdir(join(vendor, "phpunit", "phpunit"), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    const lock = JSON.parse(
      await readFile(join(options.cwd, "composer.lock"), "utf8"),
    );
    await Promise.all([
      writeFile(
        join(vendor, "composer", "installed.json"),
        JSON.stringify({
          packages: [...lock.packages, ...lock["packages-dev"]],
        }),
      ),
      writeFile(join(vendor, "autoload.php"), "<?php return true;\n"),
      writeFile(
        join(vendor, "phpunit", "phpunit", "phpunit"),
        "<?php exit(0);\n",
        { mode: 0o700 },
      ),
    ]);
    return { stderr: "", stdout: "" };
  };
  return {
    calls,
    environment: {
      COMPOSER_CACHE_DIR: poison,
      COMPOSER_HOME: poison,
      COMPOSER_VENDOR_DIR: poison,
      HOME: poison,
      PATH: tools,
    },
    get installs() {
      return installs;
    },
    poison,
    root,
    run,
    storeRoot,
  };
}

function store(value, overrides = {}) {
  return createVerificationDependencyStore({
    interval: 5,
    root: value.storeRoot,
    run: value.run,
    staleAfter: 20,
    waitTimeout: 2_000,
    ...overrides,
  });
}

async function prepare(value, dependencyStore = store(value), sources = {}) {
  return dependencyStore.prepare({
    environment: value.environment,
    lockSource: sources.lockSource ?? lockfile(),
    manifestSource: sources.manifestSource ?? manifest(),
  });
}

async function makeWritable(path) {
  const details = await lstat(path).catch(() => null);
  if (details === null || details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) {
      await makeWritable(join(path, name));
    }
  } else {
    await chmod(path, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeWritable(root);
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("verification dependency store", () => {
  it("materializes exact dependencies privately without inherited Composer state", async () => {
    const value = await fixture();
    const entry = await prepare(value);

    expect(entry).not.toBeNull();
    expect(value.installs).toBe(1);
    expect(await verifyVerificationDependency(entry)).toBe(true);
    const install = value.calls.find(({ args }) => args.includes("install"));
    expect(install.args).toEqual([
      expect.stringContaining("composer"),
      "install",
      "--prefer-dist",
      "--ignore-platform-req=ext-*",
      "--no-cache",
      "--no-interaction",
      "--no-plugins",
      "--no-scripts",
      "--no-progress",
      "--no-ansi",
    ]);
    expect(install.options.env).toMatchObject({
      COMPOSER_AUTH: "{}",
      COMPOSER_NO_INTERACTION: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(install.options.env.COMPOSER_HOME).not.toBe(value.poison);
    expect(install.options.env.COMPOSER_CACHE_DIR).not.toBe(value.poison);
    expect(install.options.env).not.toHaveProperty("COMPOSER_VENDOR_DIR");
    expect(await readFile(join(entry.root, "autoload.php"), "utf8")).toBe(
      "<?php return true;\n",
    );
    const proof = JSON.parse(
      await readFile(join(entry.root, "..", "proof.json"), "utf8"),
    );
    expect(proof.authentication).toMatch(/^[a-f0-9]{64}$/);
    expect(proof).not.toHaveProperty("secret");
    expect(proof).not.toHaveProperty("namespace");
    expect(proof.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 0o400,
          nlink: 1,
          path: "autoload.php",
          type: "file",
        }),
      ]),
    );
  });

  it("reuses a validated warm entry without reinstalling", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const second = await prepare(value, store(value));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second.key).toBe(first.key);
    expect(value.installs).toBe(1);
  });

  it("rebuilds cold in a fresh process while preserving same-process warm reuse", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const parentDirectory = dirname(dirname(first.root));
    const manifestSource = manifest();
    const lockSource = lockfile();
    const child = await execute(process.execPath, [
      join(
        fixtureDirectory,
        "fixtures",
        "verification-dependency-store-child.mjs",
      ),
      value.storeRoot,
      join(value.root, "tools"),
      Buffer.from(manifestSource).toString("base64"),
      Buffer.from(lockSource).toString("base64"),
      dirname(first.root),
    ]);
    const result = JSON.parse(child.stdout);

    expect(result.installs).toBe(1);
    expect(result.root).not.toBeNull();
    expect(dirname(dirname(result.root))).not.toBe(parentDirectory);
    expect(await verifyVerificationDependency(first)).toBe(true);
    expect(await prepare(value, store(value))).not.toBeNull();
    expect(value.installs).toBe(1);
  });

  it("uses exact manifest, lock, Composer, and PHP inputs in the key", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const second = await prepare(value, store(value), {
      manifestSource: `${manifest()}\n`,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second.key).not.toBe(first.key);
    expect(value.installs).toBe(2);
  });

  it("fails closed when an input changes between Composer phases", async () => {
    const value = await fixture();
    const dependencyStore = store(value, {
      run: async (command, args, options) => {
        const result = await value.run(command, args, options);
        if (args.includes("validate")) {
          const path = join(options.cwd, "composer.lock");
          await chmod(path, 0o600);
          await writeFile(path, `${lockfile()}\n`);
          await chmod(path, 0o400);
        }
        return result;
      },
    });

    await expect(prepare(value, dependencyStore)).resolves.toBeNull();
    expect(value.installs).toBe(0);
  });

  it.each([
    [
      "an arbitrary HTTPS URL containing the lock SHA",
      lockedPackage({
        dist: {
          reference,
          shasum: "",
          type: "zip",
          url: `https://packages.example.invalid/archive/${reference}.zip`,
        },
      }),
    ],
    [
      "a GitHub archive for another repository",
      lockedPackage({
        dist: {
          reference,
          shasum: "",
          type: "zip",
          url: `https://api.github.com/repos/attacker/project/zipball/${reference}`,
        },
      }),
    ],
    [
      "a mutable source reference",
      lockedPackage({
        dist: {
          reference: "main",
          shasum: "",
          type: "zip",
          url: "https://api.github.com/repos/phpunit/phpunit/zipball/main",
        },
        source: {
          reference: "main",
          type: "git",
          url: "https://github.com/phpunit/phpunit.git",
        },
      }),
    ],
    [
      "a mismatched immutable source reference",
      lockedPackage({
        source: {
          reference: "c".repeat(40),
          type: "git",
          url: "https://github.com/phpunit/phpunit.git",
        },
      }),
    ],
    [
      "an empty checksum with a mutable query",
      lockedPackage({
        dist: {
          reference,
          shasum: "",
          type: "zip",
          url: `https://api.github.com/repos/phpunit/phpunit/zipball/${reference}?token=x`,
        },
      }),
    ],
  ])("rejects %s", async (_label, dependency) => {
    const value = await fixture();
    await expect(
      prepare(value, store(value), {
        lockSource: lockfile({ development: [dependency] }),
      }),
    ).resolves.toBeNull();
    expect(value.installs).toBe(0);
  });

  it.each(["artifact", "file", "path"])(
    "rejects a %s repository",
    async (type) => {
      const value = await fixture();
      await expect(
        prepare(value, store(value), {
          manifestSource: manifest({
            repositories: [
              { type, url: "https://github.com/phpunit/phpunit.git" },
            ],
          }),
        }),
      ).resolves.toBeNull();
      expect(value.installs).toBe(0);
    },
  );

  it("allows a canonical VCS repository only when its exact commit is independently locked", async () => {
    const value = await fixture();
    const entry = await prepare(value, store(value), {
      manifestSource: manifest({
        repositories: [
          { type: "vcs", url: "https://github.com/phpunit/phpunit" },
        ],
      }),
    });

    expect(entry).not.toBeNull();
  });

  it("rejects a VCS repository with no exact locked source", async () => {
    const value = await fixture();
    await expect(
      prepare(value, store(value), {
        manifestSource: manifest({
          repositories: [
            { type: "vcs", url: "https://github.com/attacker/project" },
          ],
        }),
      }),
    ).resolves.toBeNull();
  });

  it("allows a source-less canonical GitHub artifact only when its package identity matches", async () => {
    const value = await fixture();
    const dependency = lockedPackage({ source: undefined });
    await expect(
      prepare(value, store(value), {
        lockSource: lockfile({ development: [dependency] }),
      }),
    ).resolves.not.toBeNull();
  });

  it("rejects a source-less GitHub artifact whose package identity does not match", async () => {
    const value = await fixture();
    const dependency = lockedPackage({
      name: "attacker/project",
      source: undefined,
    });
    await expect(
      prepare(value, store(value), {
        lockSource: lockfile({ development: [dependency] }),
      }),
    ).resolves.toBeNull();
  });

  it("validates development packages as strictly as normal packages", async () => {
    const value = await fixture();
    const invalid = lockedPackage({
      dist: {
        reference,
        shasum: "",
        type: "zip",
        url: `https://example.invalid/${reference}.zip`,
      },
    });
    await expect(
      prepare(value, store(value), {
        lockSource: lockfile({
          development: [invalid],
          packages: [lockedPackage({ name: "vendor/runtime" })],
        }),
      }),
    ).resolves.toBeNull();
  });

  it("allows a non-GitHub dist only with an independently checked SHA-1", async () => {
    const value = await fixture();
    const dependency = lockedPackage({
      dist: {
        reference,
        shasum: "d".repeat(40),
        type: "zip",
        url: "https://packages.example.invalid/immutable.zip",
      },
    });
    const entry = await prepare(value, store(value), {
      lockSource: lockfile({ development: [dependency] }),
    });

    expect(entry).not.toBeNull();
  });

  it.each([
    [
      "bytes",
      async (entry) => {
        await chmod(join(entry.root, "autoload.php"), 0o600);
        await writeFile(join(entry.root, "autoload.php"), "x");
      },
    ],
    ["mode", async (entry) => chmod(join(entry.root, "autoload.php"), 0o600)],
    [
      "hard link count",
      async (entry) => {
        await chmod(entry.root, 0o700);
        await link(
          join(entry.root, "autoload.php"),
          join(entry.root, "autoload-copy.php"),
        );
      },
    ],
    [
      "symlink shape",
      async (entry) => {
        await chmod(entry.root, 0o700);
        await rm(join(entry.root, "autoload.php"));
        await symlink("/private/etc/hosts", join(entry.root, "autoload.php"));
      },
    ],
  ])("fails closed and rebuilds after %s tampering", async (_label, mutate) => {
    const value = await fixture();
    const first = await prepare(value);
    await mutate(first);
    expect(await verifyVerificationDependency(first)).toBe(false);

    const rebuilt = await prepare(value, store(value));
    expect(rebuilt).not.toBeNull();
    expect(await verifyVerificationDependency(rebuilt)).toBe(true);
    expect(value.installs).toBe(2);
  });

  it("rejects a same-user forged warm tree with a recomputed unkeyed proof", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const target = dirname(first.root);
    const proofPath = join(target, "proof.json");
    const autoload = join(first.root, "autoload.php");
    await Promise.all([chmod(target, 0o700), chmod(autoload, 0o600)]);
    const content = "<?php return false;\n";
    await writeFile(autoload, content);
    await chmod(autoload, 0o400);
    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    const file = proof.tree.find(({ path }) => path === "autoload.php");
    file.digest = digest(content);
    file.size = Buffer.byteLength(content);
    const payload = {
      inputs: proof.inputs,
      key: proof.key,
      store: proof.store,
      target: proof.target,
      tools: proof.tools,
      tree: proof.tree,
      version: proof.version,
    };
    proof.authentication = digest(JSON.stringify(payload));
    await chmod(proofPath, 0o600);
    await writeFile(proofPath, JSON.stringify(proof));
    await Promise.all([chmod(proofPath, 0o400), chmod(target, 0o500)]);

    expect(await verifyVerificationDependency(first)).toBe(false);
    const rebuilt = await prepare(value, store(value));
    expect(rebuilt).not.toBeNull();
    expect(await verifyVerificationDependency(rebuilt)).toBe(true);
    expect(value.installs).toBe(2);
  });

  it("rejects a copied proof and tree replayed at another dependency key", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const second = await prepare(value, store(value), {
      manifestSource: `${manifest()}\n`,
    });
    const firstTarget = dirname(first.root);
    const secondTarget = dirname(second.root);
    await makeWritable(secondTarget);
    await rm(secondTarget, { recursive: true });
    await cp(firstTarget, secondTarget, { recursive: true });

    expect(await verifyVerificationDependency(second)).toBe(false);
    const rebuilt = await prepare(value, store(value), {
      manifestSource: `${manifest()}\n`,
    });
    expect(rebuilt).not.toBeNull();
    expect(await verifyVerificationDependency(rebuilt)).toBe(true);
    expect(value.installs).toBe(3);
  });

  it("serializes cross-instance writers and publishes one winner", async () => {
    const value = await fixture({ installDelay: 60 });
    const firstStore = store(value);
    const secondStore = store(value);
    const [first, second] = await Promise.all([
      prepare(value, firstStore),
      prepare(value, secondStore),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first.key).toBe(second.key);
    expect(value.installs).toBe(1);
  });

  it("recovers a stale crash lock without deleting a valid winner", async () => {
    const value = await fixture();
    const first = await prepare(value);
    const target = dirname(first.root);
    const processRoot = dirname(target);
    await makeWritable(target);
    await rm(target, { recursive: true });
    const lock = `${target}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ createdAt: 0, nonce: "crashed", pid: 2147483647 }),
      { mode: 0o400 },
    );

    expect(dirname(lock)).toBe(processRoot);
    const rebuilt = await prepare(value, store(value, { staleAfter: 0 }));
    expect(rebuilt).not.toBeNull();
    expect(await verifyVerificationDependency(rebuilt)).toBe(true);
    expect(value.installs).toBe(2);
  });

  it("returns unavailable and leaves no publication after Composer fails", async () => {
    const value = await fixture({ failInstall: true });
    await expect(prepare(value)).resolves.toBeNull();
    const names = await readdir(value.storeRoot);
    expect(names.filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
  });
});
