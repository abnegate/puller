import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { API as TypeScriptAPI } from "typescript/unstable/sync";
import * as TypeScript from "typescript/unstable/ast";

const SCRIPT =
  /(?:^|[-_:])(e2e|integration|probe|smoke|spec|test|verify)(?:$|[-_:])/i;
const HARNESS =
  /(?:^|[/_.-])(e2e|fixture|fixtures|helper|helpers|integration|probe|setup|smoke|spec|test|tests|verify|verification)(?:[/_.-]|$)/i;
const SAFE_PATH = /^[A-Za-z0-9_@+.,/=-]+$/;
const CONFIGURATIONS = Object.freeze([
  "babel.config.cjs",
  "babel.config.js",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "package-lock.json",
  "package.json",
  "phpunit.xml",
  "phpunit.xml.dist",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "pytest.ini",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.ts",
  "yarn.lock",
]);
const EXTENSIONS = Object.freeze(["", ".mjs"]);
const PHPUNIT = Object.freeze(["vendor/bin/phpunit", "./vendor/bin/phpunit"]);
const PHP_RUNTIME_OPTIONS = Object.freeze([
  "-d",
  "allow_url_fopen=0",
  "-d",
  "allow_url_include=0",
  "-d",
  "ffi.enable=false",
  "-d",
  "phar.readonly=1",
  "-d",
  [
    "disable_functions=",
    "dl",
    "exec",
    "passthru",
    "pcntl_exec",
    "pcntl_fork",
    "popen",
    "proc_close",
    "proc_get_status",
    "proc_nice",
    "proc_open",
    "posix_kill",
    "shell_exec",
    "system",
  ].join(","),
]);
const PHP_CONFIGURATION = Object.freeze(["phpunit.xml", "phpunit.xml.dist"]);
const PHP_FILE = /\.php$/i;
const PHPUNIT_SOURCE = /(?:^|\\)PHPUnit(?:\\|$)|\bTestCase\b/;
const SAFE_NODE_BUILTIN = /^(?:node:)?assert(?:\/strict)?$/;
const DANGEROUS_IDENTIFIERS = new Set([
  "Bun",
  "Deno",
  "Function",
  "WebAssembly",
  "child_process",
  "createRequire",
  "eval",
  "fetch",
  "fs",
  "globalThis",
  "module",
  "process",
  "require",
]);
const ASSERTIONS = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "doesNotReject",
  "doesNotThrow",
  "equal",
  "fail",
  "ifError",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "ok",
  "rejects",
  "strictEqual",
  "throws",
]);

function inside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
  );
}

function safePath(path) {
  return (
    typeof path === "string" &&
    path !== "" &&
    SAFE_PATH.test(path) &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function targetPaths(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const paths = new Set();
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      !safePath(file.path) ||
      !["added", "modified", "removed"].includes(file.status) ||
      paths.has(file.path)
    ) {
      return null;
    }
    paths.add(file.path);
  }
  return paths;
}

function digest(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolveDigest(hash.digest("hex")));
  });
}

async function canonicalRoot(path) {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    const details = await lstat(path);
    if (
      canonical !== resolve(path) ||
      details.isSymbolicLink() ||
      !details.isDirectory()
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

async function discoveredRecipes(root) {
  const recipes = [];
  const pending = [{ path: root, prefix: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const directories = [];
    for (const entry of entries) {
      const path =
        current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
      const target = join(current.path, entry.name);
      let details;
      try {
        details = await lstat(target);
      } catch {
        return null;
      }
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) {
        let canonical;
        try {
          canonical = await realpath(target);
        } catch {
          return null;
        }
        if (!inside(root, canonical) || canonical !== resolve(target)) {
          return null;
        }
        directories.push({ path: canonical, prefix: path });
        continue;
      }
      if (
        details.isFile() &&
        extname(path) === ".mjs" &&
        HARNESS.test(path) &&
        (await fileProof(root, path)) !== null
      ) {
        recipes.push(
          Object.freeze({
            kind: "tool",
            name: "node",
            sourcePath: path,
          }),
        );
      } else if (
        details.isFile() &&
        PHP_FILE.test(path) &&
        /(?:Test|Spec)\.php$/i.test(path) &&
        HARNESS.test(path) &&
        (await fileProof(root, path)) !== null
      ) {
        recipes.push(
          Object.freeze({
            kind: "tool",
            name: "phpunit",
            sourcePath: path,
          }),
        );
      }
    }
    for (const directory of directories.reverse()) pending.push(directory);
  }
  return Object.freeze(
    recipes.sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    ),
  );
}

async function fileProof(root, path) {
  if (!safePath(path)) return null;
  const canonical = await canonicalRoot(root);
  if (canonical === null) return null;
  let current = canonical;
  try {
    for (const part of path.split("/")) {
      current = join(current, part);
      const details = await lstat(current);
      if (details.isSymbolicLink()) return null;
    }
    const details = await lstat(current);
    const target = await realpath(current);
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      !inside(canonical, target)
    ) {
      return null;
    }
    return Object.freeze({
      digest: await digest(target),
      mode: details.mode & 0o7777,
      path: target,
      size: details.size,
    });
  } catch {
    return null;
  }
}

function equalProof(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.digest === right.digest &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

async function proofs(roots, path) {
  const [release, predecessor, releaseExecution, predecessorExecution] =
    await Promise.all([
      fileProof(roots.releaseSnapshot, path),
      fileProof(roots.predecessorSnapshot, path),
      fileProof(roots.releaseRoot, path),
      fileProof(roots.predecessorRoot, path),
    ]);
  return { predecessor, predecessorExecution, release, releaseExecution };
}

async function identicalAcross(roots, path) {
  const value = await proofs(roots, path);
  return (
    equalProof(value.release, value.predecessor) &&
    equalProof(value.release, value.releaseExecution) &&
    equalProof(value.predecessor, value.predecessorExecution)
  );
}

function words(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > 16 * 1024 ||
    /[\u0000\r\n;&|><$`(){}*?!]/.test(value)
  ) {
    return null;
  }
  const result = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current !== "") {
        result.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote !== null) return null;
  if (current !== "") result.push(current);
  return result.length > 0 && result.every((word) => SAFE_PATH.test(word))
    ? result
    : null;
}

function safeIdentifier(identifier, file) {
  if (!TypeScript.isIdentifier(identifier)) return false;
  const name = String(identifier.text);
  return (
    !DANGEROUS_IDENTIFIERS.has(name) && !identifier.getText(file).includes("\\")
  );
}

function safePropertyName(name, file) {
  if (TypeScript.isIdentifier(name)) {
    return (
      safeIdentifier(name, file) &&
      !["__proto__", "constructor", "prototype"].includes(String(name.text))
    );
  }
  return (
    TypeScript.isStringLiteral(name) &&
    !["__proto__", "constructor", "prototype"].includes(String(name.text))
  );
}

function safeParameters(parameters, file, bindings) {
  for (const parameter of parameters) {
    if (
      parameter.dotDotDotToken ||
      parameter.initializer ||
      !safeIdentifier(parameter.name, file)
    ) {
      return null;
    }
    bindings.add(String(parameter.name.text));
  }
  return bindings;
}

function safeFunction(node, file, context) {
  if (
    node.asteriskToken ||
    node.questionToken ||
    !node.body ||
    node.modifiers?.some(
      (modifier) =>
        ![
          TypeScript.SyntaxKind.DefaultKeyword,
          TypeScript.SyntaxKind.ExportKeyword,
        ].includes(modifier.kind),
    )
  ) {
    return false;
  }
  const bindings = safeParameters(
    node.parameters,
    file,
    new Set(context.bindings),
  );
  if (bindings === null) return false;
  const nested = { ...context, bindings };
  return TypeScript.isBlock(node.body)
    ? safeStatements(node.body.statements, file, nested, false)
    : safeExpression(node.body, file, nested);
}

function safeCall(node, file, context) {
  if (node.questionDotToken || (node.typeArguments?.length ?? 0) !== 0) {
    return false;
  }
  let callable = false;
  if (TypeScript.isIdentifier(node.expression)) {
    const name = String(node.expression.text);
    callable =
      safeIdentifier(node.expression, file) &&
      (context.bindings.has(name) ||
        context.assertionFunctions.has(name) ||
        context.assertionObjects.has(name));
  } else if (
    TypeScript.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    TypeScript.isIdentifier(node.expression.expression) &&
    safeIdentifier(node.expression.expression, file) &&
    safeIdentifier(node.expression.name, file)
  ) {
    callable =
      context.assertionObjects.has(String(node.expression.expression.text)) &&
      ASSERTIONS.has(String(node.expression.name.text));
  }
  return (
    callable &&
    node.arguments.every(
      (argument) =>
        !TypeScript.isSpreadElement(argument) &&
        safeExpression(argument, file, context),
    )
  );
}

function safeExpression(node, file, context) {
  if (
    TypeScript.isStringLiteral(node) ||
    TypeScript.isNumericLiteral(node) ||
    [
      TypeScript.SyntaxKind.FalseKeyword,
      TypeScript.SyntaxKind.NullKeyword,
      TypeScript.SyntaxKind.TrueKeyword,
    ].includes(node.kind)
  ) {
    return true;
  }
  if (TypeScript.isIdentifier(node)) {
    return (
      safeIdentifier(node, file) && context.bindings.has(String(node.text))
    );
  }
  if (TypeScript.isParenthesizedExpression(node)) {
    return safeExpression(node.expression, file, context);
  }
  if (TypeScript.isArrayLiteralExpression(node)) {
    return node.elements.every(
      (element) =>
        !TypeScript.isSpreadElement(element) &&
        safeExpression(element, file, context),
    );
  }
  if (TypeScript.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (TypeScript.isPropertyAssignment(property)) {
        return (
          safePropertyName(property.name, file) &&
          safeExpression(property.initializer, file, context)
        );
      }
      return (
        TypeScript.isShorthandPropertyAssignment(property) &&
        !property.objectAssignmentInitializer &&
        safeIdentifier(property.name, file) &&
        context.bindings.has(String(property.name.text))
      );
    });
  }
  if (TypeScript.isPrefixUnaryExpression(node)) {
    return (
      [
        TypeScript.SyntaxKind.ExclamationToken,
        TypeScript.SyntaxKind.MinusToken,
        TypeScript.SyntaxKind.PlusToken,
      ].includes(node.operator) && safeExpression(node.operand, file, context)
    );
  }
  if (TypeScript.isCallExpression(node)) {
    return safeCall(node, file, context);
  }
  if (
    TypeScript.isArrowFunction(node) ||
    TypeScript.isFunctionExpression(node)
  ) {
    return safeFunction(node, file, context);
  }
  return false;
}

function safeVariableStatement(statement, file, context) {
  if (
    statement.modifiers?.some(
      (modifier) => modifier.kind !== TypeScript.SyntaxKind.ExportKeyword,
    )
  ) {
    return false;
  }
  return statement.declarationList.declarations.every(
    (declaration) =>
      safeIdentifier(declaration.name, file) &&
      declaration.initializer !== undefined &&
      safeExpression(declaration.initializer, file, context),
  );
}

function safeStatements(statements, file, context, topLevel) {
  for (const statement of statements) {
    if (TypeScript.isVariableStatement(statement)) {
      if (!safeVariableStatement(statement, file, context)) return false;
      continue;
    }
    if (TypeScript.isFunctionDeclaration(statement)) {
      if (
        !statement.name ||
        !safeIdentifier(statement.name, file) ||
        !safeFunction(statement, file, context)
      ) {
        return false;
      }
      continue;
    }
    if (TypeScript.isExpressionStatement(statement)) {
      if (
        !TypeScript.isCallExpression(statement.expression) ||
        !safeCall(statement.expression, file, context)
      ) {
        return false;
      }
      continue;
    }
    if (!topLevel && TypeScript.isReturnStatement(statement)) {
      if (
        statement.expression !== undefined &&
        !safeExpression(statement.expression, file, context)
      ) {
        return false;
      }
      continue;
    }
    if (topLevel && TypeScript.isImportDeclaration(statement)) continue;
    return false;
  }
  return true;
}

function collectImports(file) {
  const imports = [];
  const bindings = new Set();
  const assertionFunctions = new Set();
  const assertionObjects = new Set();
  for (const statement of file.statements) {
    if (TypeScript.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!safeIdentifier(declaration.name, file)) return null;
        bindings.add(String(declaration.name.text));
      }
      continue;
    }
    if (TypeScript.isFunctionDeclaration(statement)) {
      if (!statement.name || !safeIdentifier(statement.name, file)) {
        return null;
      }
      bindings.add(String(statement.name.text));
      continue;
    }
    if (!TypeScript.isImportDeclaration(statement)) continue;
    if (
      statement.attributes ||
      !TypeScript.isStringLiteral(statement.moduleSpecifier)
    ) {
      return null;
    }
    const specifier = String(statement.moduleSpecifier.text);
    const builtin = SAFE_NODE_BUILTIN.test(specifier);
    if (!builtin && !specifier.startsWith(".")) return null;
    if (!builtin) imports.push(specifier);
    const clause = statement.importClause;
    if (clause === undefined) {
      if (builtin) return null;
      continue;
    }
    if (clause.isTypeOnly) return null;
    if (clause.name) {
      if (!safeIdentifier(clause.name, file)) return null;
      const name = String(clause.name.text);
      if (builtin) assertionObjects.add(name);
      else bindings.add(name);
    }
    if (!clause.namedBindings) continue;
    if (
      TypeScript.isNamespaceImport(clause.namedBindings) ||
      !TypeScript.isNamedImports(clause.namedBindings)
    ) {
      return null;
    }
    for (const element of clause.namedBindings.elements) {
      if (
        element.isTypeOnly ||
        !safeIdentifier(element.name, file) ||
        (element.propertyName && !safeIdentifier(element.propertyName, file))
      ) {
        return null;
      }
      const imported = String(element.propertyName?.text ?? element.name.text);
      const local = String(element.name.text);
      if (builtin) {
        if (!ASSERTIONS.has(imported)) return null;
        assertionFunctions.add(local);
      } else {
        bindings.add(local);
      }
    }
  }
  return { assertionFunctions, assertionObjects, bindings, imports };
}

function analyzeJavaScript(file) {
  const context = collectImports(file);
  if (
    context === null ||
    !safeStatements(file.statements, file, context, true)
  ) {
    return null;
  }
  return context.imports;
}

async function createJavaScriptParser() {
  const root = await mkdtemp(join(tmpdir(), "puller-verification-parser-"));
  const api = new TypeScriptAPI({ cwd: root });
  const cache = new Map();
  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) return;
      closed = true;
      api.close();
      await rm(root, { force: true, recursive: true });
    },
    async imports(source) {
      if (closed) return null;
      const key = createHash("sha256").update(source).digest("hex");
      if (cache.has(key)) return cache.get(key);
      const path = join(root, `${key}.mjs`);
      await writeFile(path, source, { flag: "wx", mode: 0o400 }).catch(
        async (error) => {
          if (error?.code !== "EEXIST") throw error;
        },
      );
      const snapshot = api.updateSnapshot({ openFiles: [path] });
      try {
        const project = snapshot.getDefaultProjectForFile(path);
        const file = project?.program.getSourceFile(path);
        const value =
          file && project.program.getSyntacticDiagnostics(path).length === 0
            ? analyzeJavaScript(file)
            : null;
        cache.set(key, value);
        return value;
      } finally {
        snapshot.dispose();
      }
    },
  });
}

function normalizeImport(source, specifier) {
  if (!specifier.startsWith(".")) return null;
  const value = resolve(dirname(source), specifier);
  const path = relative(".", value).replaceAll("\\", "/");
  return safePath(path) ? path : null;
}

async function resolveImport(root, source, specifier) {
  const normalized = normalizeImport(source, specifier);
  if (normalized === null) return null;
  for (const extension of EXTENSIONS) {
    const candidate = `${normalized}${extension}`;
    if ((await fileProof(root, candidate)) !== null) return candidate;
  }
  for (const extension of EXTENSIONS.slice(1)) {
    const candidate = `${normalized}/index${extension}`;
    if ((await fileProof(root, candidate)) !== null) return candidate;
  }
  return null;
}

async function staticImports(root, path, parser) {
  let source;
  try {
    source = await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) return null;
  const extension = extname(path).toLowerCase();
  return extension === ".mjs" ? parser.imports(source) : null;
}

async function phaseGraph(root, entrypoint, parser) {
  const pending = [entrypoint];
  const files = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (files.has(path)) continue;
    if ((await fileProof(root, path)) === null) return null;
    files.add(path);
    const imports = await staticImports(root, path, parser);
    if (imports === null) return null;
    for (const specifier of imports) {
      const dependency = await resolveImport(root, path, specifier);
      if (dependency === null) return null;
      pending.push(dependency);
    }
  }
  return files;
}

async function harnessClosure(roots, entrypoint, parser) {
  if (
    !HARNESS.test(entrypoint) ||
    !(await identicalAcross(roots, entrypoint))
  ) {
    return null;
  }
  const releaseFiles = await phaseGraph(
    roots.releaseSnapshot,
    entrypoint,
    parser,
  );
  const predecessorFiles = await phaseGraph(
    roots.predecessorSnapshot,
    entrypoint,
    parser,
  );
  if (releaseFiles === null || predecessorFiles === null) return null;
  const union = new Set([...releaseFiles, ...predecessorFiles]);
  const product = new Set();
  const harness = new Set();
  for (const path of union) {
    if (HARNESS.test(path)) {
      if (!(await identicalAcross(roots, path))) return null;
      harness.add(path);
      continue;
    }
    const value = await proofs(roots, path);
    if (
      (value.release !== null &&
        !equalProof(value.release, value.releaseExecution)) ||
      (value.predecessor !== null &&
        !equalProof(value.predecessor, value.predecessorExecution))
    ) {
      return null;
    }
    if (!equalProof(value.release, value.predecessor)) product.add(path);
  }
  if (product.size === 0) return null;
  return Object.freeze({
    files: Object.freeze({
      predecessor: Object.freeze([...predecessorFiles].sort()),
      release: Object.freeze([...releaseFiles].sort()),
    }),
    harness: Object.freeze([...harness].sort()),
    product: Object.freeze([...product].sort()),
  });
}

async function configurationClosure(roots, directory) {
  const files = new Set();
  let current = directory === "." ? "" : directory;
  while (true) {
    for (const name of CONFIGURATIONS) {
      const path = current === "" ? name : `${current}/${name}`;
      const value = await proofs(roots, path);
      if ((value.release === null) !== (value.predecessor === null))
        return null;
      if (value.release !== null) {
        if (
          !equalProof(value.release, value.predecessor) ||
          !equalProof(value.release, value.releaseExecution) ||
          !equalProof(value.predecessor, value.predecessorExecution)
        ) {
          return null;
        }
        files.add(path);
      }
    }
    if (current === "") break;
    const parent = dirname(current).replaceAll("\\", "/");
    current = parent === "." ? "" : parent;
  }
  return [...files].sort();
}

async function manifests(roots, recipe) {
  if (
    !safePath(recipe.manifestPath) ||
    !(await identicalAcross(roots, recipe.manifestPath))
  ) {
    return null;
  }
  const [releaseSource, predecessorSource] = await Promise.all([
    readFile(join(roots.releaseSnapshot, recipe.manifestPath), "utf8").catch(
      () => null,
    ),
    readFile(
      join(roots.predecessorSnapshot, recipe.manifestPath),
      "utf8",
    ).catch(() => null),
  ]);
  if (releaseSource === null || predecessorSource === null) return null;
  let release;
  let predecessor;
  try {
    release = JSON.parse(releaseSource);
    predecessor = JSON.parse(predecessorSource);
  } catch {
    return null;
  }
  const selected = release?.scripts?.[recipe.name];
  const previous = predecessor?.scripts?.[recipe.name];
  const before = release?.scripts?.[`pre${recipe.name}`];
  const after = release?.scripts?.[`post${recipe.name}`];
  if (
    typeof selected !== "string" ||
    selected !== previous ||
    before !== undefined ||
    after !== undefined
  ) {
    return null;
  }
  return words(selected);
}

async function executable(name, path) {
  const candidates =
    name === "node"
      ? [process.execPath]
      : String(path ?? "")
          .split(":")
          .filter(Boolean)
          .map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const details = await lstat(canonical);
      if (
        canonical !== resolve(canonical) ||
        !details.isFile() ||
        (details.mode & 0o111) === 0
      ) {
        continue;
      }
      return Object.freeze({
        device: details.dev,
        digest: await digest(canonical),
        inode: details.ino,
        mode: details.mode & 0o7777,
        path: canonical,
        size: details.size,
      });
    } catch {
      // Continue through the explicit minimal PATH.
    }
  }
  return null;
}

async function fileMap(root, prefix = "", pathPolicy = safePath) {
  const canonical = await canonicalRoot(root);
  if (canonical === null) return null;
  const files = new Map();
  const pending = [{ path: canonical, prefix }];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const directories = [];
    for (const entry of entries) {
      const path =
        current.prefix === "" ? entry.name : `${current.prefix}/${entry.name}`;
      if (!pathPolicy(path)) return null;
      const target = join(current.path, entry.name);
      let details;
      try {
        details = await lstat(target);
      } catch {
        return null;
      }
      if (details.isSymbolicLink()) return null;
      if (details.isDirectory()) {
        const directory = await realpath(target).catch(() => null);
        if (
          directory === null ||
          directory !== resolve(target) ||
          !inside(canonical, directory)
        ) {
          return null;
        }
        directories.push({ path: directory, prefix: path });
        continue;
      }
      if (!details.isFile() || details.nlink !== 1 || files.has(path)) {
        return null;
      }
      files.set(
        path,
        Object.freeze({
          digest: await digest(target),
          mode: details.mode & 0o7777,
          path: target,
          size: details.size,
        }),
      );
    }
    for (const directory of directories.reverse()) pending.push(directory);
  }
  return files;
}

function relativeBinding(path, proof, origin = "phase") {
  return Object.freeze({
    digest: proof.digest,
    mode: proof.mode,
    origin,
    path,
    size: proof.size,
  });
}

async function readJson(root, path) {
  const source = await readFile(join(root, path), "utf8").catch(() => null);
  if (source === null || Buffer.byteLength(source, "utf8") > 16 * 1024 * 1024) {
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function autoloadPaths(value) {
  const mappings = {};
  for (const field of ["autoload", "autoload-dev"]) {
    const configuration = value?.[field] ?? {};
    if (
      !configuration ||
      typeof configuration !== "object" ||
      Array.isArray(configuration) ||
      Object.keys(configuration).some(
        (name) => !["psr-0", "psr-4"].includes(name),
      )
    ) {
      return null;
    }
    for (const standard of ["psr-0", "psr-4"]) {
      const configured = configuration[standard] ?? {};
      if (
        !configured ||
        typeof configured !== "object" ||
        Array.isArray(configured)
      ) {
        return null;
      }
      for (const [prefix, raw] of Object.entries(configured)) {
        const paths = Array.isArray(raw) ? raw : [raw];
        if (
          typeof prefix !== "string" ||
          prefix === "" ||
          paths.length === 0 ||
          !paths.every(
            (path) =>
              typeof path === "string" && safePath(path.replace(/\/+$/, "")),
          )
        ) {
          return null;
        }
        const key = `${standard}:${prefix}`;
        mappings[key] = paths.map((path) => path.replace(/\/+$/, ""));
      }
    }
  }
  return mappings;
}

function phpPreload(mappings) {
  const encoded = Buffer.from(JSON.stringify(mappings), "utf8").toString(
    "base64",
  );
  return [
    "<?php",
    "declare(strict_types=1);",
    "$loader = require __DIR__ . '/../vendor/autoload.php';",
    `$mappings = json_decode(base64_decode('${encoded}', true), true, 32, JSON_THROW_ON_ERROR);`,
    "$root = dirname(__DIR__);",
    "foreach ($mappings as $key => $paths) {",
    "    [$standard, $prefix] = explode(':', $key, 2);",
    "    $resolved = array_map(static fn (string $path): string => $root . '/' . $path, $paths);",
    "    if ($standard === 'psr-4') {",
    "        $loader->addPsr4($prefix, $resolved, true);",
    "    } else {",
    "        $loader->add($prefix, $resolved, true);",
    "    }",
    "}",
    "",
  ].join("\n");
}

async function phpConfiguration(roots, directory, manifest) {
  const prefix = directory === "." ? "" : `${directory}/`;
  let configuration = null;
  for (const name of PHP_CONFIGURATION) {
    const path = `${prefix}${name}`;
    const value = await proofs(roots, path);
    if (value.release === null && value.predecessor === null) continue;
    if (
      !equalProof(value.release, value.predecessor) ||
      !equalProof(value.release, value.releaseExecution) ||
      !equalProof(value.predecessor, value.predecessorExecution)
    ) {
      return null;
    }
    configuration = path;
    break;
  }
  if (configuration === null) return null;
  const source = await readFile(
    join(roots.predecessorSnapshot, configuration),
    "utf8",
  ).catch(() => null);
  if (
    source === null ||
    Buffer.byteLength(source, "utf8") > 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY|<extensions?\b|<listeners?\b/i.test(source)
  ) {
    return null;
  }
  const bootstrap = /\bbootstrap\s*=\s*(["'])([^"']+)\1/i.exec(source)?.[2];
  const bootstrapPath =
    bootstrap === undefined
      ? null
      : directory === "."
        ? bootstrap
        : `${directory}/${bootstrap}`;
  if (
    bootstrapPath !== null &&
    (!safePath(bootstrapPath) || !(await identicalAcross(roots, bootstrapPath)))
  ) {
    return null;
  }
  const mappings = autoloadPaths(manifest);
  if (mappings === null) return null;
  return Object.freeze({
    bootstrap: bootstrapPath,
    path: configuration,
    preload: phpPreload(mappings),
  });
}

async function dependencyFor(roots, store, directory, environment) {
  const prefix = directory === "." ? "" : `${directory}/`;
  const [manifestProofs, lockProofs, manifest, manifestSource, lockSource] =
    await Promise.all([
      proofs(roots, `${prefix}composer.json`),
      proofs(roots, `${prefix}composer.lock`),
      readJson(roots.predecessorSnapshot, `${prefix}composer.json`),
      readFile(
        join(roots.predecessorSnapshot, `${prefix}composer.json`),
        "utf8",
      ).catch(() => null),
      readFile(
        join(roots.predecessorSnapshot, `${prefix}composer.lock`),
        "utf8",
      ).catch(() => null),
    ]);
  if (
    manifest === null ||
    manifestSource === null ||
    lockSource === null ||
    !equalProof(manifestProofs.release, manifestProofs.predecessor) ||
    !equalProof(manifestProofs.release, manifestProofs.releaseExecution) ||
    !equalProof(
      manifestProofs.predecessor,
      manifestProofs.predecessorExecution,
    ) ||
    !equalProof(lockProofs.release, lockProofs.predecessor) ||
    !equalProof(lockProofs.release, lockProofs.releaseExecution) ||
    !equalProof(lockProofs.predecessor, lockProofs.predecessorExecution)
  ) {
    return null;
  }
  const dependency = await store
    ?.prepare({ environment, lockSource, manifestSource })
    .catch(() => null);
  if (
    dependency === null ||
    !Array.isArray(dependency?.files) ||
    typeof dependency.root !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    files: Object.freeze(
      dependency.files.map((proof) =>
        Object.freeze({ ...proof, origin: "dependency" }),
      ),
    ),
    phpunit: "phpunit/phpunit/phpunit",
    provenance: dependency,
    root: dependency.root,
  });
}

function phpTarget(path) {
  return PHP_FILE.test(path) && !HARNESS.test(path);
}

const GENERIC_PHP_SYMBOLS = new Set([
  "Action",
  "Create",
  "Delete",
  "Exception",
  "Get",
  "Http",
  "Index",
  "Init",
  "Update",
  "XList",
  "errors",
]);

function relevantPhpSource(source, targets) {
  return targets.some((path) => {
    const parts = path.split("/");
    const name = parts.at(-1).replace(/\.php$/i, "");
    const parent = parts.at(-2) ?? "";
    const namespace =
      parts[0] === "src"
        ? parts
            .slice(1)
            .join("\\")
            .replace(/\.php$/i, "")
        : null;
    if (namespace !== null && source.includes(namespace)) return true;
    if (GENERIC_PHP_SYMBOLS.has(name) || name.length < 8) return false;
    return (
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        source,
      ) &&
      (parent.length < 5 ||
        new RegExp(
          `\\b${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        ).test(source))
    );
  });
}

async function relevantDiscoveredRecipe(roots, recipe, targets) {
  if (recipe?.kind !== "tool" || recipe.name !== "phpunit") return true;
  if (
    !safePath(recipe.sourcePath) ||
    targets.has(recipe.sourcePath) ||
    !(await identicalAcross(roots, recipe.sourcePath))
  ) {
    return false;
  }
  const product = [...targets].filter(phpTarget);
  if (product.length === 0) return false;
  const source = await readFile(
    join(roots.predecessorSnapshot, recipe.sourcePath),
    "utf8",
  ).catch(() => null);
  return (
    source !== null &&
    Buffer.byteLength(source, "utf8") <= 4 * 1024 * 1024 &&
    PHPUNIT_SOURCE.test(source) &&
    relevantPhpSource(source, product)
  );
}

async function phpBindings(roots, targets, protectedPaths) {
  const [predecessor, release, predecessorExecution, releaseExecution] =
    await Promise.all([
      fileMap(roots.predecessorSnapshot),
      fileMap(roots.releaseSnapshot),
      fileMap(roots.predecessorRoot),
      fileMap(roots.releaseRoot),
    ]);
  if (
    predecessor === null ||
    release === null ||
    predecessorExecution === null ||
    releaseExecution === null
  ) {
    return null;
  }
  const paths = new Set([...predecessor.keys(), ...release.keys()]);
  if (
    [...paths].some((path) => path === "vendor" || path.startsWith("vendor/"))
  )
    return null;
  const changed = new Set();
  for (const path of paths) {
    const before = predecessor.get(path) ?? null;
    const after = release.get(path) ?? null;
    const beforeExecution = predecessorExecution.get(path) ?? null;
    const afterExecution = releaseExecution.get(path) ?? null;
    if (
      (before !== null && !equalProof(before, beforeExecution)) ||
      (after !== null && !equalProof(after, afterExecution))
    ) {
      return null;
    }
    if (!equalProof(before, after)) changed.add(path);
  }
  if ([...changed].some((path) => !targets.has(path))) return null;
  if ([...targets].some((path) => protectedPaths.has(path))) return null;
  const predecessorBindings = [];
  const releaseBindings = [];
  for (const path of [...paths].sort()) {
    const before = predecessor.get(path) ?? null;
    const after = release.get(path) ?? null;
    const targetHarness = targets.has(path) && HARNESS.test(path);
    if (targetHarness) continue;
    const protectedFile = HARNESS.test(path) || protectedPaths.has(path);
    if (protectedFile) {
      if (before === null) continue;
      const binding = relativeBinding(path, before, "predecessor");
      predecessorBindings.push(binding);
      releaseBindings.push(binding);
      continue;
    }
    if (before !== null)
      predecessorBindings.push(relativeBinding(path, before));
    if (after !== null) releaseBindings.push(relativeBinding(path, after));
  }
  return Object.freeze({
    predecessor: Object.freeze(predecessorBindings),
    release: Object.freeze(releaseBindings),
  });
}

function composerPhpunitScript(words) {
  return (
    Array.isArray(words) && words.length === 1 && PHPUNIT.includes(words[0])
  );
}

function directInvocation(recipe, scriptWords = null) {
  const values =
    scriptWords ??
    (recipe.kind === "tool" ? [recipe.name, recipe.sourcePath] : null);
  if (!Array.isArray(values) || values.length !== 2) return null;
  const [runtime, entrypoint] = values;
  if (
    runtime !== "node" ||
    !safePath(entrypoint) ||
    !HARNESS.test(entrypoint) ||
    extname(entrypoint) !== ".mjs"
  ) {
    return null;
  }
  return { entrypoint, runtime };
}

async function phpDirectory(roots, sourcePath) {
  let current = dirname(sourcePath).replaceAll("\\", "/");
  while (true) {
    const directory = current === "." ? "." : current;
    const manifest =
      directory === "." ? "composer.json" : `${directory}/composer.json`;
    if ((await fileProof(roots.predecessorSnapshot, manifest)) !== null) {
      return directory;
    }
    if (directory === ".") return null;
    const parent = dirname(directory).replaceAll("\\", "/");
    current = parent === "." ? "." : parent;
  }
}

async function phpPlan({
  canonical,
  contexts,
  dependencyStore,
  environment,
  recipe,
  scriptWords,
  targets,
}) {
  if (recipe.kind === "tool" && !["php", "phpunit"].includes(recipe.name)) {
    return null;
  }
  if (
    recipe.kind === "script" &&
    (!recipe.manifestPath.endsWith("composer.json") ||
      !composerPhpunitScript(scriptWords))
  ) {
    return null;
  }
  const directory =
    recipe.kind === "script"
      ? dirname(recipe.manifestPath).replaceAll("\\", "/")
      : await phpDirectory(canonical, recipe.sourcePath);
  if (directory === null) return null;
  const normalizedDirectory = directory === "." ? "." : directory;
  const prefix = normalizedDirectory === "." ? "" : `${normalizedDirectory}/`;
  const product = [...targets].filter(phpTarget).sort();
  if (product.length === 0) return null;
  if (recipe.kind === "tool") {
    if (
      !safePath(recipe.sourcePath) ||
      !PHP_FILE.test(recipe.sourcePath) ||
      !HARNESS.test(recipe.sourcePath) ||
      targets.has(recipe.sourcePath) ||
      !(await identicalAcross(canonical, recipe.sourcePath))
    ) {
      return null;
    }
    const source = await readFile(
      join(canonical.predecessorSnapshot, recipe.sourcePath),
      "utf8",
    ).catch(() => null);
    if (
      source === null ||
      Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024 ||
      !relevantPhpSource(source, product) ||
      (recipe.name === "phpunit" && !PHPUNIT_SOURCE.test(source))
    ) {
      return null;
    }
  }
  if (!contexts.has(normalizedDirectory)) {
    const manifest = await readJson(
      canonical.predecessorSnapshot,
      `${prefix}composer.json`,
    );
    const configuration =
      manifest === null
        ? null
        : await phpConfiguration(canonical, normalizedDirectory, manifest);
    const dependency =
      configuration === null
        ? null
        : await dependencyFor(
            canonical,
            dependencyStore,
            normalizedDirectory,
            environment,
          );
    const configurationFiles =
      dependency === null
        ? null
        : await configurationClosure(canonical, normalizedDirectory);
    const protectedPaths =
      configuration === null || configurationFiles === null
        ? null
        : new Set([
            ...configurationFiles,
            ...(configuration.bootstrap === null
              ? []
              : [configuration.bootstrap]),
          ]);
    const phaseBindings =
      protectedPaths === null
        ? null
        : await phpBindings(canonical, targets, protectedPaths);
    const php = await executable("php", environment.PATH);
    const relativeConfiguration =
      configuration === null
        ? null
        : relative(normalizedDirectory, configuration.path).replaceAll(
            "\\",
            "/",
          );
    contexts.set(
      normalizedDirectory,
      manifest === null ||
        configuration === null ||
        dependency === null ||
        dependency.root === null ||
        phaseBindings === null ||
        php === null ||
        !safePath(relativeConfiguration)
        ? null
        : Object.freeze({
            configuration,
            dependency,
            phaseBindings,
            php,
            relativeConfiguration,
          }),
    );
  }
  const context = contexts.get(normalizedDirectory);
  if (context === null) return null;
  const {
    configuration,
    dependency,
    phaseBindings,
    php,
    relativeConfiguration,
  } = context;
  const source =
    recipe.kind === "tool"
      ? relative(normalizedDirectory, recipe.sourcePath).replaceAll("\\", "/")
      : null;
  if (source !== null && !safePath(source)) return null;
  const generatedPath = `${prefix}.puller/preload.php`;
  const linkPath = `${prefix}vendor`;
  const args = [
    ...PHP_RUNTIME_OPTIONS,
    "-d",
    "auto_prepend_file=.puller/preload.php",
    ...(recipe.kind === "tool" && recipe.name === "php"
      ? [source]
      : [
          `vendor/${dependency.phpunit}`,
          "--configuration",
          relativeConfiguration,
          "--colors=never",
          "--do-not-cache-result",
          "--no-coverage",
          "--no-logging",
          ...(source === null ? [] : [source]),
        ]),
  ];
  return Object.freeze({
    args: Object.freeze(args),
    bindings: phaseBindings,
    dependencies: Object.freeze([
      Object.freeze({
        files: dependency.files,
        provenance: dependency.provenance,
        root: dependency.root,
      }),
    ]),
    directory: normalizedDirectory,
    generated: Object.freeze([
      Object.freeze({
        content: configuration.preload,
        mode: 0o400,
        path: generatedPath,
      }),
    ]),
    harness: Object.freeze(
      phaseBindings.predecessor
        .filter(({ path }) => HARNESS.test(path))
        .map(({ path }) => path),
    ),
    links: Object.freeze([
      Object.freeze({
        path: linkPath,
        target: dependency.root,
      }),
    ]),
    product: Object.freeze(product),
    recipe: Object.freeze({ ...recipe }),
    runtime: php,
    tools: Object.freeze({
      phpunit: Object.freeze({
        ...dependency.files.find(({ path }) => path === dependency.phpunit),
        path: join(dependency.root, dependency.phpunit),
      }),
    }),
  });
}

async function bindings(root, files) {
  const values = [];
  for (const path of [...new Set(files)].sort()) {
    const proof = await fileProof(root, path);
    if (proof === null) return null;
    values.push(
      Object.freeze({
        digest: proof.digest,
        mode: proof.mode,
        path,
        size: proof.size,
      }),
    );
  }
  return Object.freeze(values);
}

export async function createVerificationPlan({
  claims,
  dependencyStore = null,
  discover = false,
  environment = process.env,
  recipes,
  roots,
  targetFiles,
} = {}) {
  const canonical = {};
  for (const [name, value] of Object.entries(roots ?? {})) {
    canonical[name] = await canonicalRoot(value);
    if (canonical[name] === null) {
      return Object.freeze({ outcome: "unavailable", reason: "unsafe_root" });
    }
  }
  if (
    !canonical.releaseRoot ||
    !canonical.releaseSnapshot ||
    !canonical.predecessorRoot ||
    !canonical.predecessorSnapshot
  ) {
    return Object.freeze({
      outcome: "unavailable",
      reason: "predecessor_unavailable",
    });
  }
  const targets = targetPaths(targetFiles);
  if (targets === null) {
    return Object.freeze({
      outcome: "unavailable",
      reason: "target_unavailable",
    });
  }
  let parser;
  try {
    parser = await createJavaScriptParser();
  } catch {
    return Object.freeze({
      outcome: "unavailable",
      reason: "harness_untrusted",
    });
  }
  try {
    const plans = [];
    const phpContexts = new Map();
    const discovered = discover
      ? await discoveredRecipes(canonical.predecessorSnapshot)
      : Object.freeze([]);
    if (discovered === null) {
      return Object.freeze({
        outcome: "unavailable",
        reason: "harness_untrusted",
      });
    }
    const nominated = Array.isArray(recipes) ? recipes : [];
    const nominatedKeys = new Set(
      nominated.map((value) => JSON.stringify(value)),
    );
    const discoveredCandidates = [];
    for (const recipe of discovered) {
      if (
        nominatedKeys.has(JSON.stringify(recipe)) ||
        (await relevantDiscoveredRecipe(canonical, recipe, targets))
      ) {
        discoveredCandidates.push(recipe);
      }
    }
    const candidates = [...nominated, ...discoveredCandidates]
      .filter(Boolean)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
      .filter(
        (recipe, index, values) =>
          index === 0 ||
          JSON.stringify(recipe) !== JSON.stringify(values[index - 1]),
      );
    for (const recipe of candidates) {
      if (
        !recipe ||
        !["script", "tool"].includes(recipe.kind) ||
        (recipe.kind === "script" &&
          (!SCRIPT.test(recipe.name) ||
            !["package.json", "composer.json"].some((name) =>
              recipe.manifestPath?.endsWith(name),
            ))) ||
        (recipe.kind === "tool" &&
          (typeof recipe.name !== "string" ||
            typeof recipe.sourcePath !== "string"))
      ) {
        continue;
      }
      const directory =
        recipe.kind === "script"
          ? dirname(recipe.manifestPath).replaceAll("\\", "/")
          : ".";
      const scriptWords =
        recipe.kind === "script" ? await manifests(canonical, recipe) : null;
      const php =
        (recipe.kind === "script" &&
          recipe.manifestPath.endsWith("composer.json")) ||
        (recipe.kind === "tool" && ["php", "phpunit"].includes(recipe.name));
      if (php) {
        const candidate = await phpPlan({
          canonical,
          contexts: phpContexts,
          dependencyStore,
          environment,
          recipe,
          scriptWords,
          targets,
        });
        if (candidate !== null) plans.push(candidate);
        continue;
      }
      const invocation = directInvocation(recipe, scriptWords);
      if (invocation === null) continue;
      const entrypoint =
        directory === "."
          ? invocation.entrypoint
          : `${directory}/${invocation.entrypoint}`;
      const configuration = await configurationClosure(canonical, directory);
      if (configuration === null) continue;
      const closure = await harnessClosure(canonical, entrypoint, parser);
      if (
        closure === null ||
        closure.product.some((path) => !targets.has(path))
      ) {
        continue;
      }
      const runtime = await executable(invocation.runtime, environment.PATH);
      if (runtime === null) continue;
      const [predecessorBindings, releaseBindings] = await Promise.all([
        bindings(canonical.predecessorRoot, [
          ...closure.files.predecessor,
          ...configuration,
        ]),
        bindings(canonical.releaseRoot, [
          ...closure.files.release,
          ...configuration,
        ]),
      ]);
      if (predecessorBindings === null || releaseBindings === null) continue;
      plans.push(
        Object.freeze({
          args: Object.freeze([invocation.entrypoint]),
          bindings: Object.freeze({
            predecessor: predecessorBindings,
            release: releaseBindings,
          }),
          directory,
          harness: closure.harness,
          product: closure.product,
          recipe: Object.freeze({ ...recipe }),
          runtime,
        }),
      );
    }
    return plans.length > 0
      ? Object.freeze({ outcome: "ready", plans: Object.freeze(plans) })
      : Object.freeze({ outcome: "unavailable", reason: "harness_untrusted" });
  } finally {
    await parser.close();
  }
}
