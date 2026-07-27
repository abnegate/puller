import { createHash } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVerificationConfinement,
  executeVerificationPlan,
  verifyVerificationRuntime,
} from "../verification-confinement.mjs";
import { createVerificationDependencyStore } from "../verification-dependency-store.mjs";
import { createVerificationPlan } from "../verification-plan.mjs";

const roots = [];

async function binding(root, path) {
  const source = await readFile(join(root, path));
  const details = await stat(join(root, path));
  return {
    digest: createHash("sha256").update(source).digest("hex"),
    mode: details.mode & 0o7777,
    path,
    size: details.size,
  };
}

async function runtimeBinding(path = process.execPath) {
  const canonical = await realpath(path);
  const source = await readFile(canonical);
  const details = await stat(canonical);
  return {
    device: details.dev,
    digest: createHash("sha256").update(source).digest("hex"),
    inode: details.ino,
    mode: details.mode & 0o7777,
    path: canonical,
    size: details.size,
  };
}

async function confinedScript(confinement, root, source) {
  const workspace = join(root, "probe-source");
  await mkdir(workspace, { recursive: true });
  const path = "probe.mjs";
  await writeFile(join(workspace, path), source, { mode: 0o600 });
  return confinement.run({
    args: [path],
    bindings: [await binding(workspace, path)],
    directory: ".",
    runtime: await runtimeBinding(),
    sourceRoot: workspace,
  });
}

async function installedPhp() {
  for (const directory of String(process.env.PATH ?? "").split(":")) {
    if (directory === "") continue;
    const path = join(directory, "php");
    try {
      return await realpath(path);
    } catch {
      // Continue through the process PATH.
    }
  }
  return null;
}

async function confinedPhp(confinement, root, source) {
  const workspace = join(root, "php-probe-source");
  await mkdir(workspace, { recursive: true });
  const path = "probe.php";
  await writeFile(join(workspace, path), source, { mode: 0o600 });
  const php = await installedPhp();
  if (php === null) throw new Error("PHP is not installed.");
  return confinement.run({
    args: [
      "-d",
      "allow_url_fopen=0",
      "-d",
      "ffi.enable=false",
      "-d",
      "disable_functions=exec,passthru,pcntl_exec,pcntl_fork,popen,posix_kill,proc_open,shell_exec,system",
      path,
    ],
    bindings: [await binding(workspace, path)],
    directory: ".",
    runtime: await runtimeBinding(php),
    sourceRoot: workspace,
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

async function fixture({ forged = false } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "puller-verification-security-")),
  );
  roots.push(root);
  const paths = {
    predecessorRoot: join(root, "predecessor-execution"),
    predecessorSnapshot: join(root, "predecessor-snapshot"),
    releaseRoot: join(root, "release-execution"),
    releaseSnapshot: join(root, "release-snapshot"),
  };
  await Promise.all(
    Object.values(paths).map(async (path) => {
      await mkdir(join(path, "src"), { recursive: true });
      await mkdir(join(path, "test"), { recursive: true });
    }),
  );
  const trusted =
    'import assert from "node:assert/strict";\nimport { behavior } from "../src/feature.mjs";\nassert.equal(behavior, true);\n';
  const forgedSource = `${trusted}process.stdout.write("forged");\n`;
  for (const path of [paths.predecessorSnapshot, paths.predecessorRoot]) {
    await writeFile(join(path, "test", "behavior.test.mjs"), trusted, {
      mode: 0o600,
    });
    await writeFile(
      join(path, "src", "feature.mjs"),
      "export const behavior = false;\n",
      { mode: 0o600 },
    );
  }
  for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
    await writeFile(
      join(path, "test", "behavior.test.mjs"),
      forged ? forgedSource : trusted,
      { mode: 0o600 },
    );
    await writeFile(
      join(path, "src", "feature.mjs"),
      "export const behavior = true;\n",
      { mode: 0o600 },
    );
  }
  return paths;
}

async function phpFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "puller-php-verification-")),
  );
  roots.push(root);
  const paths = {
    predecessorRoot: join(root, "predecessor-execution"),
    predecessorSnapshot: join(root, "predecessor-snapshot"),
    releaseRoot: join(root, "release-execution"),
    releaseSnapshot: join(root, "release-snapshot"),
  };
  const manifest = {
    autoload: { "psr-4": { "Feature\\": "src" } },
    "autoload-dev": { "psr-4": { "Tests\\": "tests" } },
    scripts: { test: "vendor/bin/phpunit" },
  };
  const phpunit = {
    dist: {
      reference: "a".repeat(40),
      shasum: "",
      type: "zip",
      url: `https://api.github.com/repos/phpunit/phpunit/zipball/${"a".repeat(40)}`,
    },
    name: "phpunit/phpunit",
    source: {
      reference: "a".repeat(40),
      type: "git",
      url: "https://github.com/phpunit/phpunit.git",
    },
    type: "library",
    version: "12.5.31",
  };
  const lock = {
    "content-hash": "b".repeat(32),
    packages: [],
    "packages-dev": [phpunit],
  };
  const test = [
    "<?php",
    "namespace Tests;",
    "use Feature\\Behavior;",
    "use PHPUnit\\Framework\\TestCase;",
    "final class BehaviorTest extends TestCase",
    "{",
    "    public function testBehavior(): void",
    "    {",
    "        $this->assertTrue(Behavior::enabled());",
    "    }",
    "}",
    "",
  ].join("\n");
  for (const path of Object.values(paths)) {
    await Promise.all([
      mkdir(join(path, "src"), { recursive: true }),
      mkdir(join(path, "tests"), { recursive: true }),
    ]);
    await writeFile(
      join(path, "composer.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      join(path, "composer.lock"),
      JSON.stringify(lock, null, 2),
      {
        mode: 0o600,
      },
    );
    await writeFile(
      join(path, "phpunit.xml"),
      '<?xml version="1.0"?><phpunit><testsuites><testsuite name="unit"><directory>tests</directory></testsuite></testsuites></phpunit>',
      { mode: 0o600 },
    );
    await writeFile(join(path, "tests", "BehaviorTest.php"), test, {
      mode: 0o600,
    });
  }
  for (const path of [paths.predecessorRoot, paths.predecessorSnapshot]) {
    await writeFile(
      join(path, "src", "Behavior.php"),
      "<?php\nnamespace Feature;\nfinal class Behavior { public static function enabled(): bool { return false; } }\n",
      { mode: 0o600 },
    );
  }
  for (const path of [paths.releaseRoot, paths.releaseSnapshot]) {
    await writeFile(
      join(path, "src", "Behavior.php"),
      "<?php\nnamespace Feature;\nfinal class Behavior { public static function enabled(): bool { return true; } }\n",
      { mode: 0o600 },
    );
  }

  const dependency = join(root, "dependency");
  await Promise.all([
    mkdir(join(dependency, "vendor", "composer"), { recursive: true }),
    mkdir(join(dependency, "vendor", "phpunit", "phpunit"), {
      recursive: true,
    }),
  ]);
  await writeFile(
    join(dependency, "composer.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(dependency, "composer.lock"),
    JSON.stringify(lock, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(dependency, "vendor", "composer", "installed.json"),
    JSON.stringify({ packages: [phpunit] }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    join(dependency, "vendor", "autoload.php"),
    [
      "<?php",
      "namespace PHPUnit\\Framework {",
      "    class TestCase {",
      "        public function assertTrue(bool $value): void { if (!$value) { throw new \\RuntimeException('assertion failed'); } }",
      "    }",
      "}",
      "namespace {",
      "    final class PullerTestLoader {",
      "        private array $mappings = [];",
      "        public function __construct() { spl_autoload_register([$this, 'load']); }",
      "        public function addPsr4(string $prefix, array $paths, bool $prepend = false): void { $this->mappings[$prefix] = $paths; }",
      "        public function add(string $prefix, array $paths, bool $prepend = false): void { $this->addPsr4($prefix, $paths, $prepend); }",
      "        public function load(string $class): void {",
      "            foreach ($this->mappings as $prefix => $paths) {",
      "                if (!str_starts_with($class, $prefix)) { continue; }",
      "                $suffix = str_replace('\\\\', '/', substr($class, strlen($prefix))) . '.php';",
      "                foreach ($paths as $path) { $file = $path . '/' . $suffix; if (is_file($file)) { require $file; return; } }",
      "            }",
      "        }",
      "    }",
      "    return new PullerTestLoader();",
      "}",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    join(dependency, "vendor", "phpunit", "phpunit", "phpunit"),
    [
      "<?php",
      "$source = $argv[array_key_last($argv)];",
      "require $source;",
      "$test = new \\Tests\\BehaviorTest();",
      "$test->testBehavior();",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const php = await installedPhp();
  if (php === null) throw new Error("PHP is not installed.");
  const tools = join(root, "tools");
  await mkdir(tools, { mode: 0o700 });
  const composer = join(tools, "composer");
  await writeFile(composer, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const environment = {
    PATH: `${tools}:${dirname(php)}`,
  };
  const dependencyStore = createVerificationDependencyStore({
    interval: 5,
    root: join(root, "store"),
    run: async (_command, args, options) => {
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
      if (!args.includes("install"))
        throw new Error("Unexpected Composer call.");
      const vendor = join(options.cwd, "vendor");
      await Promise.all([
        mkdir(join(vendor, "composer"), { recursive: true }),
        mkdir(join(vendor, "phpunit", "phpunit"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(vendor, "composer", "installed.json"),
          await readFile(
            join(dependency, "vendor", "composer", "installed.json"),
          ),
        ),
        writeFile(
          join(vendor, "autoload.php"),
          await readFile(join(dependency, "vendor", "autoload.php")),
        ),
        writeFile(
          join(vendor, "phpunit", "phpunit", "phpunit"),
          await readFile(
            join(dependency, "vendor", "phpunit", "phpunit", "phpunit"),
          ),
        ),
      ]);
      return { stderr: "", stdout: "" };
    },
  });
  const entry = await dependencyStore.prepare({
    environment,
    lockSource: JSON.stringify(lock, null, 2),
    manifestSource: JSON.stringify(manifest, null, 2),
  });
  if (entry === null)
    throw new Error("Dependency fixture did not materialize.");
  return { dependency, dependencyStore, entry, environment, paths };
}

function claims() {
  return {
    complete: true,
    files: new Map([
      [
        "src/feature.mjs",
        {
          patch:
            "@@ -1 +1 @@\n-export const behavior = false;\n+export const behavior = true;",
        },
      ],
    ]),
  };
}

function targetFiles(path = "src/feature.mjs") {
  return [{ path, status: "modified" }];
}

function verificationPlan(value) {
  return createVerificationPlan({
    targetFiles: targetFiles(),
    ...value,
  });
}

const recipe = Object.freeze({
  kind: "tool",
  name: "node",
  sourcePath: "test/behavior.test.mjs",
});

describe("trusted verification harness planning", () => {
  it("discovers predecessor-owned harnesses deterministically without trusting model recipes", async () => {
    const paths = await fixture();
    const source = [
      'import assert from "node:assert/strict";',
      'import { behavior } from "../src/feature.mjs";',
      "assert.equal(behavior, true);",
      "",
    ].join("\n");
    for (const path of Object.values(paths)) {
      await writeFile(join(path, "test", "z.test.mjs"), source, {
        mode: 0o600,
      });
      await writeFile(join(path, "test", "a.test.mjs"), source, {
        mode: 0o600,
      });
    }

    const plan = await verificationPlan({
      discover: true,
      recipes: [
        {
          kind: "tool",
          name: "node",
          sourcePath: "test/a.test.mjs",
        },
      ],
      roots: paths,
    });

    expect(plan.outcome).toBe("ready");
    expect(plan.plans.map(({ recipe: value }) => value)).toEqual([
      { kind: "tool", name: "node", sourcePath: "test/a.test.mjs" },
      { kind: "tool", name: "node", sourcePath: "test/behavior.test.mjs" },
      { kind: "tool", name: "node", sourcePath: "test/z.test.mjs" },
    ]);
  });

  it("does not discover a target-only harness", async () => {
    const paths = await fixture();
    await Promise.all(
      Object.values(paths).map((path) =>
        rm(join(path, "test", "behavior.test.mjs")),
      ),
    );
    const source =
      'import assert from "node:assert/strict";\nimport { behavior } from "../src/feature.mjs";\nassert.equal(behavior, true);\n';
    for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
      await writeFile(join(path, "test", "target.test.mjs"), source, {
        mode: 0o600,
      });
    }

    await expect(
      verificationPlan({ discover: true, recipes: [], roots: paths }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("does not discover a harness changed by the target", async () => {
    const paths = await fixture({ forged: true });
    await expect(
      verificationPlan({ discover: true, recipes: [], roots: paths }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("does not discover an unsafe unchanged harness", async () => {
    const paths = await fixture();
    const source =
      'import { readFileSync } from "node:fs";\nreadFileSync("/etc/hosts");\n';
    await Promise.all(
      Object.values(paths).map((path) =>
        writeFile(join(path, "test", "behavior.test.mjs"), source, {
          mode: 0o600,
        }),
      ),
    );

    await expect(
      verificationPlan({ discover: true, recipes: [], roots: paths }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("does not discover a harness with an unsafe control-character filename", async () => {
    const paths = await fixture();
    await Promise.all(
      Object.values(paths).map(async (path) => {
        await rm(join(path, "test", "behavior.test.mjs"));
        await writeFile(
          join(path, "test", "\nbehavior.test.mjs"),
          'import assert from "node:assert/strict";\nimport { behavior } from "../src/feature.mjs";\nassert.equal(behavior, true);\n',
          { mode: 0o600 },
        );
      }),
    );

    await expect(
      verificationPlan({ discover: true, recipes: [], roots: paths }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("does not discover a harness whose changed product is outside the target delta", async () => {
    const paths = await fixture();
    const source =
      'import assert from "node:assert/strict";\nimport { behavior } from "../src/other.mjs";\nassert.equal(behavior, true);\n';
    await Promise.all(
      Object.values(paths).map((path) =>
        writeFile(join(path, "test", "behavior.test.mjs"), source, {
          mode: 0o600,
        }),
      ),
    );
    for (const path of [paths.predecessorSnapshot, paths.predecessorRoot]) {
      await writeFile(
        join(path, "src", "other.mjs"),
        "export const behavior = false;\n",
        { mode: 0o600 },
      );
    }
    for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
      await writeFile(
        join(path, "src", "other.mjs"),
        "export const behavior = true;\n",
        { mode: 0o600 },
      );
    }

    await expect(
      verificationPlan({ discover: true, recipes: [], roots: paths }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("rejects a harness forged in the current release", async () => {
    const paths = await fixture({ forged: true });
    await expect(
      verificationPlan({
        claims: claims(),
        recipes: [recipe],
        roots: paths,
      }),
    ).resolves.toEqual({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it.each(["hardlink", "symlink"])(
    "rejects a %s harness escape",
    async (kind) => {
      const paths = await fixture();
      const outside = join(dirname(paths.releaseRoot), `${kind}-outside.mjs`);
      await writeFile(outside, "process.exit(0);\n", { mode: 0o600 });
      const target = join(paths.releaseSnapshot, "test", "behavior.test.mjs");
      await rm(target);
      if (kind === "hardlink") await link(outside, target);
      else await symlink(outside, target);
      await expect(
        verificationPlan({
          claims: claims(),
          recipes: [recipe],
          roots: paths,
        }),
      ).resolves.toMatchObject({
        outcome: "unavailable",
        reason: "harness_untrusted",
      });
    },
  );

  it("rejects changed lifecycle configuration around an otherwise unchanged script", async () => {
    const paths = await fixture();
    for (const path of [
      paths.predecessorRoot,
      paths.predecessorSnapshot,
      paths.releaseRoot,
    ]) {
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ scripts: { verify: "node test/behavior.test.mjs" } }),
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(paths.releaseSnapshot, "package.json"),
      JSON.stringify({
        scripts: {
          preverify: "node test/setup.mjs",
          verify: "node test/behavior.test.mjs",
        },
      }),
      { mode: 0o600 },
    );
    await expect(
      verificationPlan({
        claims: claims(),
        recipes: [
          { kind: "script", manifestPath: "package.json", name: "verify" },
        ],
        roots: paths,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it.each([
    [
      "filesystem enumeration",
      'import { readdirSync } from "node:fs";\nreaddirSync(".");\n',
    ],
    [
      "createRequire",
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url);\n',
    ],
    [
      "child processes",
      'import { execFileSync } from "node:child_process";\nexecFileSync("/bin/true");\n',
    ],
    [
      "dynamic imports",
      'const value = await import("../src/feature.mjs");\nvoid value;\n',
    ],
    ["Unicode-escaped dangerous identifiers", "const pro\\u0063ess = true;\n"],
    ["computed dependency names", 'const dependency = "f" + "s";\n'],
  ])("rejects harness access to %s", async (_name, source) => {
    const paths = await fixture();
    const malicious = `${source}import { behavior } from "../src/feature.mjs";\nvoid behavior;\n`;
    await Promise.all(
      Object.values(paths).map((path) =>
        writeFile(join(path, "test", "behavior.test.mjs"), malicious, {
          mode: 0o600,
        }),
      ),
    );
    await expect(
      verificationPlan({
        claims: claims(),
        recipes: [recipe],
        roots: paths,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("discovers a differently named unchanged predecessor-owned PHP test when the target regression test is modified", async () => {
    const { dependencyStore, environment, paths } = await phpFixture();
    const independent = [
      "<?php",
      "namespace Tests;",
      "use Feature\\Behavior;",
      "use PHPUnit\\Framework\\TestCase;",
      "final class FeatureRegressionTest extends TestCase",
      "{",
      "    public function testReleasedBehavior(): void",
      "    {",
      "        $this->assertTrue(Behavior::enabled());",
      "    }",
      "}",
      "",
    ].join("\n");
    for (const root of Object.values(paths)) {
      await writeFile(
        join(root, "tests", "FeatureRegressionTest.php"),
        independent,
      );
    }
    for (const root of [paths.releaseRoot, paths.releaseSnapshot]) {
      await writeFile(
        join(root, "tests", "BehaviorTest.php"),
        "<?php use PHPUnit\\Framework\\TestCase; final class BehaviorTest extends TestCase {}\n",
      );
    }

    const plan = await createVerificationPlan({
      dependencyStore,
      discover: true,
      environment,
      recipes: [],
      repository: "owner/repo",
      roots: paths,
      targetFiles: [
        ...targetFiles("src/Behavior.php"),
        { path: "tests/BehaviorTest.php", status: "modified" },
      ],
    });

    expect(plan.outcome).toBe("ready");
    expect(plan.plans.map(({ recipe: value }) => value)).toContainEqual({
      kind: "tool",
      name: "phpunit",
      sourcePath: "tests/FeatureRegressionTest.php",
    });
    expect(plan.plans.map(({ recipe: value }) => value)).not.toContainEqual({
      kind: "tool",
      name: "phpunit",
      sourcePath: "tests/BehaviorTest.php",
    });
  });

  it("rejects a PHP autoloader harness", async () => {
    const paths = await fixture();
    const harness = [
      "<?php",
      "$function = 'system';",
      '$function("true");',
      'require "../src/feature.php";',
      "",
    ].join("\n");
    for (const path of Object.values(paths)) {
      await writeFile(join(path, "test", "behavior.php"), harness, {
        mode: 0o600,
      });
    }
    for (const path of [paths.predecessorSnapshot, paths.predecessorRoot]) {
      await writeFile(
        join(path, "src", "feature.php"),
        "<?php return false;\n",
        {
          mode: 0o600,
        },
      );
    }
    for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
      await writeFile(
        join(path, "src", "feature.php"),
        "<?php return true;\n",
        {
          mode: 0o600,
        },
      );
    }
    await expect(
      verificationPlan({
        claims: {
          complete: true,
          files: new Map([
            [
              "src/feature.php",
              {
                patch: "@@ -1 +1 @@\n-<?php return false;\n+<?php return true;",
              },
            ],
          ]),
        },
        recipes: [
          {
            kind: "tool",
            name: "php",
            sourcePath: "test/behavior.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/feature.php"),
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("plans an unchanged predecessor-owned PHPUnit test with exact-lock dependencies and server-owned argv", async () => {
    const { dependencyStore, entry, environment, paths } = await phpFixture();
    const phpRecipe = {
      kind: "tool",
      name: "phpunit",
      sourcePath: "tests/BehaviorTest.php",
    };
    const plan = await createVerificationPlan({
      dependencyStore,
      discover: true,
      environment,
      recipes: [phpRecipe],
      roots: paths,
      targetFiles: targetFiles("src/Behavior.php"),
    });

    expect(plan.outcome).toBe("ready");
    const selected = plan.plans.find(
      ({ recipe: value }) =>
        JSON.stringify(value) === JSON.stringify(phpRecipe),
    );
    expect(selected).toBeDefined();
    expect(selected.runtime.path).toContain("/php");
    expect(selected.tools.phpunit.path).toBe(
      join(entry.root, "phpunit/phpunit/phpunit"),
    );
    expect(selected.args).toContain("--do-not-cache-result");
    expect(selected.args).toContain("--no-coverage");
    expect(selected.args).toContain("tests/BehaviorTest.php");
    expect(selected.args.join(" ")).not.toContain("composer install");
    expect(selected.args.join(" ")).not.toContain("composer update");
    expect(selected.bindings.predecessor).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "predecessor",
          path: "tests/BehaviorTest.php",
        }),
      ]),
    );
    expect(selected.bindings.release).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "predecessor",
          path: "tests/BehaviorTest.php",
        }),
      ]),
    );
  });

  it.each([
    ["target-added", "added"],
    ["target-modified", "modified"],
  ])("never uses a %s PHP test as proof", async (_label, status) => {
    const { dependency, paths } = await phpFixture();
    const source = join(paths.predecessorSnapshot, "tests", "BehaviorTest.php");
    if (status === "added") {
      await Promise.all([
        rm(source),
        rm(join(paths.predecessorRoot, "tests", "BehaviorTest.php")),
      ]);
    } else {
      await Promise.all([
        writeFile(
          join(paths.releaseSnapshot, "tests", "BehaviorTest.php"),
          "<?php use PHPUnit\\Framework\\TestCase; final class BehaviorTest extends TestCase {}\n",
        ),
        writeFile(
          join(paths.releaseRoot, "tests", "BehaviorTest.php"),
          "<?php use PHPUnit\\Framework\\TestCase; final class BehaviorTest extends TestCase {}\n",
        ),
      ]);
    }
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: [
          ...targetFiles("src/Behavior.php"),
          { path: "tests/BehaviorTest.php", status },
        ],
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it.each([
    ["composer script", "composer.json"],
    ["PHPUnit configuration", "phpunit.xml"],
  ])("rejects modified %s", async (_label, path) => {
    const { dependency, paths } = await phpFixture();
    await Promise.all([
      writeFile(join(paths.releaseSnapshot, path), `${Date.now()}`),
      writeFile(join(paths.releaseRoot, path), `${Date.now()}`),
    ]);
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: [
          ...targetFiles("src/Behavior.php"),
          { path, status: "modified" },
        ],
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("rejects a modified PHPUnit bootstrap", async () => {
    const { dependency, paths } = await phpFixture();
    for (const root of Object.values(paths)) {
      await writeFile(
        join(root, "phpunit.xml"),
        '<?xml version="1.0"?><phpunit bootstrap="tests/bootstrap.php"><testsuites><testsuite name="unit"><directory>tests</directory></testsuite></testsuites></phpunit>',
      );
      await writeFile(join(root, "tests", "bootstrap.php"), "<?php\n");
    }
    await Promise.all([
      writeFile(
        join(paths.releaseSnapshot, "tests", "bootstrap.php"),
        "<?php putenv('FORGED=1');\n",
      ),
      writeFile(
        join(paths.releaseRoot, "tests", "bootstrap.php"),
        "<?php putenv('FORGED=1');\n",
      ),
    ]);
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: [
          ...targetFiles("src/Behavior.php"),
          { path: "tests/bootstrap.php", status: "modified" },
        ],
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it.each([
    ["autoload parent escape", { "Feature\\": "../outside" }],
    ["autoload absolute escape", { "Feature\\": "/private/tmp/outside" }],
  ])("rejects %s", async (_label, mapping) => {
    const { dependency, paths } = await phpFixture();
    const manifest = {
      autoload: { "psr-4": mapping },
      scripts: { test: "vendor/bin/phpunit" },
    };
    for (const root of [...Object.values(paths), dependency]) {
      await writeFile(
        join(root, "composer.json"),
        JSON.stringify(manifest, null, 2),
      );
    }
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("rejects a dependency-tree symlink", async () => {
    const { dependency, paths } = await phpFixture();
    await symlink(
      "/private/etc/hosts",
      join(dependency, "vendor", "composer", "escape.php"),
    );
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it.each([
    [
      "arbitrary binary",
      {
        kind: "tool",
        name: "bash",
        sourcePath: "tests/BehaviorTest.php",
      },
    ],
    [
      "argument injection",
      {
        kind: "tool",
        name: "phpunit",
        sourcePath: "tests/BehaviorTest.php --filter forged",
      },
    ],
    [
      "script-name injection",
      {
        kind: "script",
        manifestPath: "composer.json",
        name: "test;whoami",
      },
    ],
  ])("rejects a PHP %s recipe", async (_label, recipe) => {
    const { dependency, paths } = await phpFixture();
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [recipe],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("rejects unchanged Composer scripts with caller-controlled PHPUnit arguments", async () => {
    const { dependency, paths } = await phpFixture();
    for (const root of [...Object.values(paths), dependency]) {
      const manifest = JSON.parse(
        await readFile(join(root, "composer.json"), "utf8"),
      );
      manifest.scripts.test =
        "vendor/bin/phpunit --filter forged tests/BehaviorTest.php";
      await writeFile(
        join(root, "composer.json"),
        JSON.stringify(manifest, null, 2),
      );
    }
    await expect(
      createVerificationPlan({
        repository: "owner/repo",
        recipes: [
          { kind: "script", manifestPath: "composer.json", name: "test" },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("rejects an undeclared changed transitive helper", async () => {
    const paths = await fixture();
    for (const path of [paths.predecessorSnapshot, paths.predecessorRoot]) {
      await writeFile(
        join(path, "src", "feature.mjs"),
        'import { helper } from "./helper.mjs";\nexport const behavior = helper;\n',
        { mode: 0o600 },
      );
      await writeFile(
        join(path, "src", "helper.mjs"),
        "export const helper = false;\n",
        { mode: 0o600 },
      );
    }
    for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
      await writeFile(
        join(path, "src", "feature.mjs"),
        'import { helper } from "./helper.mjs";\nexport const behavior = helper;\n',
        { mode: 0o600 },
      );
      await writeFile(
        join(path, "src", "helper.mjs"),
        "export const helper = true;\n",
        { mode: 0o600 },
      );
    }
    await expect(
      verificationPlan({
        claims: claims(),
        recipes: [recipe],
        roots: paths,
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  });

  it("runs an unchanged harness predecessor-first with server-owned identical argv", async () => {
    const paths = await fixture();
    const plan = await verificationPlan({
      claims: claims(),
      recipes: [recipe],
      roots: paths,
    });
    expect(plan.outcome).toBe("ready");
    const calls = [];
    const confinement = {
      run: async (input) => {
        calls.push(input);
        return input.sourceRoot === paths.predecessorRoot
          ? { code: 1, output: "assertion failed", unavailable: false }
          : { code: 0, output: "", unavailable: false };
      },
    };
    await expect(
      executeVerificationPlan({
        confinement,
        plan,
        roots: paths,
      }),
    ).resolves.toMatchObject({
      outcome: "verified",
      reason: "behavior_passed",
      recipes: [recipe],
    });
    expect(calls.map((call) => call.sourceRoot)).toEqual([
      paths.predecessorRoot,
      paths.releaseRoot,
    ]);
    expect(calls[0].runtime).toBe(calls[1].runtime);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0]).toMatchObject({
      bindings: plan.plans[0].bindings.predecessor,
      directory: ".",
    });
    expect(calls[1]).toMatchObject({
      bindings: plan.plans[0].bindings.release,
      directory: ".",
    });
  });

  it("does not credit behavior introduced later in the aggregate release on the same target file", async () => {
    const paths = await fixture();
    for (const path of [paths.predecessorSnapshot, paths.predecessorRoot]) {
      await writeFile(
        join(path, "src", "feature.mjs"),
        'export const behavior = false;\nexport const note = "before";\n',
        { mode: 0o600 },
      );
    }
    for (const path of [paths.releaseSnapshot, paths.releaseRoot]) {
      await writeFile(
        join(path, "src", "feature.mjs"),
        'export const behavior = false;\nexport const note = "target";\n',
        { mode: 0o600 },
      );
    }
    const aggregate = join(dirname(paths.releaseRoot), "aggregate-release");
    await mkdir(join(aggregate, "src"), { recursive: true });
    await writeFile(
      join(aggregate, "src", "feature.mjs"),
      'export const behavior = true;\nexport const note = "target";\n',
      { mode: 0o600 },
    );
    const plan = await verificationPlan({
      claims: {
        complete: true,
        files: new Map([
          [
            "src/feature.mjs",
            {
              patch:
                '@@ -2 +2 @@\n-export const note = "before";\n+export const note = "target";',
            },
          ],
        ]),
      },
      recipes: [recipe],
      roots: paths,
    });
    expect(plan.outcome).toBe("ready");
    const confinement = {
      run: async ({ sourceRoot }) => ({
        code: (
          await readFile(join(sourceRoot, "src", "feature.mjs"), "utf8")
        ).includes("behavior = true")
          ? 0
          : 1,
        output: "",
        unavailable: false,
      }),
    };
    await expect(
      executeVerificationPlan({ confinement, plan, roots: paths }),
    ).resolves.toMatchObject({
      outcome: "not_verified",
      reason: "behavior_not_distinguished",
    });
    expect(
      await readFile(join(aggregate, "src", "feature.mjs"), "utf8"),
    ).toContain("behavior = true");
  });

  it("rejects a runtime executable mutation between phases", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-runtime-security-"));
    roots.push(root);
    const path = join(root, "runtime");
    await writeFile(path, "first", { mode: 0o700 });
    const runtime = await runtimeBinding(path);
    let phase = 0;
    const confinement = {
      run: async ({ runtime: current }) => {
        if (!(await verifyVerificationRuntime(current))) {
          return {
            code: null,
            output: "",
            reason: "execution_changed",
            unavailable: true,
          };
        }
        phase += 1;
        if (phase === 1) {
          await writeFile(path, "second", { mode: 0o700 });
          return { code: 1, output: "failed", unavailable: false };
        }
        return { code: 0, output: "", unavailable: false };
      },
    };
    await expect(
      executeVerificationPlan({
        confinement,
        plan: {
          outcome: "ready",
          plans: [
            {
              args: ["test/behavior.test.mjs"],
              bindings: { predecessor: [], release: [] },
              directory: ".",
              recipe,
              runtime,
            },
          ],
        },
        roots: {
          predecessorRoot: root,
          releaseRoot: root,
        },
      }),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "execution_changed",
    });
  });
});

describe.runIf(platform() === "darwin")(
  "macOS verification confinement",
  () => {
    it("executes an exact-lock predecessor-owned PHPUnit behavior test fail-before and pass-after", async () => {
      const { dependencyStore, environment, paths } = await phpFixture();
      const plan = await createVerificationPlan({
        dependencyStore,
        environment,
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      });
      expect(plan.outcome).toBe("ready");
      const confinement = await createVerificationConfinement().prepare({
        root: dirname(paths.releaseRoot),
      });
      expect(confinement).not.toBeNull();
      try {
        await expect(
          executeVerificationPlan({ confinement, plan, roots: paths }),
        ).resolves.toMatchObject({
          outcome: "verified",
          reason: "behavior_passed",
        });
      } finally {
        await confinement.cleanup();
      }
    });

    it("rejects an exact-lock dependency mutation between predecessor and candidate phases", async () => {
      const { dependencyStore, entry, environment, paths } = await phpFixture();
      const plan = await createVerificationPlan({
        dependencyStore,
        environment,
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      });
      expect(plan.outcome).toBe("ready");
      const actual = await createVerificationConfinement().prepare({
        root: dirname(paths.releaseRoot),
      });
      expect(actual).not.toBeNull();
      const confinement = {
        run: async (input) => {
          const result = await actual.run(input);
          if (input.sourceRoot === paths.predecessorRoot) {
            await chmod(join(entry.root, "autoload.php"), 0o600);
            await writeFile(
              join(entry.root, "autoload.php"),
              "<?php return null;\n",
            );
          }
          return result;
        },
      };
      try {
        await expect(
          executeVerificationPlan({ confinement, plan, roots: paths }),
        ).resolves.toMatchObject({
          outcome: "unavailable",
          reason: "execution_changed",
        });
      } finally {
        await actual.cleanup();
      }
    });

    it("rejects dependency bytes that change after planning", async () => {
      const { dependencyStore, entry, environment, paths } = await phpFixture();
      const plan = await createVerificationPlan({
        dependencyStore,
        environment,
        recipes: [
          {
            kind: "tool",
            name: "phpunit",
            sourcePath: "tests/BehaviorTest.php",
          },
        ],
        roots: paths,
        targetFiles: targetFiles("src/Behavior.php"),
      });
      expect(plan.outcome).toBe("ready");
      await chmod(join(entry.root, "autoload.php"), 0o600);
      await writeFile(join(entry.root, "autoload.php"), "<?php return null;\n");
      const confinement = await createVerificationConfinement().prepare({
        root: dirname(paths.releaseRoot),
      });
      expect(confinement).not.toBeNull();
      try {
        await expect(
          executeVerificationPlan({ confinement, plan, roots: paths }),
        ).resolves.toMatchObject({
          outcome: "unavailable",
          reason: "execution_changed",
        });
      } finally {
        await confinement.cleanup();
      }
    });

    it("does not classify successful PHP test diagnostics as unavailable", async () => {
      const root = await mkdtemp(join(tmpdir(), "puller-php-diagnostic-"));
      roots.push(root);
      const confinement = await createVerificationConfinement().prepare({
        root,
      });
      expect(confinement).not.toBeNull();
      try {
        await expect(
          confinedPhp(
            confinement,
            root,
            '<?php echo "expected adapter unavailable";',
          ),
        ).resolves.toMatchObject({
          code: 0,
          unavailable: false,
        });
      } finally {
        await confinement.cleanup();
      }
    });

    it.each([
      [
        "environment",
        '<?php $value = getenv("SSH_AUTH_SOCK"); if ($value !== false) { echo $value; exit(0); } exit(3);',
      ],
      [
        "outside write",
        `<?php $written = @file_put_contents(${JSON.stringify(join(tmpdir(), "puller-php-escape"))}, "ESCAPED"); exit($written === false ? 3 : 0);`,
      ],
      ["arbitrary binary", '<?php system("/usr/bin/true"); echo "EXECUTED";'],
    ])("denies PHP %s escapes", async (_label, source) => {
      const root = await mkdtemp(join(tmpdir(), "puller-php-confinement-"));
      roots.push(root);
      if (_label === "outside write") {
        roots.push(join(tmpdir(), "puller-php-escape"));
      }
      const confinement = await createVerificationConfinement().prepare({
        root,
      });
      expect(confinement).not.toBeNull();
      try {
        const result = await confinedPhp(confinement, root, source);
        expect(result.code).not.toBe(0);
        expect(result.output).not.toMatch(/CONNECTED|EXECUTED|SSH_AUTH_SOCK/);
      } finally {
        await confinement.cleanup();
      }
    });

    it("denies PHP network access to a live local listener", async () => {
      const root = await mkdtemp(join(tmpdir(), "puller-php-network-"));
      roots.push(root);
      let connected = false;
      const server = createServer((socket) => {
        connected = true;
        socket.destroy();
      });
      await new Promise((resolveListen) =>
        server.listen(0, "127.0.0.1", resolveListen),
      );
      const address = server.address();
      const confinement = await createVerificationConfinement().prepare({
        root,
      });
      expect(confinement).not.toBeNull();
      try {
        const result = await confinedPhp(
          confinement,
          root,
          `<?php $socket = @fsockopen("127.0.0.1", ${address.port}, $error, $message, 1); if ($socket !== false) { echo "CONNECTED"; exit(0); } exit(3);`,
        );
        expect(result.code).not.toBe(0);
        expect(result.output).not.toContain("CONNECTED");
        expect(connected).toBe(false);
      } finally {
        await confinement.cleanup();
        await new Promise((resolveClose) => server.close(resolveClose));
      }
    });

    it("denies cross-process signals from Node and PHP while the host process survives", async () => {
      const root = await mkdtemp(join(tmpdir(), "puller-signal-confinement-"));
      roots.push(root);
      const confinement = await createVerificationConfinement().prepare({
        root,
      });
      expect(confinement).not.toBeNull();
      const outside = spawnProcess("/bin/sleep", ["30"], {
        stdio: "ignore",
      });
      try {
        const node = await confinedScript(
          confinement,
          root,
          `process.kill(${outside.pid}, "SIGKILL");\nprocess.stdout.write("SIGNALED");\n`,
        );
        expect(node.code).not.toBe(0);
        expect(node.output).not.toContain("SIGNALED");
        expect(outside.exitCode).toBeNull();

        const php = await confinedPhp(
          confinement,
          root,
          `<?php posix_kill(${outside.pid}, 9); echo "SIGNALED";`,
        );
        expect(php.code).not.toBe(0);
        expect(php.output).not.toContain("SIGNALED");
        expect(outside.exitCode).toBeNull();
      } finally {
        outside.kill("SIGKILL");
        await new Promise((resolveClose) =>
          outside.once("close", resolveClose),
        );
        await confinement.cleanup();
      }
    });

    it("can execute inside the allowed root but cannot read or emit a secret outside it", async () => {
      const root = await mkdtemp(join(tmpdir(), "puller-confinement-test-"));
      const secret = join(tmpdir(), `puller-confinement-secret-${Date.now()}`);
      roots.push(root, secret);
      await writeFile(secret, "DO_NOT_EMIT_THIS_VALUE", { mode: 0o600 });
      await chmod(root, 0o700);
      const confinement = await createVerificationConfinement().prepare({
        root,
      });
      expect(confinement).not.toBeNull();
      const positive = await confinedScript(
        confinement,
        root,
        'process.stdout.write("allowed");\n',
      );
      expect(positive).toMatchObject({
        code: 0,
        output: "allowed",
        unavailable: false,
      });
      const negative = await confinedScript(
        confinement,
        root,
        `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(secret)}, "utf8"));\n`,
      );
      expect(negative.code).not.toBe(0);
      expect(negative.output).not.toContain("DO_NOT_EMIT_THIS_VALUE");
      const hostConfiguration = await confinedScript(
        confinement,
        root,
        'import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync("/private/etc/hosts", "utf8"));\n',
      );
      expect(hostConfiguration.code).not.toBe(0);
      expect(hostConfiguration.output).not.toContain("localhost");
      let connected = false;
      const server = createServer((socket) => {
        connected = true;
        socket.destroy();
      });
      await new Promise((resolveListen) =>
        server.listen(0, "127.0.0.1", resolveListen),
      );
      const address = server.address();
      const network = await confinedScript(
        confinement,
        root,
        `import { connect } from "node:net";\nconnect(${address.port}, "127.0.0.1").once("connect", () => process.stdout.write("CONNECTED")).once("error", () => process.exit(2));\n`,
      );
      await new Promise((resolveClose) => server.close(resolveClose));
      expect(network.code).not.toBe(0);
      expect(network.output).not.toContain("CONNECTED");
      expect(connected).toBe(false);
      await confinement.cleanup();
    });

    it("rejects a release execution mutation after the predecessor phase", async () => {
      const paths = await fixture();
      const root = dirname(paths.releaseRoot);
      const plan = await verificationPlan({
        claims: claims(),
        recipes: [recipe],
        roots: paths,
      });
      expect(plan.outcome).toBe("ready");
      const actual = await createVerificationConfinement().prepare({ root });
      expect(actual).not.toBeNull();
      const confinement = {
        run: async (input) => {
          const result = await actual.run(input);
          if (input.sourceRoot === paths.predecessorRoot) {
            await writeFile(
              join(paths.releaseRoot, "test", "behavior.test.mjs"),
              'process.stdout.write("forged");\n',
              { mode: 0o600 },
            );
          }
          return result;
        },
      };
      try {
        await expect(
          executeVerificationPlan({
            confinement,
            plan,
            roots: paths,
          }),
        ).resolves.toMatchObject({
          outcome: "unavailable",
          reason: "execution_changed",
        });
      } finally {
        await actual.cleanup();
      }
    });
  },
);
