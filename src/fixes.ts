import type { Agent, ReviewCommentSide } from "./types";

export const DEFAULT_FIX_INSTRUCTIONS =
  "The target is the shepherd bar. Make the local code changes and run the local validation needed for this pull request to satisfy these target outcomes after the normal CI, review, and sync workflows run: all CI checks pass; no review comments remain unaddressed and no review threads remain unresolved; Greptile reports 5/5 confidence for the current head commit; and no merge conflicts remain. Do not merge. Address the local cause of each evidence item, but do not claim that remote checks, comments, review threads, Greptile evidence, or conflict state changed. Merge conflicts are handled by Puller's dedicated merge/conflict-repair flow; do not use Git or attempt remote state changes.";

export const DEFAULT_FIX_PLACEHOLDER =
  "Leave blank to drive this pull request to the shepherd bar.";

export type RunSource = "manual" | "auto" | "review";

export type AutoParallelism = 1 | 2 | 3 | 4;

export type AutoTrigger =
  | {
      kind: "issue_comment";
      id: string;
      updatedAt: string;
    }
  | {
      kind: "review_comment";
      id: string;
      threadId: string;
      updatedAt: string;
    }
  | {
      kind: "failed_check";
      id: string;
      detailsUrl: string | null;
      headRefOid: string;
    }
  | {
      kind: "greptile";
      commentId: string;
      updatedAt: string;
      reviewedSha: string;
      confidence: number;
    };

type ClaudeRunRequestBase = {
  expectedHeadRefOid: string;
  message: string;
  number: number;
  repository: string;
};

export type ReviewFeedback = {
  body: string;
  line: number;
  path: string;
  side: ReviewCommentSide;
  startLine?: number;
  startSide?: ReviewCommentSide;
};

export type ClaudeRunRequest = ClaudeRunRequestBase &
  (
    | {
        expectedBaseRefOid?: never;
        feedback?: never;
        parallelism?: never;
        source?: "manual";
        triggers?: never;
      }
    | {
        expectedBaseRefOid?: never;
        feedback?: never;
        parallelism: AutoParallelism;
        source: "auto";
        triggers: readonly AutoTrigger[];
      }
    | {
        expectedBaseRefOid: string;
        feedback: ReviewFeedback;
        parallelism?: never;
        source: "review";
        triggers?: never;
      }
  );

export type AgentRunRequest = ClaudeRunRequest & {
  agent: Agent;
};

export class ClaudeRunHttpError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ClaudeRunHttpError";
    this.status = status;
    this.code = code;
  }
}

export { ClaudeRunHttpError as AgentRunHttpError };

export type ClaudeRunEvent =
  | {
      type: "start";
      runId: string;
      repository: string;
      number: number;
    }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status?: string }
  | { type: "diagnostic"; text: string }
  | { type: "complete"; exitCode: number }
  | { type: "error"; code?: "rate_limit"; message: string }
  | { type: "cancelled"; message?: string }
  | { type: "limit"; message: string };

export const RATE_LIMIT_EVENT_CODE = "rate_limit";

export const isRateLimitMessage = (message: string): boolean =>
  /weekly limit|rate limit|out of credits|no weighted tokens|usage limit|\bquota\b/i.test(
    message,
  );

export type AgentRunEvent =
  | {
      agent: Agent;
      type: "start";
      runId: string;
      repository: string;
      number: number;
    }
  | Exclude<ClaudeRunEvent, { type: "start" }>;

const AUTH_STATUSES = new Set([401, 403]);
const MAX_ERROR_LENGTH = 500;
const REVIEW_SIDES = new Set<ReviewCommentSide>(["LEFT", "RIGHT"]);
const SHA = /^[0-9a-f]{40}$/i;

let cachedToken: string | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const validateReviewRequest = (
  request: Extract<ClaudeRunRequest, { source: "review" }>,
): void => {
  if (!isRecord(request.feedback)) {
    throw new Error("The review fix request is invalid.");
  }

  const feedback = request.feedback;
  const { startLine, startSide } = feedback;
  const hasStartLine = startLine !== undefined;
  const hasStartSide = startSide !== undefined;
  if (
    !hasOnlyKeys(request, [
      "expectedBaseRefOid",
      "expectedHeadRefOid",
      "feedback",
      "message",
      "number",
      "repository",
      "source",
    ]) ||
    !SHA.test(request.expectedBaseRefOid) ||
    !SHA.test(request.expectedHeadRefOid) ||
    typeof request.message !== "string" ||
    !hasOnlyKeys(feedback, [
      "body",
      "line",
      "path",
      "side",
      "startLine",
      "startSide",
    ]) ||
    !isNonEmptyString(feedback.body) ||
    feedback.body.includes("\0") ||
    !isNonEmptyString(feedback.path) ||
    feedback.path.includes("\0") ||
    !REVIEW_SIDES.has(feedback.side) ||
    !Number.isSafeInteger(feedback.line) ||
    feedback.line < 1 ||
    hasStartLine !== hasStartSide ||
    (startLine !== undefined &&
      (!Number.isSafeInteger(startLine) ||
        startLine < 1 ||
        startLine > feedback.line ||
        startSide !== feedback.side))
  ) {
    throw new Error("The review fix request is invalid.");
  }
};

const parseEvent = (value: unknown, label = "Claude"): ClaudeRunEvent => {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    throw new Error(`${label} returned an invalid stream event.`);
  }

  switch (value.type) {
    case "start":
      if (
        hasOnlyKeys(value, ["type", "runId", "repository", "number"]) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.repository) &&
        isInteger(value.number) &&
        value.number > 0
      ) {
        return {
          number: value.number,
          repository: value.repository,
          runId: value.runId,
          type: "start",
        };
      }
      break;
    case "text":
    case "diagnostic":
      if (
        hasOnlyKeys(value, ["type", "text"]) &&
        typeof value.text === "string"
      ) {
        return { text: value.text, type: value.type };
      }
      break;
    case "tool":
      if (
        hasOnlyKeys(value, ["type", "name", "status"]) &&
        isNonEmptyString(value.name) &&
        (value.status === undefined || typeof value.status === "string")
      ) {
        return value.status === undefined
          ? { name: value.name, type: "tool" }
          : { name: value.name, status: value.status, type: "tool" };
      }
      break;
    case "complete":
      if (
        hasOnlyKeys(value, ["type", "exitCode"]) &&
        isInteger(value.exitCode)
      ) {
        return { exitCode: value.exitCode, type: "complete" };
      }
      break;
    case "error":
      if (
        isNonEmptyString(value.message) &&
        (hasOnlyKeys(value, ["type", "message"]) ||
          (hasOnlyKeys(value, ["type", "message", "code"]) &&
            value.code === RATE_LIMIT_EVENT_CODE))
      ) {
        return value.code === RATE_LIMIT_EVENT_CODE
          ? {
              code: RATE_LIMIT_EVENT_CODE,
              message: value.message,
              type: "error",
            }
          : { message: value.message, type: "error" };
      }
      break;
    case "limit":
      if (
        hasOnlyKeys(value, ["type", "message"]) &&
        isNonEmptyString(value.message)
      ) {
        return { message: value.message, type: "limit" };
      }
      break;
    case "cancelled":
      if (
        hasOnlyKeys(value, ["type", "message"]) &&
        (value.message === undefined || isNonEmptyString(value.message))
      ) {
        return value.message === undefined
          ? { type: "cancelled" }
          : { message: value.message, type: "cancelled" };
      }
      break;
  }

  throw new Error(`${label} returned an invalid stream event.`);
};

const parseAgentEvent = (value: unknown, label: string): AgentRunEvent => {
  if (
    isRecord(value) &&
    value.type === "start" &&
    hasOnlyKeys(value, ["agent", "type", "runId", "repository", "number"]) &&
    (value.agent === "claude" || value.agent === "codex") &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.repository) &&
    isInteger(value.number) &&
    value.number > 0
  ) {
    return {
      agent: value.agent,
      number: value.number,
      repository: value.repository,
      runId: value.runId,
      type: "start",
    };
  }

  return parseEvent(value, label) as AgentRunEvent;
};

const getResponseError = async (
  response: Response,
  fallback: string,
): Promise<ClaudeRunHttpError> => {
  const text = await response.text().catch(() => "");
  let code: string | null = null;
  let message = "";

  if (text) {
    try {
      const payload: unknown = JSON.parse(text);
      if (isRecord(payload) && isNonEmptyString(payload.error)) {
        message = payload.error;
      }
      if (isRecord(payload) && isNonEmptyString(payload.code)) {
        code = payload.code;
      }
    } catch {
      message = text;
    }
  }

  const normalized = message
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
  return new ClaudeRunHttpError(
    response.status,
    code,
    normalized || `${fallback} (HTTP ${response.status}).`,
  );
};

const requestToken = async (signal?: AbortSignal): Promise<string> => {
  const response = await fetch("/api/actions/token", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw await getResponseError(response, "The action token request failed");
  }

  const payload: unknown = await response.json().catch(() => null);

  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, ["token"]) ||
    !isNonEmptyString(payload.token)
  ) {
    throw new Error("The action service returned an invalid token response.");
  }

  return payload.token;
};

const getToken = async (
  signal?: AbortSignal,
  refresh = false,
): Promise<string> => {
  if (refresh) {
    cachedToken = null;
  }

  if (cachedToken) {
    return cachedToken;
  }

  const token = await requestToken(signal);
  cachedToken = token;
  return token;
};

const authorizedFetch = async (
  input: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getToken(signal, attempt === 1);
    const response = await fetch(input, {
      ...init,
      headers: {
        ...init.headers,
        "X-Action-Token": token,
      },
      signal,
    });

    if (!AUTH_STATUSES.has(response.status) || attempt === 1) {
      return response;
    }

    cachedToken = null;
  }

  throw new Error("The action request could not be authorized.");
};

const readLines = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          yield line;
        }
        newline = buffer.indexOf("\n");
      }

      if (done) {
        if (buffer.trim()) {
          yield buffer.replace(/\r$/, "");
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

const requestBody = (request: ClaudeRunRequest): Record<string, unknown> => {
  const source = request.source ?? "manual";
  if (request.source === "review") {
    validateReviewRequest(request);
  }

  return {
    expectedHeadRefOid:
      request.source === "review"
        ? request.expectedHeadRefOid.toLowerCase()
        : request.expectedHeadRefOid,
    message: request.message,
    number: request.number,
    repository: request.repository,
    ...(request.source === undefined ? {} : { source }),
    ...(request.source === "auto"
      ? { parallelism: request.parallelism, triggers: request.triggers }
      : {}),
    ...(request.source === "review"
      ? {
          expectedBaseRefOid: request.expectedBaseRefOid.toLowerCase(),
          feedback: {
            body: request.feedback.body,
            line: request.feedback.line,
            path: request.feedback.path,
            side: request.feedback.side,
            ...(request.feedback.startLine === undefined
              ? {}
              : {
                  startLine: request.feedback.startLine,
                  startSide: request.feedback.startSide,
                }),
          },
        }
      : {}),
  };
};

export async function* streamClaudeRun(
  request: ClaudeRunRequest,
  signal?: AbortSignal,
): AsyncGenerator<ClaudeRunEvent, void, undefined> {
  const body = requestBody(request);
  const response = await authorizedFetch(
    "/api/claude/runs",
    {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );

  if (!response.ok) {
    throw await getResponseError(response, "Claude could not be started");
  }

  if (!response.body) {
    throw new Error("Claude returned an empty response stream.");
  }

  let eventIndex = 0;
  let terminal = false;

  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error("Claude returned malformed stream data.");
    }

    const event = parseEvent(payload);
    if (eventIndex === 0 && event.type !== "start") {
      throw new Error("Claude returned a stream without a start event.");
    }
    if (
      eventIndex === 0 &&
      event.type === "start" &&
      (event.repository !== request.repository ||
        event.number !== request.number)
    ) {
      throw new Error(
        "Claude returned a start event for a different pull request.",
      );
    }
    if (eventIndex > 0 && event.type === "start") {
      throw new Error("Claude returned more than one start event.");
    }
    if (terminal) {
      throw new Error("Claude returned data after a terminal event.");
    }

    eventIndex += 1;
    terminal = ["complete", "error", "cancelled", "limit"].includes(event.type);
    yield event;
  }

  if (eventIndex === 0) {
    throw new Error("Claude returned an empty response stream.");
  }
  if (!terminal) {
    throw new Error("Claude disconnected before reporting completion.");
  }
}

export async function* streamAgentRun(
  request: AgentRunRequest,
  signal?: AbortSignal,
): AsyncGenerator<AgentRunEvent, void, undefined> {
  const { agent, ...legacyRequest } = request;
  const body = { agent, ...requestBody(legacyRequest as ClaudeRunRequest) };
  const response = await authorizedFetch(
    "/api/agents/runs",
    {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      method: "POST",
    },
    signal,
  );

  const label = agent === "codex" ? "Codex" : "Claude";
  if (!response.ok) {
    throw await getResponseError(response, `${label} could not be started`);
  }
  if (!response.body) {
    throw new Error(`${label} returned an empty response stream.`);
  }

  let eventIndex = 0;
  let terminal = false;
  for await (const line of readLines(response.body)) {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      throw new Error(`${label} returned malformed stream data.`);
    }

    const event = parseAgentEvent(payload, label);
    if (eventIndex === 0 && event.type !== "start") {
      throw new Error(`${label} returned a stream without a start event.`);
    }
    if (
      eventIndex === 0 &&
      event.type === "start" &&
      (event.agent !== agent ||
        event.repository !== request.repository ||
        event.number !== request.number)
    ) {
      throw new Error(
        `${label} returned a start event for a different agent or pull request.`,
      );
    }
    if (eventIndex > 0 && event.type === "start") {
      throw new Error(`${label} returned more than one start event.`);
    }
    if (terminal) {
      throw new Error(`${label} returned data after a terminal event.`);
    }

    eventIndex += 1;
    terminal = ["complete", "error", "cancelled", "limit"].includes(event.type);
    yield event;
  }

  if (eventIndex === 0) {
    throw new Error(`${label} returned an empty response stream.`);
  }
  if (!terminal) {
    throw new Error(`${label} disconnected before reporting completion.`);
  }
}

export const cancelClaudeRun = async (
  runId: string,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await authorizedFetch(
    `/api/claude/runs/${encodeURIComponent(runId)}`,
    {
      headers: { Accept: "application/json" },
      method: "DELETE",
    },
    signal,
  );

  if (!response.ok) {
    throw await getResponseError(response, "Claude could not be cancelled");
  }
};

export const cancelAgentRun = async (
  runId: string,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await authorizedFetch(
    `/api/agents/runs/${encodeURIComponent(runId)}`,
    {
      headers: { Accept: "application/json" },
      method: "DELETE",
    },
    signal,
  );

  if (!response.ok) {
    throw await getResponseError(
      response,
      "The agent run could not be cancelled",
    );
  }
};

export const resetActionTokenForTests = (): void => {
  cachedToken = null;
};
