import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVerificationMemory,
  createVerificationMemoryCapture,
  escapeVerificationMemory,
  parseVerificationMemoryMarker,
} from "../verification-memory.mjs";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const roots = [];
const SECRET_GREP_PROBES = [
  "glpat-a1B2c3D4e5F6g7H8i9J0",
  "sk_live_a1B2c3D4e5F6g7H8i9J0k1L2",
  "AIzaSyABCDEFGHIJKLMNOPQRSTUV",
  "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
  "aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0x+/",
];
const BENIGN_GREP_TERMS = [
  "glpath-parser",
  "sk_lively_identifier",
  "AIzaClientFactory",
];
const LOCK_PATH = ".verification-memory.lock";

async function temporary(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function fixture() {
  const base = await temporary("puller-memory-test-");
  const root = join(base, "memory");
  const snapshot = join(base, "snapshot");
  await mkdir(join(snapshot, "src"), { recursive: true });
  await mkdir(join(snapshot, "test"), { recursive: true });
  await writeFile(
    join(snapshot, "src", "feature.js"),
    "export const feature = true\n",
  );
  await writeFile(
    join(snapshot, "test", "feature.test.js"),
    'test("feature")\n',
  );
  await writeFile(
    join(snapshot, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
  );
  return { base, root, snapshot };
}

function provenance(overrides = {}) {
  return {
    headSha: SHA,
    pullNumber: 7,
    releaseId: "10",
    repository: "Owner/Repo",
    tag: "v1.2.4",
    ...overrides,
  };
}

function recipes() {
  return [
    { kind: "file", path: "src/feature.js", role: "implementation" },
    { kind: "grep", path: "test/feature.test.js", terms: ["feature"] },
    { kind: "script", manifestPath: "package.json", name: "test" },
    { kind: "tool", name: "vitest", sourcePath: "package.json" },
  ];
}

function marker(payload) {
  return `<puller-verification-memory>${JSON.stringify(payload)}</puller-verification-memory>`;
}

function filename(repository) {
  return `${createHash("sha256").update(repository.toLowerCase()).digest("hex")}.json`;
}

function lockMetadata({
  acquiredAt,
  nonce = "00000000-0000-4000-8000-000000000001",
  pid = 41_001,
} = {}) {
  return JSON.stringify({ acquiredAt, nonce, pid, version: 1 });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("verification-memory marker", () => {
  it("accepts one strict final marker with only typed recipes and either outcome", () => {
    expect(
      parseVerificationMemoryMarker(
        `Evidence.\n${marker({ outcome: "verified", recipes: recipes(), version: 1 })}`,
      ),
    ).toEqual({ outcome: "verified", recipes: recipes(), version: 1 });
    expect(
      parseVerificationMemoryMarker(
        marker({ outcome: "not_verified", recipes: [], version: 1 }),
      ),
    ).toEqual({ outcome: "not_verified", recipes: [], version: 1 });
  });

  it.each([
    "",
    `${marker({ outcome: "verified", recipes: [], version: 1 })}${marker({ outcome: "verified", recipes: [], version: 1 })}`,
    "<puller-verification-memory>{bad}</puller-verification-memory>",
    marker({ extra: true, outcome: "verified", recipes: [], version: 1 }),
    marker({ outcome: "maybe", recipes: [], version: 1 }),
    marker({
      outcome: "verified",
      recipes: [{ command: "npm test", kind: "script" }],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [{ kind: "file", path: "../secret", role: "test" }],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [{ kind: "file", path: "/tmp/secret", role: "test" }],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        { kind: "script", manifestPath: "src/feature.js", name: "test" },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["ghp_abcdefghijklmnop"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["npm_abcdefghijklmnopqrstuvwxyz"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["github_pat_abcdefghijklmnopqrstuvwxyz"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["sk-abcdefghijklmnopqrstuvwxyz"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["AKIAABCDEFGHIJKLMNOP"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["eyJabcdefgh.ijklmnop.qrstuvwx"],
        },
      ],
      version: 1,
    }),
    marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: ["aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xY"],
        },
      ],
      version: 1,
    }),
    ...SECRET_GREP_PROBES.map((term) =>
      marker({
        outcome: "verified",
        recipes: [{ kind: "grep", path: "src/feature.js", terms: [term] }],
        version: 1,
      }),
    ),
  ])(
    "rejects absent, duplicate, malformed, unsafe, or prose-capable payloads",
    (value) => {
      expect(parseVerificationMemoryMarker(value)).toBeNull();
    },
  );

  it("keeps nearby benign grep identifiers available", () => {
    const value = marker({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: BENIGN_GREP_TERMS,
        },
      ],
      version: 1,
    });

    expect(parseVerificationMemoryMarker(value)).toEqual({
      outcome: "verified",
      recipes: [
        {
          kind: "grep",
          path: "src/feature.js",
          terms: BENIGN_GREP_TERMS,
        },
      ],
      version: 1,
    });
  });

  it("bounds final messages and markers without byte truncation", () => {
    const value = marker({ outcome: "verified", recipes: [], version: 1 });
    expect(
      parseVerificationMemoryMarker(value, {
        finalMessageBytes: Buffer.byteLength(value) - 1,
      }),
    ).toBeNull();
    expect(
      parseVerificationMemoryMarker(value, {
        markerBytes: Buffer.byteLength('{"version":1}') - 1,
      }),
    ).toBeNull();
  });

  it("uses only the final assistant content with a bounded completed-message fallback", () => {
    const capture = createVerificationMemoryCapture();
    capture.observe(
      JSON.stringify({
        event: { type: "message_start" },
        type: "stream_event",
      }),
    );
    capture.observe(
      JSON.stringify({
        event: {
          delta: {
            text: marker({
              outcome: "verified",
              recipes: recipes(),
              version: 1,
            }),
            type: "text_delta",
          },
          type: "content_block_delta",
        },
        type: "stream_event",
      }),
    );
    capture.observe(
      JSON.stringify({ event: { type: "message_stop" }, type: "stream_event" }),
    );
    capture.observe(
      JSON.stringify({
        message: {
          content: [
            {
              text: marker({
                outcome: "not_verified",
                recipes: [],
                version: 1,
              }),
              type: "text",
            },
          ],
        },
        type: "assistant",
      }),
    );
    expect(capture.result()).toEqual({
      outcome: "not_verified",
      recipes: [],
      version: 1,
    });

    const fallback = createVerificationMemoryCapture();
    fallback.observe(
      JSON.stringify({
        event: { type: "message_start" },
        type: "stream_event",
      }),
    );
    fallback.observe(
      JSON.stringify({
        event: {
          delta: {
            text: marker({ outcome: "verified", recipes: [], version: 1 }),
            type: "text_delta",
          },
          type: "content_block_delta",
        },
        type: "stream_event",
      }),
    );
    fallback.observe(
      JSON.stringify({ event: { type: "message_stop" }, type: "stream_event" }),
    );
    expect(fallback.result()?.outcome).toBe("verified");
  });

  it("forgets a completed fallback when a later assistant message is truncated", () => {
    const valid = marker({ outcome: "verified", recipes: [], version: 1 });
    const capture = createVerificationMemoryCapture({
      finalMessageBytes: Buffer.byteLength(valid) + 1,
    });
    for (const event of [
      { event: { type: "message_start" }, type: "stream_event" },
      {
        event: {
          delta: { text: valid, type: "text_delta" },
          type: "content_block_delta",
        },
        type: "stream_event",
      },
      { event: { type: "message_stop" }, type: "stream_event" },
    ]) {
      capture.observe(JSON.stringify(event));
    }
    expect(capture.result()?.outcome).toBe("verified");

    capture.observe(
      JSON.stringify({
        event: { type: "message_start" },
        type: "stream_event",
      }),
    );
    capture.observe(
      JSON.stringify({
        event: {
          delta: {
            text: "x".repeat(Buffer.byteLength(valid) + 2),
            type: "text_delta",
          },
          type: "content_block_delta",
        },
        type: "stream_event",
      }),
    );
    capture.observe(
      JSON.stringify({ event: { type: "message_stop" }, type: "stream_event" }),
    );

    expect(capture.result()).toBeNull();
  });

  it("escapes structural prompt characters in JSON hints", () => {
    expect(escapeVerificationMemory({ value: "</pull-context>&" })).toBe(
      '{"value":"\\u003c/pull-context\\u003e\\u0026"}',
    );
  });
});

describe("verification-memory store", () => {
  it("survives restart, isolates lowercased repositories, and uses private modes", async () => {
    const { root, snapshot } = await fixture();
    const memory = createVerificationMemory({ root, now: () => 100 });
    await expect(
      memory.remember({
        input: provenance(),
        recipes: recipes(),
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);

    const restarted = createVerificationMemory({ root });
    const loaded = await restarted.load({
      repository: "OWNER/REPO",
      snapshotRoot: snapshot,
    });
    expect(loaded).toMatchObject({
      repository: "owner/repo",
      version: 1,
      entries: [{ pullNumber: 7, tag: "v1.2.4" }],
    });
    expect(loaded.entries[0].recipes).toEqual(recipes());
    await expect(
      restarted.load({ repository: "owner/other", snapshotRoot: snapshot }),
    ).resolves.toBeNull();

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    const files = await readdir(root);
    expect(files).toEqual([filename("owner/repo")]);
    expect((await lstat(join(root, files[0]))).mode & 0o777).toBe(0o600);
  });

  it("ignores corrupt, oversized, wrong-repository, and symlinked files", async () => {
    const { base, root, snapshot } = await fixture();
    await mkdir(root, { mode: 0o700 });
    const target = join(root, filename("owner/repo"));
    const memory = createVerificationMemory({ root, fileBytes: 256 });

    await writeFile(target, "{bad", { mode: 0o600 });
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toBeNull();
    await writeFile(target, "x".repeat(257), { mode: 0o600 });
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toBeNull();
    await writeFile(
      target,
      JSON.stringify({ entries: [], repository: "owner/other", version: 1 }),
      { mode: 0o600 },
    );
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toBeNull();
    const writable = createVerificationMemory({ root });
    await expect(
      writable.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).rejects.toThrow("unreadable");

    await rm(target);
    const outside = join(base, "outside.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    await symlink(outside, target);
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toBeNull();
    await expect(
      writable.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).rejects.toThrow("unsafe");
  });

  it("revalidates every recipe as a regular file inside the immutable snapshot", async () => {
    const { base, root, snapshot } = await fixture();
    const outside = join(base, "outside.js");
    await writeFile(outside, "secret");
    await symlink(outside, join(snapshot, "src", "linked.js"));
    await writeFile(
      join(snapshot, "src", "binary.dat"),
      Buffer.from([0, 118, 105, 116, 101, 115, 116]),
    );
    await writeFile(
      join(snapshot, "src", "oversized.js"),
      `feature\n${"x".repeat(64)}`,
    );
    const memory = createVerificationMemory({ root, sourceBytes: 64 });
    await memory.remember({
      input: provenance(),
      recipes: [
        ...recipes(),
        { kind: "file", path: "src/linked.js", role: "implementation" },
        { kind: "file", path: "src/missing.js", role: "implementation" },
        { kind: "script", manifestPath: "package.json", name: "missing" },
        { kind: "tool", name: "eslint", sourcePath: "package.json" },
        { kind: "tool", name: "vitest", sourcePath: "src/binary.dat" },
        { kind: "grep", path: "src/feature.js", terms: ["missing"] },
        { kind: "grep", path: "src/feature.js", terms: ["Feature"] },
        { kind: "grep", path: "src/binary.dat", terms: ["vitest"] },
        { kind: "grep", path: "src/oversized.js", terms: ["feature"] },
      ],
      snapshotRoot: snapshot,
    });
    const loaded = await memory.load({
      repository: "owner/repo",
      snapshotRoot: snapshot,
    });
    expect(loaded.entries[0].recipes).toEqual(recipes());
  });

  it.each([
    ["package.json", "vitest run"],
    ["composer.json", "phpunit"],
    ["composer.json", ["phpunit", "phpstan analyse"]],
  ])("accepts a valid %s script value", async (manifestPath, script) => {
    const { root, snapshot } = await fixture();
    await writeFile(
      join(snapshot, manifestPath),
      JSON.stringify({ scripts: { verify: script } }),
    );
    const memory = createVerificationMemory({ root });
    const recipe = { kind: "script", manifestPath, name: "verify" };

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipe],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toMatchObject({ entries: [{ recipes: [recipe] }] });
  });

  it.each([
    ["package.json", null],
    ["package.json", {}],
    ["package.json", 42],
    ["package.json", true],
    ["package.json", ""],
    ["package.json", "   "],
    ["package.json", []],
    ["package.json", ["vitest run"]],
    ["composer.json", null],
    ["composer.json", {}],
    ["composer.json", 42],
    ["composer.json", false],
    ["composer.json", ""],
    ["composer.json", "   "],
    ["composer.json", []],
    ["composer.json", ["phpunit", ""]],
    ["composer.json", ["phpunit", "   "]],
    ["composer.json", ["phpunit", null]],
    ["composer.json", ["phpunit", 42]],
  ])("rejects an invalid %s script value", async (manifestPath, script) => {
    const { root, snapshot } = await fixture();
    await writeFile(
      join(snapshot, manifestPath),
      JSON.stringify({ scripts: { verify: script } }),
    );
    const memory = createVerificationMemory({ root });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [{ kind: "script", manifestPath, name: "verify" }],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
  });

  it("rejects every live-shaped secret probe before a grep recipe can persist", async () => {
    const { root, snapshot } = await fixture();
    await writeFile(
      join(snapshot, "test", "secret-probes.txt"),
      `${SECRET_GREP_PROBES.join("\n")}\n${BENIGN_GREP_TERMS.join("\n")}`,
    );
    const memory = createVerificationMemory({ root });

    for (const term of SECRET_GREP_PROBES) {
      await expect(
        memory.remember({
          input: provenance(),
          recipes: [
            { kind: "grep", path: "test/secret-probes.txt", terms: [term] },
          ],
          snapshotRoot: snapshot,
        }),
      ).rejects.toThrow("Valid verification recipes are required.");
    }
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [
          {
            kind: "grep",
            path: "test/secret-probes.txt",
            terms: BENIGN_GREP_TERMS,
          },
        ],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);
    const loaded = await memory.load({
      repository: "owner/repo",
      snapshotRoot: snapshot,
    });
    expect(loaded.entries[0].recipes).toEqual([
      {
        kind: "grep",
        path: "test/secret-probes.txt",
        terms: BENIGN_GREP_TERMS,
      },
    ]);
  });

  it("serializes concurrent writes per repository without losing entries", async () => {
    const { root, snapshot } = await fixture();
    let timestamp = 0;
    const memory = createVerificationMemory({ root, now: () => ++timestamp });
    await Promise.all(
      [7, 8, 9, 10].map((pullNumber) =>
        memory.remember({
          input: provenance({ pullNumber }),
          recipes: [recipes()[0]],
          snapshotRoot: snapshot,
        }),
      ),
    );
    const loaded = await memory.load({
      repository: "owner/repo",
      snapshotRoot: snapshot,
    });
    expect(
      loaded.entries.map((entry) => entry.pullNumber).sort((a, b) => a - b),
    ).toEqual([7, 8, 9, 10]);
  });

  it("serializes same-repository writes across memory instances", async () => {
    const { root, snapshot } = await fixture();
    const first = createVerificationMemory({ root, now: () => 1 });
    const second = createVerificationMemory({ root, now: () => 2 });

    await Promise.all([
      first.remember({
        input: provenance({ pullNumber: 7 }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
      second.remember({
        input: provenance({ pullNumber: 8 }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ]);

    const loaded = await first.load({
      repository: "owner/repo",
      snapshotRoot: snapshot,
    });
    expect(loaded.entries.map((entry) => entry.pullNumber)).toEqual([7, 8]);
  });

  it("reclaims a crash-stale lock whose owner is definitively gone", async () => {
    const { root, snapshot } = await fixture();
    const clock = Date.now() + 1_000;
    const lock = join(root, LOCK_PATH);
    await mkdir(root, { mode: 0o700 });
    await writeFile(lock, lockMetadata({ acquiredAt: clock }), { mode: 0o600 });
    const memory = createVerificationMemory({
      root,
      lockNow: () => clock,
      lockProcessAlive: async (pid) => {
        expect(pid).toBe(41_001);
        return false;
      },
      lockRetry: 2,
      lockTimeout: 20,
      pid: 41_002,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);
    expect(await readdir(root)).toEqual([filename("owner/repo")]);
  });

  it("never reclaims an old lock whose owner is definitively alive", async () => {
    const { root, snapshot } = await fixture();
    const clock = Date.now() + 10_000;
    const lock = join(root, LOCK_PATH);
    const content = lockMetadata({ acquiredAt: clock - 1_000 });
    await mkdir(root, { mode: 0o700 });
    await writeFile(lock, content, {
      mode: 0o600,
    });
    await utimes(lock, (clock - 1_000) / 1_000, (clock - 1_000) / 1_000);
    const before = await lstat(lock);
    const memory = createVerificationMemory({
      root,
      lockLease: 100,
      lockNow: () => clock,
      lockProcessAlive: async () => true,
      lockRetry: 2,
      lockTimeout: 10,
      pid: 41_002,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
    const after = await lstat(lock);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(lock, "utf8")).toBe(content);
  });

  it("reclaims an old lock whose owner is definitively gone", async () => {
    const { root, snapshot } = await fixture();
    const clock = Date.now() + 10_000;
    const lock = join(root, LOCK_PATH);
    await mkdir(root, { mode: 0o700 });
    await writeFile(lock, lockMetadata({ acquiredAt: clock - 1_000 }), {
      mode: 0o600,
    });
    await utimes(lock, (clock - 1_000) / 1_000, (clock - 1_000) / 1_000);
    const memory = createVerificationMemory({
      root,
      lockLease: 100,
      lockNow: () => clock,
      lockProcessAlive: async () => false,
      lockRetry: 2,
      lockTimeout: 20,
      pid: 41_002,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);
    expect(await readdir(root)).toEqual([filename("owner/repo")]);
  });

  it("leaves a fresh live lock byte-for-byte unchanged on contention", async () => {
    const { root, snapshot } = await fixture();
    const clock = Date.now() + 1_000;
    const lock = join(root, LOCK_PATH);
    const content = lockMetadata({ acquiredAt: clock });
    await mkdir(root, { mode: 0o700 });
    await writeFile(lock, content, { mode: 0o600 });
    const before = await lstat(lock);
    const memory = createVerificationMemory({
      root,
      lockNow: () => clock,
      lockProcessAlive: async () => true,
      lockRetry: 2,
      lockTimeout: 10,
      pid: 41_002,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
    const after = await lstat(lock);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(lock, "utf8")).toBe(content);
  });

  it("does not unlink a lock whose content changes during stale revalidation", async () => {
    const { root, snapshot } = await fixture();
    const clock = Date.now() + 1_000;
    const lock = join(root, LOCK_PATH);
    const original = lockMetadata({ acquiredAt: clock });
    const replacement = lockMetadata({
      acquiredAt: clock,
      nonce: "00000000-0000-4000-8000-000000000002",
      pid: 41_003,
    });
    await mkdir(root, { mode: 0o700 });
    await writeFile(lock, original, { mode: 0o600 });
    const before = await lstat(lock);
    let probes = 0;
    const memory = createVerificationMemory({
      root,
      lockNow: () => clock,
      lockProcessAlive: async () => {
        probes += 1;
        if (probes === 1) {
          await writeFile(lock, replacement);
          return false;
        }
        return true;
      },
      lockRetry: 2,
      lockTimeout: 10,
      pid: 41_002,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
    const after = await lstat(lock);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(lock, "utf8")).toBe(replacement);
  });

  it("fails closed without reclaiming malformed, future, wrong-mode, or symlink locks", async () => {
    for (const kind of ["malformed", "future", "wrong-mode", "symlink"]) {
      const { base, root, snapshot } = await fixture();
      const clock = Date.now() + 1_000;
      const lock = join(root, LOCK_PATH);
      await mkdir(root, { mode: 0o700 });
      if (kind === "symlink") {
        const outside = join(base, "outside-lock");
        await writeFile(outside, lockMetadata({ acquiredAt: clock }), {
          mode: 0o600,
        });
        await symlink(outside, lock);
      } else {
        const content =
          kind === "malformed"
            ? "{}"
            : lockMetadata({
                acquiredAt: kind === "future" ? clock + 1_000 : clock,
              });
        await writeFile(lock, content, { mode: 0o600 });
        if (kind === "wrong-mode") await chmod(lock, 0o644);
      }
      const memory = createVerificationMemory({
        root,
        lockNow: () => clock,
        lockProcessAlive: async () => false,
        lockRetry: 2,
        lockTimeout: 10,
        pid: 41_002,
      });

      await expect(
        memory.remember({
          input: provenance(),
          recipes: [recipes()[0]],
          snapshotRoot: snapshot,
        }),
      ).resolves.toBe(false);
      await expect(lstat(lock)).resolves.toBeDefined();
    }
  });

  it("serializes aggregate accounting across repositories and stays under the root budget", async () => {
    const { base, root, snapshot } = await fixture();
    const probeRoot = join(base, "probe");
    const probe = createVerificationMemory({ root: probeRoot, now: () => 1 });
    await probe.remember({
      input: provenance({ repository: "org/probe" }),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const size = Buffer.byteLength(
      await readFile(join(probeRoot, filename("org/probe")), "utf8"),
    );
    const budget = size * 2 + 16;
    let timestamp = 0;
    const memory = createVerificationMemory({
      root,
      storeBytes: budget,
      now: () => ++timestamp,
    });
    await Promise.all(
      ["org/aaaaa", "org/bbbbb", "org/ccccc", "org/ddddd"].map((repository) =>
        memory.remember({
          input: provenance({ repository }),
          recipes: [recipes()[0]],
          snapshotRoot: snapshot,
        }),
      ),
    );
    const files = await readdir(root);
    expect(files).toHaveLength(2);
    const total = (
      await Promise.all(
        files.map(async (name) =>
          Buffer.byteLength(await readFile(join(root, name), "utf8")),
        ),
      )
    ).reduce((sum, value) => sum + value, 0);
    expect(total).toBeLessThanOrEqual(budget);
    for (const name of files) {
      const encoded = await readFile(join(root, name), "utf8");
      expect(() => JSON.parse(encoded)).not.toThrow();
    }
  });

  it("deterministically evicts the oldest whole repository file", async () => {
    const { root, snapshot } = await fixture();
    let timestamp = 0;
    const initial = createVerificationMemory({ root, now: () => ++timestamp });
    for (const repository of ["org/aaaa", "org/bbbb"]) {
      await initial.remember({
        input: provenance({ repository }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      });
    }
    const first = await readFile(join(root, filename("org/aaaa")), "utf8");
    const second = await readFile(join(root, filename("org/bbbb")), "utf8");
    const budget = Buffer.byteLength(first) + Buffer.byteLength(second) + 8;
    const limited = createVerificationMemory({
      root,
      storeBytes: budget,
      now: () => ++timestamp,
    });
    await limited.remember({
      input: provenance({ repository: "org/cccc" }),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });

    const files = (await readdir(root)).sort();
    expect(files).toContain(filename("org/bbbb"));
    expect(files).toContain(filename("org/cccc"));
    expect(files).not.toContain(filename("org/aaaa"));
  });

  it("preserves existing repositories when the current write cannot fit", async () => {
    const { root, snapshot } = await fixture();
    const initial = createVerificationMemory({ root, now: () => 1 });
    await initial.remember({
      input: provenance({ repository: "org/keep" }),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const limited = createVerificationMemory({ root, storeBytes: 1 });
    await expect(
      limited.remember({
        input: provenance({ repository: "org/neww" }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
    expect(await readdir(root)).toEqual([filename("org/keep")]);
  });

  it("counts owned crash temp files against the aggregate budget without deleting them", async () => {
    const { base, root, snapshot } = await fixture();
    const probeRoot = join(base, "orphan-probe");
    const probe = createVerificationMemory({ root: probeRoot, now: () => 1 });
    await probe.remember({
      input: provenance(),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const size = (await lstat(join(probeRoot, filename("owner/repo")))).size;

    await mkdir(root, { mode: 0o700 });
    const orphan = ".owner-repo.crash.tmp";
    await writeFile(join(root, orphan), "x".repeat(32), { mode: 0o600 });
    const memory = createVerificationMemory({
      root,
      storeBytes: size + 16,
    });

    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(false);
    expect(await readdir(root)).toEqual([orphan]);
  });

  it("accepts a platform-canonical temp alias but rejects a symlink below it", async () => {
    const { base, root, snapshot } = await fixture();
    const memory = createVerificationMemory({ root, now: () => 1 });
    await expect(
      memory.remember({
        input: provenance(),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).resolves.toBe(true);
    expect(
      await readFile(
        join(await realpath(root), filename("owner/repo")),
        "utf8",
      ),
    ).toContain("owner/repo");

    const outside = join(base, "outside-memory");
    const alias = join(base, "memory-alias");
    await mkdir(outside);
    await symlink(outside, alias);
    const unsafe = createVerificationMemory({ root: join(alias, "nested") });
    await expect(
      unsafe.remember({
        input: provenance({ repository: "owner/unsafe" }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      }),
    ).rejects.toThrow("unsafe ancestor");
    await expect(lstat(join(outside, "nested"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prunes whole entries before an atomic per-repository file write", async () => {
    const { base, root, snapshot } = await fixture();
    const probeRoot = join(base, "file-probe");
    const probe = createVerificationMemory({ root: probeRoot, now: () => 1 });
    await probe.remember({
      input: provenance(),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const single = Buffer.byteLength(
      await readFile(join(probeRoot, filename("owner/repo")), "utf8"),
    );
    const memory = createVerificationMemory({
      root,
      fileBytes: single + 8,
      now: () => 2,
    });
    await memory.remember({
      input: provenance(),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    await memory.remember({
      input: provenance({ pullNumber: 8 }),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const encoded = await readFile(join(root, filename("owner/repo")), "utf8");
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(single + 8);
    expect(
      JSON.parse(encoded).entries.map((entry) => entry.pullNumber),
    ).toEqual([8]);
  });

  it("evicts a whole oldest entry to satisfy the total recipe budget", async () => {
    const { root, snapshot } = await fixture();
    let timestamp = 0;
    const memory = createVerificationMemory({
      root,
      entries: 8,
      totalRecipes: 2,
      now: () => ++timestamp,
    });
    await memory.remember({
      input: provenance(),
      recipes: recipes().slice(0, 2),
      snapshotRoot: snapshot,
    });
    await memory.remember({
      input: provenance({ pullNumber: 8 }),
      recipes: [recipes()[0]],
      snapshotRoot: snapshot,
    });
    const document = JSON.parse(
      await readFile(join(root, filename("owner/repo")), "utf8"),
    );
    expect(document.entries.map((entry) => entry.pullNumber)).toEqual([8]);
  });

  it("evicts whole oldest entries to satisfy entry and prompt budgets", async () => {
    const { root, snapshot } = await fixture();
    let timestamp = 0;
    const memory = createVerificationMemory({
      root,
      entries: 2,
      totalRecipes: 2,
      promptBytes: 260,
      now: () => ++timestamp,
    });
    for (const pullNumber of [7, 8, 9]) {
      await memory.remember({
        input: provenance({ pullNumber }),
        recipes: [recipes()[0]],
        snapshotRoot: snapshot,
      });
    }
    const encoded = await readFile(join(root, filename("owner/repo")), "utf8");
    expect(() => JSON.parse(encoded)).not.toThrow();
    const stored = JSON.parse(encoded);
    expect(stored.entries.map((entry) => entry.pullNumber)).toEqual([8, 9]);
    const loaded = await memory.load({
      repository: "owner/repo",
      snapshotRoot: snapshot,
    });
    expect(loaded.entries.map((entry) => entry.pullNumber)).toEqual([9]);

    await chmod(join(root, filename("owner/repo")), 0o644);
    await expect(
      memory.load({ repository: "owner/repo", snapshotRoot: snapshot }),
    ).resolves.toBeNull();
  });
});
