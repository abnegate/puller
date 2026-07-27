import { afterEach, describe, expect, it, vi } from "vitest";

import { highlightHunks } from "./syntax-highlight";
import type {
  SyntaxHighlightResponse,
  SyntaxWorkerRequest,
} from "./syntax-protocol";
import { createSyntaxWorkerRuntime } from "./syntax-worker-runtime";
import type { HighlightedFile, SyntaxLanguage, SyntaxToken } from "./syntax";
import type { PullDiffFile, PullDiffHunk, PullDiffLine } from "./types";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

const diffLine = (
  content: string,
  kind: PullDiffLine["kind"],
  oldLine: number | null,
  newLine: number | null,
): PullDiffLine => ({ content, kind, newLine, oldLine });

const hunk = (lines: PullDiffLine[]): PullDiffHunk => ({
  header: "@@ -1,1 +1,1 @@",
  lines,
  newLines: lines.filter((line) => line.newLine !== null).length,
  newStart: 1,
  oldLines: lines.filter((line) => line.oldLine !== null).length,
  oldStart: 1,
});

const file = (
  path: string,
  hunks: PullDiffHunk[] = [],
  status: PullDiffFile["status"] = "modified",
): PullDiffFile => ({
  additions: 0,
  binary: false,
  blobUrl: "https://github.com/example/repository/blob/head/file",
  changes: 0,
  deletions: 0,
  hunks,
  path,
  previousPath: null,
  rawUrl: "https://github.com/example/repository/raw/head/file",
  status,
  truncated: false,
});

const token = (content: string, darkForeground = "#ffffff"): SyntaxToken => ({
  content,
  darkFontStyle: "normal",
  darkFontWeight: 400,
  darkForeground,
  lightFontStyle: "normal",
  lightFontWeight: 400,
  lightForeground: "#000000",
});

const loadFacade = async (
  highlightSyntax: (
    source: string,
    language: SyntaxLanguage,
  ) => Promise<readonly (readonly SyntaxToken[])[]>,
) => {
  vi.resetModules();
  const workers: object[] = [];

  class TestSyntaxWorker {
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessage: ((event: MessageEvent<SyntaxHighlightResponse>) => void) | null =
      null;
    readonly runtime = createSyntaxWorkerRuntime(
      ({ hunks, language }, cancelled) =>
        highlightHunks(hunks, language, highlightSyntax, cancelled),
      (response) => {
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent<SyntaxHighlightResponse>("message", {
              data: response,
            }),
          );
        });
      },
    );

    constructor(_url: URL, _options: WorkerOptions) {
      workers.push(this);
    }

    postMessage(message: SyntaxWorkerRequest): void {
      this.runtime.receive(message);
    }

    terminate(): void {}
  }

  vi.stubGlobal("Worker", TestSyntaxWorker);
  return Object.assign(await import("./syntax"), {
    workerCount: () => workers.length,
  });
};

afterEach(() => {
  vi.doUnmock("./syntax-engine");
  vi.doUnmock("@shikijs/core");
  vi.doUnmock("@shikijs/engine-javascript");
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("detectSyntaxLanguage", () => {
  it.each<[string, SyntaxLanguage]>([
    ["src/example.ts", "typescript"],
    ["src/example.cts", "typescript"],
    ["src/example.mts", "typescript"],
    ["src/example.tsx", "tsx"],
    ["src/example.js", "javascript"],
    ["src/example.cjs", "javascript"],
    ["src/example.mjs", "javascript"],
    ["src/example.jsx", "jsx"],
    ["src/example.php", "php"],
    ["templates/example.phtml", "php"],
    ["src/example.py", "python"],
    ["src/example.pyw", "python"],
    ["scripts/example.sh", "shellscript"],
    ["scripts/example.bash", "shellscript"],
    ["scripts/example.zsh", "shellscript"],
    ["home/.bashrc", "shellscript"],
    ["home/.zshrc", "shellscript"],
    ["src/example.c", "c"],
    ["include/example.h", "c"],
    ["src/example.cc", "cpp"],
    ["src/example.cpp", "cpp"],
    ["src/example.cxx", "cpp"],
    ["src/example.c++", "cpp"],
    ["include/example.hh", "cpp"],
    ["include/example.hpp", "cpp"],
    ["include/example.hxx", "cpp"],
    ["include/example.h++", "cpp"],
    ["src/Example.cs", "csharp"],
    ["src/Example.java", "java"],
    ["src/example.go", "go"],
    ["src/example.rs", "rust"],
    ["src/example.rb", "ruby"],
    ["example.rake", "ruby"],
    ["example.gemspec", "ruby"],
    ["Gemfile", "ruby"],
    ["nested/Rakefile", "ruby"],
    ["src/example.kt", "kotlin"],
    ["src/example.kts", "kotlin"],
    ["src/example.swift", "swift"],
    ["src/example.dart", "dart"],
    ["src/example.lua", "lua"],
    ["database/example.sql", "sql"],
    ["public/example.html", "html"],
    ["public/example.htm", "html"],
    ["styles/example.css", "css"],
    ["styles/example.scss", "scss"],
    ["styles/example.sass", "scss"],
    ["data/example.json", "json"],
    ["data/example.jsonc", "jsonc"],
    ["data/example.json5", "jsonc"],
    ["config/example.yaml", "yaml"],
    ["config/example.yml", "yaml"],
    ["docs/example.md", "markdown"],
    ["docs/example.markdown", "markdown"],
    ["docs/example.mdx", "markdown"],
    ["data/example.xml", "xml"],
    ["data/example.xsl", "xml"],
    ["data/example.xsd", "xml"],
    ["public/example.svg", "xml"],
    ["Dockerfile", "docker"],
    ["docker/Dockerfile.production", "docker"],
    ["docker/example.dockerfile", "docker"],
    ["terraform/example.tf", "hcl"],
    ["terraform/example.tfvars", "hcl"],
    ["terraform/example.hcl", "hcl"],
    ["scripts/example.ps1", "powershell"],
    ["scripts/example.psm1", "powershell"],
    ["scripts/example.psd1", "powershell"],
    ["schema/example.graphql", "graphql"],
    ["schema/example.gql", "graphql"],
  ])("maps %s to %s", async (path, language) => {
    const { detectSyntaxLanguage } = await import("./syntax");
    expect(detectSyntaxLanguage(file(path))).toBe(language);
  });

  it("matches supported filename families case-insensitively", async () => {
    const { detectSyntaxLanguage } = await import("./syntax");
    expect(detectSyntaxLanguage(file("SRC/EXAMPLE.TSX"))).toBe("tsx");
    expect(detectSyntaxLanguage(file("docker/DOCKERFILE.CI"))).toBe("docker");
  });

  it.each<[string, SyntaxLanguage]>([
    ["#!/usr/bin/env node", "javascript"],
    ["#!/usr/bin/env -S deno run --allow-read", "javascript"],
    ["#!/usr/bin/bun", "javascript"],
    ["#!/usr/local/bin/node", "javascript"],
    ["#!/usr/bin/python3.13", "python"],
    ["#!/usr/bin/env ruby", "ruby"],
    ["#!/bin/bash", "shellscript"],
    ["#!/bin/sh", "shellscript"],
    ["#!/usr/bin/env zsh", "shellscript"],
    ["#!/usr/bin/php", "php"],
    ["#!/usr/bin/env pwsh", "powershell"],
    ["#!/usr/bin/powershell -File", "powershell"],
  ])("uses the line-one shebang %s", async (shebang, language) => {
    const { detectSyntaxLanguage } = await import("./syntax");
    const source = file("scripts/tool", [
      hunk([diffLine(shebang, "addition", null, 1)]),
    ]);
    expect(detectSyntaxLanguage(source)).toBe(language);
  });

  it("uses the old line-one shebang only for a removed file", async () => {
    const { detectSyntaxLanguage } = await import("./syntax");
    const removed = file(
      "scripts/tool",
      [hunk([diffLine("#!/usr/bin/env python3", "deletion", 1, null)])],
      "removed",
    );
    const modified = file("scripts/tool", removed.hunks);

    expect(detectSyntaxLanguage(removed)).toBe("python");
    expect(detectSyntaxLanguage(modified)).toBeNull();
  });

  it.each([
    ["#!/usr/bin/env node", 2, null],
    [" #!/usr/bin/env node", 1, null],
    ["#!/usr/bin/env nodeish", 1, null],
    ["#!/usr/bin/env", 1, null],
    ["#!/usr/bin/env pythonista", 1, null],
    ["#!node", 1, null],
  ])(
    "rejects an irrelevant or unsupported shebang",
    async (content, newLine, expected) => {
      const { detectSyntaxLanguage } = await import("./syntax");
      const source = file("scripts/tool", [
        hunk([diffLine(content, "addition", null, newLine)]),
      ]);
      expect(detectSyntaxLanguage(source)).toBe(expected);
    },
  );

  it("prefers a known filename over a conflicting shebang", async () => {
    const { detectSyntaxLanguage } = await import("./syntax");
    const source = file("scripts/tool.py", [
      hunk([diffLine("#!/usr/bin/env node", "addition", null, 1)]),
    ]);
    expect(detectSyntaxLanguage(source)).toBe("python");
  });
});

describe("highlightFile", () => {
  it("maps each hunk through exact old and new syntax streams", async () => {
    const highlightSyntax = vi.fn(
      async (source: string): Promise<readonly (readonly SyntaxToken[])[]> => {
        const foreground = source.includes('old";') ? "old" : "new";
        return source
          .split("\n")
          .map((content) => [token(content, foreground)]);
      },
    );
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("src/example.ts", [
      hunk([
        diffLine('const value = "open', "context", 1, 1),
        diffLine('old";', "deletion", 2, null),
        diffLine('new";', "addition", null, 2),
        diffLine("consume(value);", "context", 3, 3),
        diffLine("\\ No newline at end of file", "meta", null, null),
      ]),
    ]);

    const result = await highlightFile(source);

    expect(highlightSyntax).toHaveBeenNthCalledWith(
      1,
      'const value = "open\nold";\nconsume(value);',
      "typescript",
    );
    expect(highlightSyntax).toHaveBeenNthCalledWith(
      2,
      'const value = "open\nnew";\nconsume(value);',
      "typescript",
    );
    expect(
      result?.hunks[0]?.lines.map((line) => line?.[0]?.darkForeground ?? null),
    ).toEqual(["new", "old", "new", "new", null]);
    expect(
      result?.hunks[0]?.lines.map(
        (line) => line?.map(({ content }) => content).join("") ?? null,
      ),
    ).toEqual([
      'const value = "open',
      'old";',
      'new";',
      "consume(value);",
      null,
    ]);
  });

  it("preserves empty lines and leading or trailing whitespace exactly", async () => {
    const highlightSyntax = vi.fn(
      async (source: string): Promise<readonly (readonly SyntaxToken[])[]> =>
        source.split("\n").map((content) => [token(content)]),
    );
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.py", [
      hunk([
        diffLine("  leading", "addition", null, 1),
        diffLine("", "addition", null, 2),
        diffLine("trailing  ", "addition", null, 3),
      ]),
    ]);

    const result = await highlightFile(source);
    expect(
      result?.hunks[0]?.lines.map((line) =>
        line?.map(({ content }) => content).join(""),
      ),
    ).toEqual(["  leading", "", "trailing  "]);
  });

  it("drops a token line when its content does not exactly match the diff", async () => {
    const highlightSyntax = vi.fn(
      async (source: string): Promise<readonly (readonly SyntaxToken[])[]> =>
        source.split("\n").map((content) => [token(content.trim())]),
    );
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.go", [
      hunk([
        diffLine("  mismatch", "addition", null, 1),
        diffLine("match", "addition", null, 2),
      ]),
    ]);

    const result = await highlightFile(source);
    expect(result?.hunks[0]?.lines[0]).toBeNull();
    expect(result?.hunks[0]?.lines[1]?.[0]?.content).toBe("match");
  });

  it("drops a whole stream when the token line count is not exact", async () => {
    const highlightSyntax = vi.fn(
      async (): Promise<readonly (readonly SyntaxToken[])[]> => [
        [token("first")],
      ],
    );
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.rs", [
      hunk([
        diffLine("first", "addition", null, 1),
        diffLine("second", "addition", null, 2),
      ]),
    ]);

    const result = await highlightFile(source);
    expect(result?.hunks[0]?.lines).toEqual([null, null]);
  });

  it("deduplicates work only for the same exact file object", async () => {
    const highlightSyntax = vi.fn(
      async (source: string): Promise<readonly (readonly SyntaxToken[])[]> =>
        source.split("\n").map((content) => [token(content)]),
    );
    const { highlightFile } = await loadFacade(highlightSyntax);
    const lines = [hunk([diffLine("const value = 1;", "addition", null, 1)])];
    const source = file("example.ts", lines);

    const first = highlightFile(source);
    const second = highlightFile(source);
    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(highlightSyntax).toHaveBeenCalledTimes(1);

    await highlightFile(file("example.ts", lines));
    expect(highlightSyntax).toHaveBeenCalledTimes(2);
  });

  it("evicts a rejected file promise and retries it", async () => {
    const highlightSyntax = vi
      .fn<
        (
          source: string,
          language: SyntaxLanguage,
        ) => Promise<readonly (readonly SyntaxToken[])[]>
      >()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce([[token("<?php")]]);
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.php", [
      hunk([diffLine("<?php", "addition", null, 1)]),
    ]);

    await expect(highlightFile(source)).rejects.toThrow("temporary");
    await expect(highlightFile(source)).resolves.toMatchObject({
      language: "php",
    });
    expect(highlightSyntax).toHaveBeenCalledTimes(2);
  });

  it("keeps shared work alive until the last observing caller releases it", async () => {
    const pending = deferred<readonly (readonly SyntaxToken[])[]>();
    const highlightSyntax = vi.fn(() => pending.promise);
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.ts", [
      hunk([diffLine("const shared = true;", "addition", null, 1)]),
    ]);
    const first = new AbortController();
    const second = new AbortController();

    const firstResult = highlightFile(source, first.signal);
    const secondResult = highlightFile(source, second.signal);
    await vi.waitFor(() => expect(highlightSyntax).toHaveBeenCalledTimes(1));

    first.abort();
    await expect(firstResult).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve([[token("const shared = true;")]]);

    await expect(secondResult).resolves.toMatchObject({
      language: "typescript",
    });
    expect(highlightSyntax).toHaveBeenCalledTimes(1);
  });

  it("cancels unobserved queued work and retries the exact file cleanly", async () => {
    const firstHighlight = deferred<readonly (readonly SyntaxToken[])[]>();
    const highlightSyntax = vi
      .fn<
        (
          source: string,
          language: SyntaxLanguage,
        ) => Promise<readonly (readonly SyntaxToken[])[]>
      >()
      .mockReturnValueOnce(firstHighlight.promise)
      .mockResolvedValueOnce([[token("const retried = true;")]]);
    const { highlightFile } = await loadFacade(highlightSyntax);
    const source = file("example.ts", [
      hunk([diffLine("const retried = true;", "addition", null, 1)]),
    ]);
    const first = new AbortController();
    const second = new AbortController();

    const abandoned = highlightFile(source, first.signal);
    await vi.waitFor(() => expect(highlightSyntax).toHaveBeenCalledTimes(1));
    first.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

    const retry = highlightFile(source, second.signal);
    firstHighlight.resolve([[token("const retried = true;")]]);
    await expect(retry).resolves.toMatchObject({ language: "typescript" });
    expect(highlightSyntax).toHaveBeenCalledTimes(2);
  });

  it("does not load the syntax runtime for unsupported or empty patches", async () => {
    const highlightSyntax = vi.fn();
    const { highlightFile, workerCount } = await loadFacade(highlightSyntax);

    await expect(highlightFile(file("example.unknown"))).resolves.toBeNull();
    await expect(highlightFile(file("example.ts"))).resolves.toEqual({
      hunks: [],
      language: "typescript",
    } satisfies HighlightedFile);
    expect(highlightSyntax).not.toHaveBeenCalled();
    expect(workerCount()).toBe(0);
  });
});

describe("syntax worker scheduling", () => {
  it("runs one file at a time and removes cancelled active or queued work", async () => {
    const first = deferred<void>();
    const calls: number[] = [];
    const responses: SyntaxHighlightResponse[] = [];
    let active = 0;
    let maximumActive = 0;
    const runtime = createSyntaxWorkerRuntime(
      async (request) => {
        calls.push(request.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (request.id === 1) await first.promise;
        active -= 1;
        return { hunks: [], language: request.language };
      },
      (response) => responses.push(response),
    );

    for (let id = 1; id <= 50; id += 1) {
      runtime.receive({
        hunks: [],
        id,
        kind: "highlight",
        language: "typescript",
      });
    }
    await vi.waitFor(() => expect(calls).toEqual([1]));

    for (let id = 1; id < 50; id += 1) {
      runtime.receive({ id, kind: "cancel" });
    }
    first.resolve();

    await vi.waitFor(() => expect(responses.map(({ id }) => id)).toEqual([50]));
    expect(calls).toEqual([1, 50]);
    expect(maximumActive).toBe(1);
  });
});

describe("syntax engine", () => {
  it("uses the real Shiki core to emit exact light and dark token content", async () => {
    vi.resetModules();
    vi.doUnmock("@shikijs/core");
    vi.doUnmock("@shikijs/engine-javascript");
    const { highlightSyntax } = await import("./syntax-engine");
    const source = "const answer: number = 42;";

    const lines = await highlightSyntax(source, "typescript");

    expect(lines).toHaveLength(1);
    expect(lines[0]?.map(({ content }) => content).join("")).toBe(source);
    expect(
      lines[0]?.every(
        ({ darkForeground, lightForeground }) =>
          /^(?:#[0-9a-f]{6,8}|inherit)$/i.test(darkForeground) &&
          /^(?:#[0-9a-f]{6,8}|inherit)$/i.test(lightForeground),
      ),
    ).toBe(true);
  });

  it("creates one highlighter and deduplicates concurrent language loading", async () => {
    const loadLanguage = vi.fn(
      async (..._languages: unknown[]): Promise<void> => undefined,
    );
    const codeToTokensWithThemes = vi.fn(() => [
      [
        {
          content: "const",
          offset: 0,
          variants: {
            dark: { color: "#dark", fontStyle: 3 },
            light: { color: "#light", fontStyle: 0 },
          },
        },
      ],
    ]);
    const createHighlighterCore = vi.fn(async () => ({
      codeToTokensWithThemes,
      loadLanguage,
    }));
    vi.resetModules();
    vi.doMock("@shikijs/core", () => ({ createHighlighterCore }));
    vi.doMock("@shikijs/engine-javascript", () => ({
      createJavaScriptRegexEngine: vi.fn(() => "engine"),
    }));
    const { highlightSyntax } = await import("./syntax-engine");

    const [first, second] = await Promise.all([
      highlightSyntax("const", "typescript"),
      highlightSyntax("const", "typescript"),
    ]);

    expect(createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(loadLanguage).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toEqual([
      [
        {
          content: "const",
          darkFontStyle: "italic",
          darkFontWeight: 700,
          darkForeground: "#dark",
          lightFontStyle: "normal",
          lightFontWeight: 400,
          lightForeground: "#light",
        },
      ],
    ]);

    await highlightSyntax("const", "javascript");
    expect(createHighlighterCore).toHaveBeenCalledTimes(1);
    expect(loadLanguage).toHaveBeenCalledTimes(2);
  });

  it("evicts rejected language loads so they can be retried", async () => {
    const loadLanguage = vi
      .fn<(...languages: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("language failed"))
      .mockResolvedValueOnce(undefined);
    const createHighlighterCore = vi.fn(async () => ({
      codeToTokensWithThemes: () => [
        [
          {
            content: "puts",
            offset: 0,
            variants: {
              dark: { color: "#dark" },
              light: { color: "#light" },
            },
          },
        ],
      ],
      loadLanguage,
    }));
    vi.resetModules();
    vi.doMock("@shikijs/core", () => ({ createHighlighterCore }));
    vi.doMock("@shikijs/engine-javascript", () => ({
      createJavaScriptRegexEngine: vi.fn(() => "engine"),
    }));
    const { highlightSyntax } = await import("./syntax-engine");

    await expect(highlightSyntax("puts", "ruby")).rejects.toThrow(
      "language failed",
    );
    await expect(highlightSyntax("puts", "ruby")).resolves.toHaveLength(1);
    expect(loadLanguage).toHaveBeenCalledTimes(2);
  });
});
