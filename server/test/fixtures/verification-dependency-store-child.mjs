import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createVerificationDependencyStore } from "../../verification-dependency-store.mjs";

const [root, tools, manifestValue, lockValue, replaySource] =
  process.argv.slice(2);
const manifestSource = Buffer.from(manifestValue, "base64").toString("utf8");
const lockSource = Buffer.from(lockValue, "base64").toString("utf8");
let installs = 0;
let replay;

async function replayStore(options) {
  if (!replaySource) return;
  replay ??= cp(
    replaySource,
    join(dirname(options.cwd), basename(replaySource)),
    { recursive: true },
  );
  await replay;
}

const run = async (_command, args, options) => {
  await replayStore(options);
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

const dependencyStore = createVerificationDependencyStore({ root, run });
const entry = await dependencyStore.prepare({
  environment: { PATH: tools },
  lockSource,
  manifestSource,
});

process.stdout.write(
  JSON.stringify({
    installs,
    root: entry?.root ?? null,
  }),
);
