import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import { SnapshotError } from "./cache.mjs";
import { CheckLogsError } from "./check-logs.mjs";
import { ACTION_LIMITS, ActionError, actionError } from "./claude.mjs";
import { CommitsError } from "./commits.mjs";
import { DiffError } from "./diff.mjs";
import { ExecutorError } from "./executor.mjs";
import { TaskError } from "./task.mjs";

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const SECURITY_HEADERS = new Map([
  [
    "content-security-policy",
    ["Content-Security-Policy", "frame-ancestors 'none'"],
  ],
  ["x-content-type-options", ["X-Content-Type-Options", "nosniff"]],
  ["x-frame-options", ["X-Frame-Options", "DENY"]],
]);

function protectResponse(response) {
  const setHeader = response.setHeader.bind(response);
  const removeHeader = response.removeHeader.bind(response);
  const appendHeader = response.appendHeader?.bind(response);
  const writeHead = response.writeHead.bind(response);

  const protectedHeader = (name) =>
    SECURITY_HEADERS.get(String(name).toLowerCase());
  const applyHeader = (name, value) => {
    const entry = protectedHeader(name);
    return setHeader(entry?.[0] ?? name, entry?.[1] ?? value);
  };
  const applyHeaders = (headers) => {
    if (!headers) return;
    if (Array.isArray(headers)) {
      for (let index = 0; index < headers.length; index += 2) {
        applyHeader(headers[index], headers[index + 1]);
      }
      return;
    }
    for (const [name, value] of Object.entries(headers)) {
      applyHeader(name, value);
    }
  };

  response.setHeader = (name, value) => applyHeader(name, value);
  response.removeHeader = (name) => {
    if (protectedHeader(name)) return;
    removeHeader(name);
  };
  if (appendHeader) {
    response.appendHeader = (name, value) => {
      const entry = protectedHeader(name);
      return entry ? setHeader(entry[0], entry[1]) : appendHeader(name, value);
    };
  }
  response.writeHead = (status, statusMessage, headers) => {
    if (typeof statusMessage === "string") {
      applyHeaders(headers);
      for (const [name, value] of SECURITY_HEADERS.values())
        setHeader(name, value);
      return writeHead(status, statusMessage);
    }
    applyHeaders(headers ?? statusMessage);
    for (const [name, value] of SECURITY_HEADERS.values())
      setHeader(name, value);
    return writeHead(status);
  };

  for (const [name, value] of SECURITY_HEADERS.values()) setHeader(name, value);
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function sendText(response, status, message, method = "GET", headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(method === "HEAD" ? undefined : message);
}

function trustedRequest(request, trustedOrigin, requireOrigin = true) {
  const trusted = new URL(trustedOrigin);
  const origin = request.headers.origin;
  return (
    request.headers.host === trusted.host &&
    (!requireOrigin || origin === trustedOrigin) &&
    (origin === undefined || origin === trustedOrigin)
  );
}

function crossSiteRequest(request) {
  const site = request.headers["sec-fetch-site"];
  return typeof site === "string" && site.trim().toLowerCase() === "cross-site";
}

function authorized(request, token) {
  const supplied = request.headers["x-action-token"];
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}

function sendActionError(response, error) {
  const safe = actionError(error);
  sendJson(response, safe.status, { error: safe.message, code: safe.code });
}

function sendServiceError(response, error, fallback = {}) {
  if (error instanceof CheckLogsError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof ActionError) {
    sendActionError(response, error);
    return;
  }
  if (error instanceof DiffError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof CommitsError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
    });
    return;
  }
  if (error instanceof ExecutorError) {
    sendJson(response, error.status, {
      error: error.message,
      code: `github_${error.code}`,
    });
    return;
  }
  if (error instanceof SnapshotError) {
    sendJson(response, 503, {
      error: error.message,
      code: "snapshot_unavailable",
    });
    return;
  }

  sendJson(response, fallback.status ?? 502, {
    error: fallback.message ?? "The request could not be completed.",
    code: fallback.code ?? "service_unavailable",
  });
}

function methodAllowed(request, response, method) {
  if (request.method === method) return true;
  sendJson(
    response,
    405,
    { error: "Method not allowed.", code: "method_not_allowed" },
    {
      Allow: method,
    },
  );
  return false;
}

function actionAllowed(
  request,
  response,
  { actionToken, executionEnabled, manager, trustedOrigin },
) {
  if (!executionEnabled || !manager) {
    sendJson(response, 403, {
      error: "Local execution is disabled for this server binding.",
      code: "execution_disabled",
    });
    return false;
  }
  if (
    !trustedRequest(request, trustedOrigin) ||
    !authorized(request, actionToken)
  ) {
    sendJson(response, 403, {
      error: "The action request is not authorized.",
      code: "action_unauthorized",
    });
    return false;
  }
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function refreshQuery(url) {
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return false;
  if (
    entries.length === 1 &&
    entries[0][0] === "refresh" &&
    entries[0][1] === "1"
  )
    return true;
  throw new ActionError(400, "invalid_query", "The refresh query is invalid.");
}

function pipelineQuery(url) {
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return { discover: false, refresh: false };
  if (entries.length === 1 && entries[0][1] === "1") {
    if (entries[0][0] === "discover") return { discover: true, refresh: false };
    if (entries[0][0] === "refresh") return { discover: false, refresh: true };
  }
  throw new ActionError(
    400,
    "invalid_query",
    "The release pipeline query is invalid.",
  );
}

function decodeSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ActionError(400, "invalid_path", "The API path is invalid.");
  }
  if (
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    throw new ActionError(400, "invalid_path", "The API path is invalid.");
  }
  return decoded;
}

function pullRoute(pathname) {
  const match =
    /^\/api\/pulls\/([^/]+)\/([^/]+)\/([^/]+)\/(commits|diff|merge)$/.exec(
      pathname,
    );
  if (!match) return null;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  const numberValue = decodeSegment(match[3]);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[1-9]\d*$/.test(numberValue)
  ) {
    throw new ActionError(
      400,
      "invalid_path",
      "The pull request path is invalid.",
    );
  }
  const number = Number(numberValue);
  if (!Number.isSafeInteger(number)) {
    throw new ActionError(
      400,
      "invalid_number",
      "The pull request number is invalid.",
    );
  }
  return { action: match[4], number, repository: `${owner}/${name}` };
}

function pullCommitRoute(pathname) {
  const match =
    /^\/api\/pulls\/([^/]+)\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/.exec(
      pathname,
    );
  if (!match) return null;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  const numberValue = decodeSegment(match[3]);
  const commitSha = decodeSegment(match[4]);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[1-9]\d*$/.test(numberValue) ||
    !/^[a-f0-9]{40}$/i.test(commitSha)
  ) {
    throw new ActionError(
      400,
      "invalid_path",
      "The pull request commit path is invalid.",
    );
  }
  const number = Number(numberValue);
  if (!Number.isSafeInteger(number)) {
    throw new ActionError(
      400,
      "invalid_number",
      "The pull request number is invalid.",
    );
  }
  return {
    commitSha: commitSha.toLowerCase(),
    number,
    repository: `${owner}/${name}`,
  };
}

function repairRoute(pathname) {
  const match =
    /^\/api\/pulls\/([^/]+)\/([^/]+)\/([^/]+)\/repairs\/([^/]+)$/.exec(
      pathname,
    );
  if (!match) return null;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  const numberValue = decodeSegment(match[3]);
  const id = decodeSegment(match[4]);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[1-9]\d*$/.test(numberValue) ||
    !/^[A-Za-z0-9-]{1,128}$/.test(id)
  ) {
    throw new ActionError(
      400,
      "invalid_path",
      "The conflict repair path is invalid.",
    );
  }
  const number = Number(numberValue);
  if (!Number.isSafeInteger(number)) {
    throw new ActionError(
      400,
      "invalid_number",
      "The pull request number is invalid.",
    );
  }
  return { id, number, repository: `${owner}/${name}` };
}

function taskRunRoute(pathname) {
  const match = /^\/api\/tasks\/runs\/([^/]+)(\/events)?$/.exec(pathname);
  if (!match) return null;

  const id = decodeSegment(match[1]);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new ActionError(400, "invalid_path", "The task run path is invalid.");
  }

  return { events: match[2] === "/events", id };
}

function checkLogsRoute(pathname) {
  const match =
    /^\/api\/pulls\/([^/]+)\/([^/]+)\/([^/]+)\/checks\/([^/]+)\/jobs\/([^/]+)\/logs$/.exec(
      pathname,
    );
  if (!match) return null;
  const owner = decodeSegment(match[1]);
  const name = decodeSegment(match[2]);
  const numberValue = decodeSegment(match[3]);
  const runId = decodeSegment(match[4]);
  const jobId = decodeSegment(match[5]);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[1-9]\d*$/.test(numberValue) ||
    !/^[1-9]\d{0,19}$/.test(runId) ||
    !/^[1-9]\d{0,19}$/.test(jobId)
  ) {
    throw new ActionError(
      400,
      "invalid_path",
      "The failed check log path is invalid.",
    );
  }
  const number = Number(numberValue);
  if (!Number.isSafeInteger(number)) {
    throw new ActionError(
      400,
      "invalid_number",
      "The pull request number is invalid.",
    );
  }
  return { jobId, number, repository: `${owner}/${name}`, runId };
}

function identityQuery(url, baseName, headName, message) {
  const entries = [...url.searchParams.entries()];
  const bases = url.searchParams.getAll(baseName);
  const heads = url.searchParams.getAll(headName);
  if (
    entries.length !== 2 ||
    bases.length !== 1 ||
    heads.length !== 1 ||
    entries.some(([name]) => name !== baseName && name !== headName) ||
    !/^[a-f0-9]{40}$/i.test(bases[0]) ||
    !/^[a-f0-9]{40}$/i.test(heads[0])
  ) {
    throw new ActionError(400, "invalid_head", message);
  }
  return {
    expectedBaseRefOid: bases[0].toLowerCase(),
    expectedHeadRefOid: heads[0].toLowerCase(),
  };
}

function diffIdentity(url) {
  return identityQuery(
    url,
    "base",
    "head",
    "The pull request diff identity query is invalid.",
  );
}

function commitsIdentity(url) {
  return identityQuery(
    url,
    "base",
    "head",
    "The pull request commits identity query is invalid.",
  );
}

function checkLogsIdentity(url) {
  return identityQuery(
    url,
    "baseRefOid",
    "headRefOid",
    "The failed check log identity query is invalid.",
  );
}

function taskEventAfter(url) {
  const entries = [...url.searchParams.entries()];
  if (entries.length === 0) return 0;
  if (
    entries.length !== 1 ||
    entries[0][0] !== "after" ||
    !/^(0|[1-9]\d*)$/.test(entries[0][1])
  ) {
    throw new ActionError(
      400,
      "invalid_query",
      "The task event cursor is invalid.",
    );
  }

  const after = Number(entries[0][1]);
  if (!Number.isSafeInteger(after)) {
    throw new ActionError(
      400,
      "invalid_query",
      "The task event cursor is invalid.",
    );
  }
  return after;
}

function serviceClosed(request, response) {
  return request.aborted || response.destroyed || response.writableEnded;
}

function serviceLifetime(request, response) {
  const controller = new AbortController();
  const closed = () => serviceClosed(request, response);
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abort);
  if (closed()) abort();

  return {
    closed,
    dispose() {
      request.off("aborted", abort);
      response.off("close", abort);
    },
    signal: controller.signal,
  };
}

async function serviceResult(request, response, load) {
  const lifetime = serviceLifetime(request, response);
  try {
    const value = await load(lifetime.signal);
    return { closed: lifetime.closed(), error: null, value };
  } catch (error) {
    return { closed: lifetime.closed(), error, value: null };
  } finally {
    lifetime.dispose();
  }
}

function sendTaskError(response, error, fallback = {}) {
  if (error instanceof TaskError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
    });
    return;
  }

  if (error instanceof ActionError) {
    sendActionError(response, error);
    return;
  }

  sendJson(response, fallback.status ?? 502, {
    error: fallback.message ?? "The task request could not be completed.",
    code: fallback.code ?? "task_unavailable",
  });
}

async function readJson(request, maximum = ACTION_LIMITS.body) {
  const contentType = request.headers["content-type"]
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ActionError(
      415,
      "json_required",
      "The request must use application/json.",
    );
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximum) {
    request.resume();
    throw new ActionError(
      413,
      "body_too_large",
      "The request exceeds the 64 KiB limit.",
    );
  }

  return await new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.byteLength;
      if (size > maximum) {
        fail(
          new ActionError(
            413,
            "body_too_large",
            "The request exceeds the 64 KiB limit.",
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onAborted = () =>
      fail(
        new ActionError(400, "request_aborted", "The request was interrupted."),
      );
    const onEnd = () => {
      if (settled) return;
      settled = true;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new ActionError(
            400,
            "invalid_json",
            "The request body is not valid JSON.",
          ),
        );
      }
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
  });
}

function responseChannel(request, response) {
  const closeListeners = new Set();
  const closed = () => response.destroyed || request.aborted;
  const onClose = () => {
    if (!response.writableEnded) {
      for (const listener of closeListeners) listener();
    }
  };
  response.once("close", onClose);

  return {
    write(event) {
      if (response.destroyed || response.writableEnded) return true;
      const line = `${JSON.stringify(event)}\n`;
      if (!response.headersSent) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
      }
      if (
        event.terminal === true ||
        event.type === "complete" ||
        event.type === "error" ||
        event.type === "cancelled" ||
        event.type === "limit"
      ) {
        response.end(line);
        return true;
      }
      return response.write(line);
    },
    onceDrain(listener) {
      response.once("drain", listener);
      return () => response.off("drain", listener);
    },
    onClose(listener) {
      if (closed()) {
        listener();
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    closed,
  };
}

async function waitForDrain(response, signal) {
  if (signal.aborted || response.destroyed || response.writableEnded)
    return false;

  return await new Promise((resolveWait) => {
    let settled = false;
    const finish = (writable) => {
      if (settled) return;
      settled = true;
      response.off("close", onClose);
      response.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
      resolveWait(writable);
    };
    const onAbort = () => finish(false);
    const onClose = () => finish(false);
    const onDrain = () => finish(true);

    response.once("close", onClose);
    response.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || response.destroyed || response.writableEnded)
      finish(false);
  });
}

async function streamTaskEvents(request, response, taskManager, id, after) {
  const lifetime = serviceLifetime(request, response);
  try {
    const events = taskManager.subscribe(id, {
      after,
      signal: lifetime.signal,
    });
    if (!events || typeof events[Symbol.asyncIterator] !== "function") {
      throw new TypeError("Task subscriptions must be async iterables.");
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    for await (const event of events) {
      if (lifetime.closed()) return;
      const writable = response.write(`${JSON.stringify(event)}\n`);
      if (!writable && !(await waitForDrain(response, lifetime.signal))) return;
    }
    if (!lifetime.closed()) response.end();
  } catch (error) {
    if (!response.headersSent) {
      sendTaskError(response, error, {
        code: "task_events_unavailable",
        message: "Task events could not be loaded.",
      });
    } else if (!lifetime.closed()) {
      response.end();
    }
  } finally {
    lifetime.dispose();
  }
}

export function createApiHandler({
  cache,
  runManager = null,
  taskManager = null,
  checkLogsService = null,
  commitsService = null,
  diffService = null,
  mergeService = null,
  repairManager = null,
  releaseService = null,
  releaseVerificationManager = null,
  verificationManager = null,
  actionToken = "",
  trustedOrigin = "http://127.0.0.1:5173",
  executionEnabled = true,
}) {
  return async function handleApi(request, response) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(response, 400, {
        error: "The request URL is invalid.",
        code: "invalid_url",
      });
      return true;
    }
    if (!url.pathname.startsWith("/api/")) {
      return false;
    }

    if (
      crossSiteRequest(request) ||
      !trustedRequest(request, trustedOrigin, false)
    ) {
      sendJson(response, 403, {
        error: "Untrusted request origin.",
        code: "untrusted_origin",
      });
      return true;
    }

    if (url.pathname === "/api/actions/token") {
      if (!methodAllowed(request, response, "GET")) {
      } else if (url.search !== "") {
        sendJson(response, 400, {
          error: "The action token query is invalid.",
          code: "invalid_query",
        });
      } else {
        sendJson(response, 200, { token: actionToken });
      }
      return true;
    }

    if (url.pathname === "/api/tasks/options") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!taskManager) {
        sendJson(response, 503, {
          error: "Task options are unavailable.",
          code: "task_service_unavailable",
        });
        return true;
      }
      try {
        if (url.search !== "") {
          throw new ActionError(
            400,
            "invalid_query",
            "The task options query is invalid.",
          );
        }
        sendJson(response, 200, await taskManager.options());
      } catch (error) {
        sendTaskError(response, error, {
          code: "task_options_unavailable",
          message: "Task options could not be loaded.",
          status: 503,
        });
      }
      return true;
    }

    if (url.pathname === "/api/tasks/runs") {
      if (request.method === "GET") {
        if (!taskManager) {
          sendJson(response, 503, {
            error: "Task runs are unavailable.",
            code: "task_service_unavailable",
          });
          return true;
        }
        try {
          if (url.search !== "") {
            throw new ActionError(
              400,
              "invalid_query",
              "The task runs query is invalid.",
            );
          }
          sendJson(response, 200, taskManager.list());
        } catch (error) {
          sendTaskError(response, error, {
            code: "task_runs_unavailable",
            message: "Task runs could not be loaded.",
          });
        }
        return true;
      }
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: taskManager,
          trustedOrigin,
        })
      )
        return true;
      try {
        if (url.search !== "") {
          throw new ActionError(
            400,
            "invalid_query",
            "The task start query is invalid.",
          );
        }
        const body = await readJson(request);
        if (!exactKeys(body, ["agent", "id", "repository", "base", "prompt"])) {
          throw new ActionError(
            400,
            "invalid_request",
            "The task start request is invalid.",
          );
        }
        sendJson(response, 202, await taskManager.start(body));
      } catch (error) {
        sendTaskError(response, error, {
          code: "task_start_failed",
          message: "The task could not be started.",
        });
      }
      return true;
    }

    let taskRoute;
    try {
      taskRoute = taskRunRoute(url.pathname);
    } catch (error) {
      sendTaskError(response, error, {
        code: "invalid_path",
        message: "The task run path is invalid.",
        status: 400,
      });
      return true;
    }
    if (taskRoute?.events) {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!taskManager) {
        sendJson(response, 503, {
          error: "Task events are unavailable.",
          code: "task_service_unavailable",
        });
        return true;
      }
      let after;
      try {
        after = taskEventAfter(url);
      } catch (error) {
        sendTaskError(response, error);
        return true;
      }
      await streamTaskEvents(
        request,
        response,
        taskManager,
        taskRoute.id,
        after,
      );
      return true;
    }
    if (taskRoute) {
      if (!methodAllowed(request, response, "DELETE")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: taskManager,
          trustedOrigin,
        })
      )
        return true;
      try {
        if (url.search !== "") {
          throw new ActionError(
            400,
            "invalid_query",
            "The task cancellation query is invalid.",
          );
        }
        const task = await taskManager.cancel(taskRoute.id);
        if (task === undefined || task === null) {
          response.writeHead(204, { "Cache-Control": "no-store" });
          response.end();
        } else {
          sendJson(response, 200, task);
        }
      } catch (error) {
        sendTaskError(response, error, {
          code: "task_cancel_failed",
          message: "The task could not be cancelled.",
        });
      }
      return true;
    }

    if (
      url.pathname === "/api/agents/runs" ||
      url.pathname === "/api/claude/runs"
    ) {
      if (!methodAllowed(request, response, "POST")) {
        return true;
      }
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: runManager,
          trustedOrigin,
        })
      ) {
        return true;
      }
      try {
        const body = await readJson(request);
        const input =
          url.pathname === "/api/claude/runs"
            ? { ...body, agent: "claude" }
            : body;
        const channel = responseChannel(request, response);
        await runManager.start(input, channel);
      } catch (error) {
        if (!response.headersSent) {
          sendActionError(response, error);
        } else if (!response.writableEnded) {
          response.end(
            `${JSON.stringify({ type: "error", message: "The agent run failed." })}\n`,
          );
        }
      }
      return true;
    }

    const cancellation =
      /^\/api\/(?:agents|claude)\/runs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (cancellation) {
      if (!methodAllowed(request, response, "DELETE")) {
      } else if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: runManager,
          trustedOrigin,
        })
      ) {
      } else {
        runManager.cancel(cancellation[1]);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      }
      return true;
    }

    if (url.pathname === "/api/verifications") {
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: verificationManager,
          trustedOrigin,
        })
      )
        return true;
      try {
        const body = await readJson(request);
        if (
          !exactKeys(body, [
            "agent",
            "headSha",
            "pullNumber",
            "pullUrl",
            "releaseId",
            "repository",
            "tag",
          ])
        ) {
          throw new ActionError(
            400,
            "invalid_request",
            "The verification request is invalid.",
          );
        }
        const channel = responseChannel(request, response);
        await verificationManager.start(body, channel);
      } catch (error) {
        if (!response.headersSent) {
          sendActionError(response, error);
        } else if (!response.writableEnded) {
          response.end(
            `${JSON.stringify({ type: "error", message: "Verification could not start." })}\n`,
          );
        }
      }
      return true;
    }

    const verificationCancellation = /^\/api\/verifications\/([^/]+)$/.exec(
      url.pathname,
    );
    if (verificationCancellation) {
      let runId;
      try {
        runId = decodeSegment(verificationCancellation[1]);
      } catch (error) {
        sendActionError(response, error);
        return true;
      }
      if (!/^[A-Za-z0-9_:=-]{1,256}$/.test(runId)) {
        sendJson(response, 400, {
          error: "The verification run identity is invalid.",
          code: "invalid_run",
        });
      } else if (!methodAllowed(request, response, "DELETE")) {
      } else if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: verificationManager,
          trustedOrigin,
        })
      ) {
      } else {
        verificationManager.cancel(runId);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      }
      return true;
    }

    if (url.pathname === "/api/releases/verifications") {
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: releaseVerificationManager,
          trustedOrigin,
        })
      )
        return true;
      try {
        if (url.search !== "") {
          throw new ActionError(
            400,
            "invalid_query",
            "The release verification query is invalid.",
          );
        }
        const body = await readJson(request);
        if (!exactKeys(body, ["agent", "releaseId", "repository", "tag"])) {
          throw new ActionError(
            400,
            "invalid_request",
            "The release verification request is invalid.",
          );
        }
        const channel = responseChannel(request, response);
        await releaseVerificationManager.start(body, channel);
      } catch (error) {
        if (!response.headersSent) {
          sendActionError(response, error);
        } else if (!response.writableEnded) {
          response.end(
            `${JSON.stringify({ type: "error", message: "Release verification could not start." })}\n`,
          );
        }
      }
      return true;
    }

    const releaseVerificationCancellation =
      /^\/api\/releases\/verifications\/([^/]+)$/.exec(url.pathname);
    if (releaseVerificationCancellation) {
      let batchId;
      try {
        batchId = decodeSegment(releaseVerificationCancellation[1]);
      } catch (error) {
        sendActionError(response, error);
        return true;
      }
      if (!/^[A-Za-z0-9-]{1,128}$/.test(batchId)) {
        sendJson(response, 400, {
          error: "The release verification identity is invalid.",
          code: "invalid_run",
        });
      } else if (!methodAllowed(request, response, "DELETE")) {
      } else if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: releaseVerificationManager,
          trustedOrigin,
        })
      ) {
      } else {
        releaseVerificationManager.cancel(batchId);
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
      }
      return true;
    }

    if (url.pathname === "/api/releases/options") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!releaseService) {
        sendJson(response, 503, {
          error: "Release options are unavailable.",
          code: "release_service_unavailable",
        });
        return true;
      }
      try {
        sendJson(
          response,
          200,
          await releaseService.getOptions({ refresh: refreshQuery(url) }),
        );
      } catch (error) {
        sendServiceError(response, error, {
          code: "release_options_unavailable",
          message: "Release options could not be loaded.",
          status: 503,
        });
      }
      return true;
    }

    if (url.pathname === "/api/releases/recent") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!releaseService) {
        sendJson(response, 503, {
          error: "Recent releases are unavailable.",
          code: "release_service_unavailable",
        });
        return true;
      }
      try {
        sendJson(
          response,
          200,
          await releaseService.getRecent({ refresh: refreshQuery(url) }),
        );
      } catch (error) {
        sendServiceError(response, error, {
          code: "releases_unavailable",
          message: "Recent releases could not be loaded.",
          status: 503,
        });
      }
      return true;
    }

    if (url.pathname === "/api/releases/pipelines") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (
        !releaseService ||
        typeof releaseService.getPipelines !== "function"
      ) {
        sendJson(response, 503, {
          error: "Release pipelines are unavailable.",
          code: "release_service_unavailable",
        });
        return true;
      }
      try {
        sendJson(
          response,
          200,
          await releaseService.getPipelines(pipelineQuery(url)),
        );
      } catch (error) {
        sendServiceError(response, error, {
          code: "release_pipelines_unavailable",
          message: "Release pipelines could not be loaded.",
          status: 503,
        });
      }
      return true;
    }

    if (url.pathname === "/api/releases/preview") {
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: releaseService,
          trustedOrigin,
        })
      )
        return true;
      try {
        const body = await readJson(request);
        if (!exactKeys(body, ["expectedLatestTag", "repository", "tag"])) {
          throw new ActionError(
            400,
            "invalid_request",
            "The release preview request is invalid.",
          );
        }
        sendJson(response, 200, await releaseService.preview(body));
      } catch (error) {
        sendServiceError(response, error, {
          code: "release_preview_failed",
          message: "The release preview could not be loaded.",
        });
      }
      return true;
    }

    if (url.pathname === "/api/releases") {
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: releaseService,
          trustedOrigin,
        })
      )
        return true;
      try {
        const body = await readJson(request);
        if (
          !exactKeys(body, [
            "expectedLatestTag",
            "prerelease",
            "preview",
            "repository",
            "tag",
          ])
        ) {
          throw new ActionError(
            400,
            "invalid_request",
            "The release request is invalid.",
          );
        }
        sendJson(response, 201, await releaseService.create(body));
      } catch (error) {
        sendServiceError(response, error, {
          code: "release_failed",
          message: "The release could not be created.",
        });
      }
      return true;
    }

    let checkLogs;
    let commit;
    let repair;
    let route;
    try {
      checkLogs = checkLogsRoute(url.pathname);
      commit = pullCommitRoute(url.pathname);
      repair = repairRoute(url.pathname);
      route = pullRoute(url.pathname);
    } catch (error) {
      sendServiceError(response, error, {
        code: "invalid_path",
        message: "The pull request path is invalid.",
        status: 400,
      });
      return true;
    }
    if (repair) {
      if (request.method !== "GET" && request.method !== "DELETE") {
        sendJson(
          response,
          405,
          { error: "Method not allowed.", code: "method_not_allowed" },
          { Allow: "GET, DELETE" },
        );
        return true;
      }
      if (!executionEnabled || !repairManager) {
        sendJson(response, 403, {
          error: "Local execution is disabled for this server binding.",
          code: "execution_disabled",
        });
        return true;
      }
      if (!trustedRequest(request, trustedOrigin)) {
        sendJson(response, 403, {
          error: "The action request is not authorized.",
          code: "action_unauthorized",
        });
        return true;
      }
      const token = request.headers["x-action-token"];
      if (typeof token !== "string") {
        sendJson(response, 403, {
          error: "The action request is not authorized.",
          code: "action_unauthorized",
        });
        return true;
      }
      if (url.search !== "") {
        sendJson(response, 400, {
          error: "The conflict repair query is invalid.",
          code: "invalid_query",
        });
        return true;
      }
      const identity = { ...repair, token };
      try {
        if (request.method === "DELETE") {
          sendJson(response, 200, await repairManager.cancelObserved(identity));
        } else {
          await repairManager.watch(
            identity,
            responseChannel(request, response),
          );
        }
      } catch (error) {
        if (!response.headersSent) {
          sendServiceError(response, error, {
            code: "repair_not_found",
            message: "The conflict repair action was not found.",
            status: 404,
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      }
      return true;
    }
    if (checkLogs) {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!checkLogsService) {
        sendJson(response, 503, {
          error: "Failed check logs are unavailable.",
          code: "check_logs_service_unavailable",
        });
        return true;
      }
      let identity;
      try {
        identity = checkLogsIdentity(url);
      } catch (error) {
        sendServiceError(response, error);
        return true;
      }
      const result = await serviceResult(request, response, (signal) =>
        checkLogsService.load(
          {
            baseRefOid: identity.expectedBaseRefOid,
            headRefOid: identity.expectedHeadRefOid,
            jobId: checkLogs.jobId,
            number: checkLogs.number,
            repository: checkLogs.repository,
            runId: checkLogs.runId,
          },
          signal,
        ),
      );
      if (result.closed || serviceClosed(request, response)) return true;
      if (result.error) {
        sendServiceError(response, result.error, {
          code: "check_logs_unavailable",
          message: "Failed check logs could not be loaded.",
        });
      } else {
        sendJson(response, 200, result.value);
      }
      return true;
    }
    if (commit || route?.action === "commits") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!commitsService) {
        sendJson(response, 503, {
          error: "Pull request commits are unavailable.",
          code: "commits_service_unavailable",
        });
        return true;
      }
      let identity;
      try {
        identity = commitsIdentity(url);
      } catch (error) {
        sendServiceError(response, error);
        return true;
      }
      const target = commit ?? route;
      const result = await serviceResult(request, response, (signal) =>
        commit
          ? commitsService.loadCommitDiff({
              ...identity,
              commitSha: commit.commitSha,
              number: commit.number,
              repository: commit.repository,
              signal,
            })
          : commitsService.load({
              ...identity,
              number: target.number,
              repository: target.repository,
              signal,
            }),
      );
      if (result.closed || serviceClosed(request, response)) return true;
      if (result.error) {
        sendServiceError(response, result.error, {
          code: "commits_unavailable",
          message: "The pull request commits could not be loaded.",
        });
      } else {
        sendJson(response, 200, result.value);
      }
      return true;
    }
    if (route?.action === "diff") {
      if (!methodAllowed(request, response, "GET")) return true;
      if (!diffService) {
        sendJson(response, 503, {
          error: "Pull request diffs are unavailable.",
          code: "diff_service_unavailable",
        });
        return true;
      }
      let identity;
      try {
        identity = diffIdentity(url);
      } catch (error) {
        sendServiceError(response, error);
        return true;
      }
      const result = await serviceResult(request, response, (signal) =>
        diffService.load({
          ...identity,
          number: route.number,
          repository: route.repository,
          signal,
        }),
      );
      if (result.closed || serviceClosed(request, response)) return true;
      if (result.error) {
        sendServiceError(response, result.error, {
          code: "diff_unavailable",
          message: "The pull request diff could not be loaded.",
        });
      } else {
        sendJson(response, 200, result.value);
      }
      return true;
    }
    if (route?.action === "merge") {
      if (!methodAllowed(request, response, "POST")) return true;
      if (
        !actionAllowed(request, response, {
          actionToken,
          executionEnabled,
          manager: mergeService,
          trustedOrigin,
        })
      )
        return true;
      try {
        if (url.search !== "") {
          throw new ActionError(
            400,
            "invalid_query",
            "The merge query is invalid.",
          );
        }
        const body = await readJson(request);
        if (!exactKeys(body, ["agent", "expectedHeadRefOid"])) {
          throw new ActionError(
            400,
            "invalid_request",
            "The merge request is invalid.",
          );
        }
        sendJson(
          response,
          200,
          await mergeService.merge({
            agent: body.agent,
            expectedHeadRefOid: body.expectedHeadRefOid,
            number: route.number,
            repository: route.repository,
          }),
        );
      } catch (error) {
        sendServiceError(response, error, {
          code: "merge_failed",
          message: "The pull request could not be merged.",
        });
      }
      return true;
    }
    if (url.pathname === "/api/pulls") {
      if (!methodAllowed(request, response, "GET")) return true;
      try {
        const snapshot = await cache.get({ refresh: refreshQuery(url) });
        const viewerLogin =
          typeof snapshot?.viewerLogin === "string"
            ? snapshot.viewerLogin.trim()
            : "";
        if (
          snapshot?.stale === false &&
          viewerLogin &&
          typeof releaseService?.primeRepositories === "function"
        ) {
          Promise.resolve()
            .then(() => releaseService.primeRepositories(snapshot))
            .catch(() => undefined);
        }
        sendJson(response, 200, snapshot);
      } catch (error) {
        sendServiceError(response, error, {
          code: "snapshot_unavailable",
          message:
            "Pull requests could not be loaded. Run gh auth status and try again.",
          status: 503,
        });
      }
      return true;
    }

    sendJson(response, 404, {
      error: "API endpoint not found.",
      code: "not_found",
    });
    return true;
  };
}

function isInside(root, target) {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))
  );
}

function decodePath(requestUrl) {
  const raw = (requestUrl ?? "/").split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }

  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function safeFile(root, actualRoot, candidate) {
  if (!isInside(root, candidate) || !(await existingFile(candidate))) {
    return null;
  }

  const actual = await realpath(candidate);
  return isInside(actualRoot, actual) ? actual : null;
}

export function createStaticHandler({ distPath }) {
  const root = resolve(distPath);
  const indexPath = resolve(root, "index.html");
  const actualRoot = realpath(root);

  return async function serveStatic(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Method not allowed.", request.method, {
        Allow: "GET, HEAD",
      });
      return;
    }

    const pathname = decodePath(request.url);
    if (pathname === null) {
      sendText(response, 400, "Invalid path.", request.method);
      return;
    }

    const candidate = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    let file = await safeFile(root, await actualRoot, candidate);
    if (!file) {
      const assetRequest =
        pathname.startsWith("/assets/") || extname(pathname) !== "";
      if (assetRequest) {
        sendText(response, 404, "Not found.", request.method);
        return;
      }

      file = await safeFile(root, await actualRoot, indexPath);
      if (!file) {
        sendText(
          response,
          500,
          "The production client is unavailable.",
          request.method,
        );
        return;
      }
    }

    const body = await readFile(file);
    const extension = extname(file).toLowerCase();
    response.writeHead(200, {
      "Cache-Control":
        extension === ".html"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      "Content-Length": body.byteLength,
      "Content-Type": TYPES.get(extension) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
}

export function createRequestListener({ cache, fallback, ...actions }) {
  const api = createApiHandler({ cache, ...actions });

  return function requestListener(request, response) {
    protectResponse(response);
    Promise.resolve(api(request, response))
      .then((handled) => {
        if (!handled) {
          return fallback(request, response);
        }
        return undefined;
      })
      .catch(() => {
        if (!response.headersSent) {
          sendText(response, 500, "Unexpected server error.", request.method);
        } else {
          response.destroy();
        }
      });
  };
}

export async function assertProductionBuild(distPath) {
  const indexPath = resolve(distPath, "index.html");
  try {
    await access(indexPath, constants.R_OK);
  } catch {
    throw new Error(
      `Production client not found at ${indexPath}. Run pnpm build before pnpm start.`,
    );
  }
}
