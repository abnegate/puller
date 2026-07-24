import { access, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeFixture } from "./fixtures.mjs";

const roots = new Set();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { force: true, recursive: true })),
  );
  roots.clear();
});

describe("test fixture cleanup", () => {
  it("removes an owned temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-fixture-test-"));
    roots.add(root);
    await mkdir(join(root, "nested"));

    await removeFixture(root);

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    roots.delete(root);
  });

  it("refuses a top-level symlink without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-fixture-test-"));
    roots.add(root);
    const target = join(root, "target");
    const link = join(root, "link");
    await mkdir(target);
    await symlink(target, link);

    await expect(removeFixture(link)).rejects.toThrow(
      "refused a non-directory root",
    );
    await expect(access(target)).resolves.toBeUndefined();
  });
});
