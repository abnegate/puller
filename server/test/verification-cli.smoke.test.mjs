import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeEnvironment } from "../claude.mjs";
import { verificationArguments } from "../verification.mjs";

const enabled = process.env.PULLER_CLAUDE_SMOKE === "1";
const roots = [];
const OUTPUT_LIMIT = 8 * 1024 * 1024;

function execute(arguments_, prompt, options) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", arguments_, {
      ...options,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostics = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next, "utf8") > OUTPUT_LIMIT) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        throw new Error("Claude verification smoke output exceeded its limit.");
      }
      return next;
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(() => reject(new Error("Claude verification smoke timed out.")));
    }, 180_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      try {
        output = append(output, chunk);
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        diagnostics = append(diagnostics, chunk);
      } catch (error) {
        finish(() => reject(error));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.stdin.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) =>
      finish(() => resolve({ code, diagnostics, output, signal })),
    );
    child.stdin.end(prompt);
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe.skipIf(!enabled)("installed Claude verification command", () => {
  it("accepts the exact production arguments and stdin stream without modifying the snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "puller-verification-smoke-"));
    roots.push(root);
    const snapshot = join(root, "snapshot");
    const temporary = join(root, "temporary");
    await Promise.all([mkdir(snapshot), mkdir(temporary)]);
    await writeFile(join(snapshot, "README.md"), "# Verification fixture\n");
    const arguments_ = verificationArguments(snapshot, temporary);
    const prompt = [
      "This is a local command-line compatibility smoke test.",
      "Do not call tools or inspect files.",
      "Reply with PULLER_CLAUDE_VERIFICATION_SMOKE_OK followed by exactly",
      '<puller-verification-memory>{"version":1,"outcome":"not_verified","recipes":[]}</puller-verification-memory>.',
    ].join(" ");

    const result = await execute(arguments_, prompt, {
      cwd: snapshot,
      env: claudeEnvironment(process.env, temporary),
    });
    const events = result.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const terminal = events.findLast((event) => event.type === "result");
    const text = events
      .filter(
        (event) =>
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta",
      )
      .map((event) => event.event.delta.text)
      .join("");

    expect(result).toMatchObject({ code: 0, diagnostics: "", signal: null });
    expect(terminal).toMatchObject({ is_error: false, subtype: "success" });
    expect(text).toContain("PULLER_CLAUDE_VERIFICATION_SMOKE_OK");
    expect(text).toContain("<puller-verification-memory>");
    expect(await readdir(snapshot)).toEqual(["README.md"]);
    expect(await readFile(join(snapshot, "README.md"), "utf8")).toBe(
      "# Verification fixture\n",
    );
  }, 240_000);
});
