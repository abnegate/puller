import { execFile as executeProcess } from "node:child_process";

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const API_STATUS_STDERR_LIMIT = 64 * 1024;
// Four concurrent commands cap captured stdout at 200 MiB when every caller
// uses the repository's 50 MiB GraphQL response ceiling.
export const DEFAULT_CONCURRENCY = 4;
const METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const NESTED_FIELDS = new Map([["tagger", new Set(["date", "email", "name"])]]);

const ERRORS = {
  api_rejected: {
    message: "GitHub rejected the API request.",
    status: 502,
  },
  failed: {
    message:
      "GitHub CLI could not complete the request. Check gh auth status and try again.",
    status: 502,
  },
  invalid_response: {
    message: "GitHub returned an unexpected response.",
    status: 502,
  },
  missing: {
    message: "GitHub CLI is not installed. Install gh, then run gh auth login.",
    status: 503,
  },
  output_limit: {
    message: "GitHub returned more data than this request can safely process.",
    status: 502,
  },
  timeout: {
    message:
      "The GitHub request timed out. Check your connection and try again.",
    status: 504,
  },
};

export class ExecutorError extends Error {
  constructor(code, apiStatus) {
    const detail = ERRORS[code] ?? ERRORS.failed;
    super(detail.message);
    this.name = "ExecutorError";
    this.code = code in ERRORS ? code : "failed";
    this.status = detail.status;
    if (
      this.code === "api_rejected" &&
      Number.isSafeInteger(apiStatus) &&
      apiStatus >= 400 &&
      apiStatus <= 599
    ) {
      this.apiStatus = apiStatus;
    }
  }
}

export const GithubExecutorError = ExecutorError;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function argumentsFor(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (argument) =>
        typeof argument !== "string" ||
        argument === "" ||
        argument.includes("\0"),
    )
  ) {
    throw new TypeError(
      "GitHub CLI arguments must be a non-empty array of safe strings.",
    );
  }
  return [...value];
}

function isOutputLimit(error) {
  return error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function optionalSignal(value) {
  if (value === undefined) return undefined;
  if (!isAbortSignal(value))
    throw new TypeError("signal must be an AbortSignal.");
  return value;
}

function createAdmission(limit) {
  let active = 0;
  const waiting = [];

  const releaseSlot = () => {
    active -= 1;
    while (active < limit && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.signal?.aborted) {
        entry.dispose();
        entry.reject(abortError(entry.signal));
        continue;
      }
      entry.dispose();
      active += 1;
      entry.resolve(createRelease());
    }
  };

  const createRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };

  return function acquire(signal) {
    if (signal?.aborted) throw abortError(signal);
    if (active < limit) {
      active += 1;
      return createRelease();
    }

    return new Promise((resolve, reject) => {
      const entry = {
        dispose: () => undefined,
        reject,
        resolve,
        signal,
      };
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index === -1) return;
        waiting.splice(index, 1);
        entry.dispose();
        reject(abortError(signal));
      };
      entry.dispose = () => signal?.removeEventListener("abort", abort);
      waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}

function apiStatus(stderr) {
  if (
    typeof stderr !== "string" ||
    Buffer.byteLength(stderr, "utf8") > API_STATUS_STDERR_LIMIT
  ) {
    return null;
  }

  const statuses = [];
  for (const line of stderr.split(/\r?\n/)) {
    const marker = line.match(
      /^gh: [^\u0000-\u001f\u007f]+ \(HTTP ([0-9]{3})\)$/u,
    );
    if (marker === null) {
      if (/\(HTTP [0-9]{3}\)/.test(line)) return null;
      continue;
    }
    if ((line.match(/\(HTTP [0-9]{3}\)/g) ?? []).length !== 1) return null;
    statuses.push(Number(marker[1]));
  }

  return statuses.length === 1 && statuses[0] >= 400 && statuses[0] <= 599
    ? statuses[0]
    : null;
}

function normalizeError(error, stderr, classifyApiRejection = false) {
  if (error instanceof ExecutorError) return error;
  if (error?.code === "ENOENT") return new ExecutorError("missing");
  if (error?.killed || error?.code === "ETIMEDOUT")
    return new ExecutorError("timeout");
  if (isOutputLimit(error)) return new ExecutorError("output_limit");
  if (classifyApiRejection) {
    const status = apiStatus(stderr);
    if (status !== null) return new ExecutorError("api_rejected", status);
  }
  return new ExecutorError("failed");
}

function fieldArguments(fields, raw = false) {
  if (!isRecord(fields)) {
    throw new TypeError("GitHub API fields must be an object.");
  }

  const argumentsList = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new TypeError("GitHub API field names must be safe identifiers.");
    }
    const nested = NESTED_FIELDS.get(name);
    if (isRecord(value)) {
      const entries = Object.entries(value);
      if (
        !nested ||
        entries.length !== nested.size ||
        entries.some(([child]) => !nested.has(child))
      ) {
        throw new TypeError("GitHub API nested fields are not allowed.");
      }
      for (const [child, item] of entries) {
        if (
          !["boolean", "number", "string"].includes(typeof item) ||
          String(item).includes("\0")
        ) {
          throw new TypeError(
            "GitHub API field values must be strings, numbers, or booleans.",
          );
        }
        argumentsList.push(
          raw || typeof item === "string" ? "-f" : "-F",
          `${name}[${child}]=${item}`,
        );
      }
      continue;
    }
    if (
      nested ||
      !["boolean", "number", "string"].includes(typeof value) ||
      String(value).includes("\0")
    ) {
      throw new TypeError(
        "GitHub API field values must be strings, numbers, or booleans.",
      );
    }
    argumentsList.push(
      raw || typeof value === "string" ? "-f" : "-F",
      `${name}=${value}`,
    );
  }
  return argumentsList;
}

function endpointFor(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("-") ||
    value.includes("\0") ||
    /:\/\//.test(value)
  ) {
    throw new TypeError("The GitHub API endpoint is invalid.");
  }
  return value;
}

export function createExecutor({
  concurrency = DEFAULT_CONCURRENCY,
  executeFile = executeProcess,
  environment = process.env,
  timeout = DEFAULT_TIMEOUT,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) {
  positiveInteger(concurrency, "concurrency");
  positiveInteger(timeout, "timeout");
  positiveInteger(maxBuffer, "maxBuffer");
  if (typeof executeFile !== "function")
    throw new TypeError("executeFile must be a function.");
  if (!isRecord(environment))
    throw new TypeError("environment must be an object.");

  const processEnvironment = {
    ...environment,
    GH_PROMPT_DISABLED: "1",
  };
  const acquire = createAdmission(concurrency);

  async function run(
    argumentsList,
    {
      classifyApiRejection = false,
      maxBuffer: rawMaxBuffer,
      signal: rawSignal,
    } = {},
  ) {
    const args = argumentsFor(argumentsList);
    const outputMaxBuffer = rawMaxBuffer ?? maxBuffer;
    positiveInteger(outputMaxBuffer, "maxBuffer");
    const signal = optionalSignal(rawSignal);
    if (signal?.aborted) throw abortError(signal);

    const admission = acquire(signal);
    const release =
      typeof admission === "function" ? admission : await admission;
    try {
      if (signal?.aborted) throw abortError(signal);

      const stdout = await new Promise((resolve, reject) => {
        const options = {
          encoding: "utf8",
          env: processEnvironment,
          maxBuffer: outputMaxBuffer,
          timeout,
          windowsHide: true,
        };
        if (signal) options.signal = signal;

        executeFile(
          "gh",
          args,
          options,
          (error, processStdout, processStderr) => {
            if (signal?.aborted) {
              reject(abortError(signal));
              return;
            }
            if (error) {
              reject(
                normalizeError(error, processStderr, classifyApiRejection),
              );
              return;
            }
            if (typeof processStdout !== "string") {
              reject(new ExecutorError("invalid_response"));
              return;
            }
            if (Buffer.byteLength(processStdout, "utf8") > outputMaxBuffer) {
              reject(new ExecutorError("output_limit"));
              return;
            }
            resolve(processStdout);
          },
        );
      });

      if (signal?.aborted) throw abortError(signal);
      return stdout;
    } finally {
      release();
    }
  }

  async function output(argumentsList, { maxBuffer, signal } = {}) {
    return run(argumentsList, { maxBuffer, signal });
  }

  function parse(stdout, validate) {
    let value;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new ExecutorError("invalid_response");
    }
    if (!validate(value)) throw new ExecutorError("invalid_response");
    return value;
  }

  async function json(
    argumentsList,
    { maxBuffer, signal, validate = isRecord } = {},
  ) {
    if (typeof validate !== "function")
      throw new TypeError("validate must be a function.");
    const stdout = await output(argumentsList, { maxBuffer, signal });
    return parse(stdout, validate);
  }

  async function action(argumentsList, { signal } = {}) {
    await output(argumentsList, { signal });
  }

  async function graphql(
    document,
    variables = {},
    { maxBuffer, signal, validate = isRecord } = {},
  ) {
    if (
      typeof document !== "string" ||
      document.trim() === "" ||
      document.includes("\0")
    ) {
      throw new TypeError("The GitHub GraphQL document is invalid.");
    }
    if (!isRecord(variables))
      throw new TypeError("GraphQL variables must be an object.");

    const args = ["api", "graphql", "-f", `query=${document}`];
    for (const [name, value] of Object.entries(variables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TypeError("GraphQL variable names must be safe identifiers.");
      }
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        if (
          value.some(
            (item) =>
              !["boolean", "number", "string"].includes(typeof item) ||
              String(item).includes("\0"),
          )
        ) {
          throw new TypeError(
            "GraphQL variable arrays must contain only scalar values.",
          );
        }
        if (value.length === 0) {
          args.push("-F", `${name}[]`);
          continue;
        }
        for (const item of value) {
          args.push(
            typeof item === "number" || typeof item === "boolean" ? "-F" : "-f",
            `${name}[]=${item}`,
          );
        }
        continue;
      }
      if (
        !["boolean", "number", "string"].includes(typeof value) ||
        String(value).includes("\0")
      ) {
        throw new TypeError("GraphQL variables must be scalar values.");
      }
      args.push(
        typeof value === "number" || typeof value === "boolean" ? "-F" : "-f",
        `${name}=${value}`,
      );
    }

    const payload = await json(args, {
      maxBuffer,
      signal,
      validate: (value) =>
        isRecord(value) &&
        (!Array.isArray(value.errors) || value.errors.length === 0) &&
        isRecord(value.data),
    });
    if (!validate(payload.data)) throw new ExecutorError("invalid_response");
    return payload.data;
  }

  async function rest(
    endpoint,
    {
      fields = {},
      method = "GET",
      paginate = false,
      rawFields = {},
      signal,
      slurp = false,
      validate = isRecord,
    } = {},
  ) {
    if (!METHODS.has(method))
      throw new TypeError("The GitHub API method is invalid.");
    if (typeof paginate !== "boolean" || typeof slurp !== "boolean") {
      throw new TypeError("GitHub API pagination options must be booleans.");
    }
    if (slurp && !paginate) throw new TypeError("Slurp requires pagination.");

    const args = ["api", endpointFor(endpoint), "--method", method];
    if (paginate) args.push("--paginate");
    if (slurp) args.push("--slurp");
    args.push(...fieldArguments(fields), ...fieldArguments(rawFields, true));
    if (typeof validate !== "function")
      throw new TypeError("validate must be a function.");
    const stdout = await run(args, { classifyApiRejection: true, signal });
    return parse(stdout, validate);
  }

  return Object.freeze({
    action,
    executeAction: action,
    executeJson: json,
    graphql,
    json,
    output,
    rest,
  });
}

export const createGithubExecutor = createExecutor;
