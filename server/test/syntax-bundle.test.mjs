import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { build, createServer, resolveConfig } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const modules = (chunk) => Object.keys(chunk.modules);
const outputFor = (result) =>
  Array.isArray(result)
    ? result.flatMap((bundle) => bundle.output)
    : result.output;

const staticClosure = (chunks, start) => {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const visited = new Set();
  const visit = (chunk) => {
    if (visited.has(chunk.fileName)) return;
    visited.add(chunk.fileName);
    for (const imported of chunk.imports) {
      const dependency = byName.get(imported);
      if (dependency) visit(dependency);
    }
  };
  visit(start);
  return chunks.filter((chunk) => visited.has(chunk.fileName));
};

describe("syntax production bundle", () => {
  it("keeps every Shiki deep import outside the dev dependency optimizer", async () => {
    const exclusions = [
      "@shikijs/core",
      "@shikijs/engine-javascript",
      "@shikijs/langs",
      "@shikijs/themes",
    ];
    const config = await resolveConfig({ root }, "serve");
    expect(config.optimizeDeps.exclude).toEqual(
      expect.arrayContaining(exclusions),
    );

    const cacheDir = await mkdtemp(join(tmpdir(), "puller-syntax-vite-"));
    const server = await createServer({
      cacheDir,
      logLevel: "silent",
      root,
      server: { middlewareMode: true },
    });
    try {
      const transformed = await server.transformRequest(
        "/src/syntax-engine.ts",
      );
      expect(transformed).not.toBeNull();
      expect(transformed.code).toContain("/node_modules/.pnpm/@shikijs+core@");
      expect(transformed.code).toContain("/node_modules/.pnpm/@shikijs+langs@");
      expect(transformed.code).not.toContain(
        "/node_modules/.vite/deps/@shikijs",
      );
    } finally {
      await server.close();
      await rm(cacheDir, { force: true, recursive: true });
    }
  });

  it("keeps the worker lazy and every grammar outside its engine chunk", async () => {
    const applicationResult = await build({
      build: {
        minify: false,
        write: false,
      },
      logLevel: "silent",
      root,
    });
    const applicationOutput = outputFor(applicationResult);
    const applicationChunks = applicationOutput.filter(
      (item) => item.type === "chunk",
    );
    const entry = applicationChunks.find((chunk) => chunk.isEntry);
    const workerAsset = applicationOutput.find(
      (item) =>
        item.type === "asset" &&
        /^assets\/syntax-worker-.+\.js$/.test(item.fileName),
    );
    const grammarAssets = applicationOutput.filter(
      (item) =>
        item.type === "asset" &&
        /^assets\/(?:python|typescript)-.+\.js$/.test(item.fileName),
    );

    expect(entry).toBeDefined();
    expect(workerAsset).toBeDefined();
    expect(grammarAssets).toHaveLength(2);
    expect(new Set(grammarAssets.map(({ fileName }) => fileName)).size).toBe(2);

    const entryModules = modules(entry);
    expect(
      entryModules.some(
        (id) =>
          id.includes("/@shikijs/core/") ||
          id.includes("/@shikijs/engine-") ||
          id.includes("/@shikijs/langs/") ||
          id.includes("/@shikijs/themes/") ||
          id.endsWith("/src/syntax-engine.ts") ||
          id.endsWith("/src/syntax-worker.ts"),
      ),
    ).toBe(false);

    const workerResult = await build({
      build: {
        lib: {
          entry: join(root, "src/syntax-worker.ts"),
          formats: ["es"],
        },
        minify: false,
        write: false,
      },
      logLevel: "silent",
      root,
    });
    const workerChunks = outputFor(workerResult).filter(
      (item) => item.type === "chunk",
    );
    const engine = workerChunks.find((chunk) => chunk.isEntry);
    const typescript = workerChunks.find((chunk) =>
      modules(chunk).some((id) => id.endsWith("/langs/dist/typescript.mjs")),
    );
    const python = workerChunks.find((chunk) =>
      modules(chunk).some((id) => id.endsWith("/langs/dist/python.mjs")),
    );

    expect(engine).toBeDefined();
    expect(typescript).toBeDefined();
    expect(python).toBeDefined();
    expect(typescript.fileName).not.toBe(python.fileName);

    const engineModules = modules(engine);
    expect(engineModules.some((id) => id.includes("/@shikijs/core/"))).toBe(
      true,
    );
    expect(
      engineModules.some((id) => id.includes("/@shikijs/engine-javascript/")),
    ).toBe(true);
    expect(engineModules.some((id) => id.includes("/@shikijs/themes/"))).toBe(
      true,
    );
    expect(engineModules.some((id) => id.includes("/@shikijs/langs/"))).toBe(
      false,
    );
    expect(engine.dynamicImports).toContain(typescript.fileName);
    expect(engine.dynamicImports).toContain(python.fileName);

    const typescriptPath = staticClosure(workerChunks, typescript).flatMap(
      modules,
    );
    expect(
      typescriptPath.some((id) => id.endsWith("/langs/dist/typescript.mjs")),
    ).toBe(true);
    expect(
      typescriptPath.some((id) => id.endsWith("/langs/dist/python.mjs")),
    ).toBe(false);
    expect(
      modules(typescript).some((id) => id.endsWith("/langs/dist/python.mjs")),
    ).toBe(false);
  }, 30_000);

  it("uses CSS variables for a background-free light and dark token switch", async () => {
    const styles = await readFile(join(root, "src/styles.css"), "utf8");
    const light = /\[data-syntax-token\]\s*\{([^}]*)\}/.exec(styles)?.[1];
    const dark = /\.dark \[data-syntax-token\]\s*\{([^}]*)\}/.exec(styles)?.[1];

    expect(light).toContain("color: var(--syntax-light-foreground)");
    expect(light).toContain("font-style: var(--syntax-light-font-style)");
    expect(light).toContain("font-weight: var(--syntax-light-font-weight)");
    expect(light).not.toContain("background");
    expect(dark).toContain("color: var(--syntax-dark-foreground)");
    expect(dark).toContain("font-style: var(--syntax-dark-font-style)");
    expect(dark).toContain("font-weight: var(--syntax-dark-font-weight)");
    expect(dark).not.toContain("background");
  });
});
