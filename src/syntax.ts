import type {
  SyntaxHighlightResponse,
  SyntaxWorkerRequest,
} from "./syntax-protocol";
import type { HighlightedFile, SyntaxLanguage } from "./syntax-types";
import type { PullDiffFile, PullDiffLine } from "./types";

export type {
  HighlightedDiffHunk,
  HighlightedDiffLine,
  HighlightedFile,
  SyntaxLanguage,
  SyntaxToken,
} from "./syntax-types";

const extensionLanguages: Readonly<Record<string, SyntaxLanguage>> = {
  bash: "shellscript",
  bashrc: "shellscript",
  c: "c",
  "c++": "cpp",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  dockerfile: "docker",
  gemspec: "ruby",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  "h++": "cpp",
  hcl: "hcl",
  hh: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  phtml: "php",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  py: "python",
  pyw: "python",
  rake: "ruby",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  tf: "hcl",
  tfvars: "hcl",
  ts: "typescript",
  tsx: "tsx",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
  zshrc: "shellscript",
};

const shebangLanguages: Readonly<Record<string, SyntaxLanguage>> = {
  bash: "shellscript",
  bun: "javascript",
  deno: "javascript",
  node: "javascript",
  nodejs: "javascript",
  php: "php",
  powershell: "powershell",
  pwsh: "powershell",
  ruby: "ruby",
  sh: "shellscript",
  zsh: "shellscript",
};

const filename = (path: string): string => path.split("/").at(-1) ?? path;

const extension = (name: string): string => {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
};

const fileLanguage = (path: string): SyntaxLanguage | null => {
  const name = filename(path);
  const lowerName = name.toLowerCase();

  if (
    lowerName === "dockerfile" ||
    lowerName.startsWith("dockerfile.") ||
    lowerName.endsWith(".dockerfile")
  ) {
    return "docker";
  }

  if (lowerName === "gemfile" || lowerName === "rakefile") {
    return "ruby";
  }

  return extensionLanguages[extension(lowerName)] ?? null;
};

const lineOne = (
  file: PullDiffFile,
  side: "new" | "old",
): PullDiffLine | null => {
  const key = side === "new" ? "newLine" : "oldLine";
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line[key] === 1) return line;
    }
  }
  return null;
};

const shebangLanguage = (content: string): SyntaxLanguage | null => {
  const match = /^#![ \t]*(\/[^ \t]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(content);
  if (!match) return null;

  let interpreter = filename(match[1]!).toLowerCase();
  if (interpreter === "env") {
    const arguments_ = (match[2] ?? "").trim().split(/[ \t]+/);
    if (arguments_[0] === "-S") arguments_.shift();
    const command = arguments_[0];
    if (command === undefined || command.startsWith("-")) return null;
    interpreter = filename(command).toLowerCase();
  }

  if (/^python(?:\d+(?:\.\d+)*)?$/.test(interpreter)) return "python";
  return shebangLanguages[interpreter] ?? null;
};

const relevantShebang = (file: PullDiffFile): string | null => {
  const preferred = file.status === "removed" ? "old" : "new";
  const line = lineOne(file, preferred);
  return line?.content ?? null;
};

export const detectSyntaxLanguage = (
  file: PullDiffFile,
): SyntaxLanguage | null => {
  const detected = fileLanguage(file.path);
  if (detected !== null) return detected;

  const shebang = relevantShebang(file);
  return shebang === null ? null : shebangLanguage(shebang);
};

type WorkerPending = {
  reject: (error: unknown) => void;
  resolve: (highlighted: HighlightedFile) => void;
};

type WorkerTask = {
  cancel: () => void;
  promise: Promise<HighlightedFile>;
};

type HighlightRecord = {
  cancel: (() => void) | null;
  promise: Promise<HighlightedFile | null>;
  references: number;
  retained: boolean;
  settled: boolean;
};

let nextRequest = 0;
let syntaxWorker: Worker | null = null;
const pending = new Map<number, WorkerPending>();
const highlighted = new WeakMap<PullDiffFile, HighlightRecord>();

const abortError = (): Error => {
  const error = new Error("Syntax highlighting was cancelled.");
  error.name = "AbortError";
  return error;
};

const rejectPending = (error: unknown): void => {
  const requests = [...pending.values()];
  pending.clear();
  for (const request of requests) request.reject(error);
};

const resetWorker = (error: unknown): void => {
  const worker = syntaxWorker;
  syntaxWorker = null;
  worker?.terminate();
  rejectPending(error);
};

const getWorker = (): Worker => {
  if (syntaxWorker !== null) return syntaxWorker;
  if (typeof Worker === "undefined") {
    throw new Error("Syntax highlighting requires Web Worker support.");
  }

  const worker = new Worker(new URL("./syntax-worker.ts", import.meta.url), {
    name: "puller-syntax",
    type: "module",
  });
  worker.onmessage = ({ data }: MessageEvent<SyntaxHighlightResponse>) => {
    const request = pending.get(data.id);
    if (request === undefined) return;
    pending.delete(data.id);
    if (data.kind === "error") request.reject(new Error(data.error));
    else request.resolve(data.highlighted);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    resetWorker(new Error(event.message || "The syntax worker failed."));
  };
  syntaxWorker = worker;
  return worker;
};

const post = (worker: Worker, message: SyntaxWorkerRequest): void => {
  worker.postMessage(message);
};

const startWorkerTask = (
  file: PullDiffFile,
  language: SyntaxLanguage,
): WorkerTask => {
  const worker = getWorker();
  const id = ++nextRequest;
  let rejectTask!: (error: unknown) => void;
  const promise = new Promise<HighlightedFile>((resolve, reject) => {
    rejectTask = reject;
    pending.set(id, { reject, resolve });
  });

  try {
    post(worker, { hunks: file.hunks, id, kind: "highlight", language });
  } catch (error) {
    pending.delete(id);
    rejectTask(error);
  }

  return {
    cancel: () => {
      const request = pending.get(id);
      if (request === undefined) return;
      pending.delete(id);
      request.reject(abortError());
      try {
        post(worker, { id, kind: "cancel" });
      } catch {
        resetWorker(new Error("The syntax worker could not be cancelled."));
      }
    },
    promise,
  };
};

const createRecord = (
  file: PullDiffFile,
  language: SyntaxLanguage | null,
): HighlightRecord => {
  if (language === null) {
    return {
      cancel: null,
      promise: Promise.resolve(null),
      references: 0,
      retained: false,
      settled: true,
    };
  }
  if (file.hunks.length === 0) {
    return {
      cancel: null,
      promise: Promise.resolve({ hunks: [], language }),
      references: 0,
      retained: false,
      settled: true,
    };
  }

  const task = startWorkerTask(file, language);
  const record: HighlightRecord = {
    cancel: task.cancel,
    promise: Promise.resolve(null),
    references: 0,
    retained: false,
    settled: false,
  };
  record.promise = task.promise.then(
    (result) => {
      record.settled = true;
      return result;
    },
    (error: unknown) => {
      record.settled = true;
      if (highlighted.get(file) === record) highlighted.delete(file);
      throw error;
    },
  );
  return record;
};

const cancelRecord = (file: PullDiffFile, record: HighlightRecord): void => {
  if (record.settled || record.retained || record.references > 0) return;
  if (highlighted.get(file) === record) highlighted.delete(file);
  record.cancel?.();
};

const withSignal = (
  file: PullDiffFile,
  record: HighlightRecord,
  signal: AbortSignal,
): Promise<HighlightedFile | null> => {
  if (signal.aborted) {
    cancelRecord(file, record);
    return Promise.reject(abortError());
  }

  record.references += 1;
  return new Promise((resolve, reject) => {
    let listening = true;
    const finish = (): boolean => {
      if (!listening) return false;
      listening = false;
      signal.removeEventListener("abort", abort);
      record.references -= 1;
      return true;
    };
    const abort = (): void => {
      if (!finish()) return;
      cancelRecord(file, record);
      reject(abortError());
    };

    signal.addEventListener("abort", abort, { once: true });
    void record.promise.then(
      (result) => {
        if (finish()) resolve(result);
      },
      (error: unknown) => {
        if (finish()) reject(error);
      },
    );
  });
};

export const highlightFile = (
  file: PullDiffFile,
  signal?: AbortSignal,
): Promise<HighlightedFile | null> => {
  if (signal?.aborted) return Promise.reject(abortError());

  let record = highlighted.get(file);
  if (record === undefined) {
    try {
      record = createRecord(file, detectSyntaxLanguage(file));
    } catch (error) {
      return Promise.reject(error);
    }
    highlighted.set(file, record);
  }

  if (signal !== undefined) return withSignal(file, record, signal);
  record.retained = true;
  return record.promise;
};
