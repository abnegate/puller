import { chmod, lstat, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const REMOVAL_RETRIES = 10;
const REMOVAL_RETRY_DELAY = 100;

function inside(root, path) {
  const child = relative(root, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

async function fixtureIdentity(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TypeError("Test fixture paths must be absolute.");
  }
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Test fixture cleanup refused a non-directory root.");
  }
  const [canonical, temporary] = await Promise.all([
    realpath(path),
    realpath(tmpdir()),
  ]);
  const requested = resolve(path);
  if (
    (!inside(resolve(tmpdir()), requested) && !inside(temporary, requested)) ||
    !inside(temporary, canonical)
  ) {
    throw new Error(
      "Test fixture cleanup refused a path outside the test temporary root.",
    );
  }
  return {
    canonical,
    device: details.dev,
    inode: details.ino,
  };
}

async function makeWritable(path) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (details.isSymbolicLink()) return;
  await chmod(path, details.isDirectory() ? 0o700 : 0o600);
  if (!details.isDirectory()) return;

  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOTDIR" || error?.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const target = join(path, entry.name);
      await makeWritable(target);
    }),
  );
}

export async function removeFixture(path) {
  const identity = await fixtureIdentity(path);
  if (!identity) return;
  await makeWritable(identity.canonical);
  const current = await fixtureIdentity(identity.canonical);
  if (
    !current ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw new Error("Test fixture cleanup refused a replaced root.");
  }
  await rm(identity.canonical, {
    force: true,
    maxRetries: REMOVAL_RETRIES,
    recursive: true,
    retryDelay: REMOVAL_RETRY_DELAY,
  });
}

export async function removeFixtures(paths) {
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      await removeFixture(path);
      return path;
    }),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          new Error(`Test fixture cleanup failed for ${paths[index]}.`, {
            cause: result.reason,
          }),
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Test fixture cleanup did not settle.");
  }
}

export async function removeTrackedFixtures(fixtures) {
  const paths = [...fixtures];
  await removeFixtures(paths);
  for (const path of paths) fixtures.delete(path);
}
