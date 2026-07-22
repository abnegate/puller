import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveVerificationMemoryRoot } from "../index.mjs";

describe("development command", () => {
  it("restarts only when server source changes", async () => {
    const packagePath = new URL("../../package.json", import.meta.url);
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));

    expect(manifest.scripts.dev).toBe(
      "node --watch-path=server server/index.mjs --dev",
    );
  });

  it("resolves verification memory at call time with environment precedence", () => {
    expect(
      resolveVerificationMemoryRoot(
        { PULLER_VERIFICATION_MEMORY_ROOT: "/private/test-memory" },
        "/different/home",
      ),
    ).toBe("/private/test-memory");
    expect(resolveVerificationMemoryRoot({}, "/private/call-time-home")).toBe(
      "/private/call-time-home/.puller/verification-memory",
    );
  });
});
