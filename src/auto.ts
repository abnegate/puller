import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isAgent } from "./agent";
import type { AutoParallelism, AutoTrigger } from "./fixes";
import {
  groupPulls,
  isRunActive,
  type PullRuns,
  type RunStartOutcome,
} from "./runs";
import { isTaskActive, type TaskState } from "./tasks";
import type { Agent, CICheck, PullReadiness } from "./types";

export const AUTO_SETTINGS_STORAGE_KEY = "puller-auto-settings";
export const AUTO_EVIDENCE_STORAGE_PREFIX = "puller-auto-evidence:";
export const AUTO_LOCK_PREFIX = "puller:auto-dispatcher:";

const SETTINGS_VERSION = 2;
const LEGACY_SETTINGS_VERSION = 1;
const EVIDENCE_VERSION = 3;
const LEGACY_EVIDENCE_VERSIONS = new Set([1, 2]);
const RETRY_BASE_DELAY = 1_000;
const RETRY_MAX_DELAY = 16_000;
const RETRY_MAX_EXPONENT = Math.ceil(
  Math.log2(RETRY_MAX_DELAY / RETRY_BASE_DELAY),
);
const START_GUARD_DELAY = 30_000;
const AUTO_TRIGGER_LIMIT = 64;
const GREPTILE_LOGIN = "greptile-apps";

type AutoSettings = {
  enabled: boolean;
  epoch: string | null;
  parallelism: AutoParallelism;
  version: typeof SETTINGS_VERSION;
};

type CheckObservation = {
  failed: boolean;
  failureSequence: number;
};

type PullPhase = "blocked" | "progress" | "ready";

type PullObservation = {
  baseline: {
    checks: boolean;
    comments: boolean;
    greptile: boolean;
    threads: boolean;
  };
  checks: Record<string, CheckObservation>;
  greptile: string | null;
  headRefOid: string;
  issues: Record<string, string>;
  origin: "baseline" | "new";
  phase: PullPhase | null;
  reviews: Record<string, string>;
};

type AutoIncident = {
  agent: Agent;
  identity: string;
  trigger: AutoTrigger;
};

type RebaselineCode = Extract<RunStartOutcome, { kind: "rebaseline" }>["code"];
type RevalidationCode = RebaselineCode | "pull_running";

type RebaselineObservation = {
  code: RevalidationCode;
  headRefOid: string;
  identities: string[];
};

type RetryObservation = {
  agent: Agent;
  attempt: number;
  refreshAttempt?: number;
  identities: string[];
  notBefore: number;
  rebaseline?: RebaselineObservation;
};

type AutoEvidence = {
  attempted: Record<string, string[]>;
  baseline: {
    complete: boolean;
    pulls: string[];
  };
  epoch: string;
  observed: Record<string, PullObservation>;
  pending: Record<string, AutoIncident[]>;
  retry: Record<string, RetryObservation>;
  updatedAt: string;
  version: typeof EVIDENCE_VERSION;
  viewer: string;
};

export type AutoStatus =
  | "disabled"
  | "error"
  | "paused"
  | "queued"
  | "running"
  | "standby"
  | "unavailable"
  | "watching";

export type AutoController = {
  available: boolean;
  description: string;
  enabled: boolean;
  error: string | null;
  leader: boolean;
  parallelism: AutoParallelism;
  paused: boolean;
  queued: number;
  setEnabled: (enabled: boolean) => void;
  setParallelism: (parallelism: AutoParallelism) => void;
  status: AutoStatus;
};

export type AutoInput = {
  agent: Agent;
  authoritative: boolean;
  pulls: readonly PullReadiness[];
  refresh: () => Promise<void>;
  runs: Pick<PullRuns, "start" | "states">;
  tasks: readonly TaskState[];
  viewerLogin: string | null;
};

type EngineInput = AutoInput & {
  epoch: string;
  parallelism: AutoParallelism;
  viewer: string;
};

type EngineSummary = {
  active: number;
  error: string | null;
  paused: boolean;
  queued: number;
};

type Leader = {
  claims: Set<string>;
  evidence: AutoEvidence;
  generation: number;
  refreshed: Set<string>;
  refreshClaims: Set<string>;
  retryAt: number | null;
  retryTimer: number | null;
  refresh: Promise<void> | null;
};

const EMPTY_SUMMARY: EngineSummary = {
  active: 0,
  error: null,
  paused: false,
  queued: 0,
};

const emptySettings = (): AutoSettings => ({
  enabled: false,
  epoch: null,
  parallelism: 1,
  version: SETTINGS_VERSION,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

const isCheckRecord = (
  value: unknown,
): value is Record<string, CheckObservation> =>
  isRecord(value) &&
  Object.values(value).every(
    (item) =>
      isRecord(item) &&
      typeof item.failed === "boolean" &&
      typeof item.failureSequence === "number" &&
      Number.isSafeInteger(item.failureSequence) &&
      item.failureSequence >= 0,
  );

const isAutoParallelism = (value: unknown): value is AutoParallelism =>
  value === 1 || value === 2 || value === 3 || value === 4;

const isPullPhase = (value: unknown): value is PullPhase =>
  value === "blocked" || value === "progress" || value === "ready";

const isRevalidationCode = (value: unknown): value is RevalidationCode =>
  value === "head_changed" ||
  value === "pull_ready" ||
  value === "auto_trigger_stale" ||
  value === "pull_running";

const isRebaselineObservation = (
  value: unknown,
): value is RebaselineObservation =>
  isRecord(value) &&
  isRevalidationCode(value.code) &&
  typeof value.headRefOid === "string" &&
  Array.isArray(value.identities) &&
  value.identities.every((identity) => typeof identity === "string");

const validEnabledEpoch = (
  enabled: unknown,
  epoch: unknown,
): enabled is boolean =>
  typeof enabled === "boolean" &&
  (epoch === null || typeof epoch === "string") &&
  (!enabled || (typeof epoch === "string" && epoch.length > 0));

const parseSettings = (value: string | null): AutoSettings => {
  if (value === null) return emptySettings();
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      isRecord(parsed) &&
      parsed.version === SETTINGS_VERSION &&
      validEnabledEpoch(parsed.enabled, parsed.epoch) &&
      isAutoParallelism(parsed.parallelism)
    ) {
      return parsed as AutoSettings;
    }
    if (
      isRecord(parsed) &&
      parsed.version === LEGACY_SETTINGS_VERSION &&
      validEnabledEpoch(parsed.enabled, parsed.epoch)
    ) {
      return {
        enabled: parsed.enabled,
        epoch: parsed.epoch as string | null,
        parallelism: 1,
        version: SETTINGS_VERSION,
      };
    }
  } catch {
    // A malformed setting is safely treated as disabled.
  }
  return emptySettings();
};

const readSettings = (): AutoSettings => {
  if (typeof window === "undefined") return emptySettings();
  let value: string | null;
  try {
    value = window.localStorage.getItem(AUTO_SETTINGS_STORAGE_KEY);
  } catch {
    return emptySettings();
  }

  const settings = parseSettings(value);
  if (value !== null) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        isRecord(parsed) &&
        parsed.version === LEGACY_SETTINGS_VERSION &&
        validEnabledEpoch(parsed.enabled, parsed.epoch)
      ) {
        try {
          window.localStorage.setItem(
            AUTO_SETTINGS_STORAGE_KEY,
            JSON.stringify(settings),
          );
        } catch {
          // The migrated settings remain valid for the current page.
        }
      }
    } catch {
      // parseSettings already converted malformed settings to the safe default.
    }
  }
  return settings;
};

const normalizeViewer = (viewer: string): string => viewer.trim().toLowerCase();

export const getAutoEvidenceStorageKey = (viewer: string): string =>
  `${AUTO_EVIDENCE_STORAGE_PREFIX}${normalizeViewer(viewer)}`;

export const getAutoLockName = (viewer: string): string =>
  `${AUTO_LOCK_PREFIX}${normalizeViewer(viewer)}`;

const newEvidence = (viewer: string, epoch: string): AutoEvidence => ({
  attempted: {},
  baseline: { complete: false, pulls: [] },
  epoch,
  observed: {},
  pending: {},
  retry: {},
  updatedAt: new Date().toISOString(),
  version: EVIDENCE_VERSION,
  viewer,
});

const isAutoTrigger = (value: unknown): value is AutoTrigger => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "issue_comment") {
    return typeof value.id === "string" && typeof value.updatedAt === "string";
  }
  if (value.kind === "review_comment") {
    return (
      typeof value.id === "string" &&
      typeof value.threadId === "string" &&
      typeof value.updatedAt === "string"
    );
  }
  if (value.kind === "failed_check") {
    return (
      typeof value.id === "string" &&
      (value.detailsUrl === null || typeof value.detailsUrl === "string") &&
      typeof value.headRefOid === "string"
    );
  }
  if (value.kind === "greptile") {
    return (
      typeof value.commentId === "string" &&
      typeof value.updatedAt === "string" &&
      typeof value.reviewedSha === "string" &&
      typeof value.confidence === "number"
    );
  }
  return false;
};

const parseEvidence = (
  value: string | null,
  viewer: string,
  epoch: string,
): AutoEvidence => {
  if (value === null) return newEvidence(viewer, epoch);
  try {
    const parsed: unknown = JSON.parse(value);
    const version =
      isRecord(parsed) && typeof parsed.version === "number"
        ? parsed.version
        : null;
    const legacy = version !== null && LEGACY_EVIDENCE_VERSIONS.has(version);
    const legacyAgent = version === 1;
    if (
      !isRecord(parsed) ||
      (version !== EVIDENCE_VERSION && !legacy) ||
      parsed.viewer !== viewer ||
      parsed.epoch !== epoch ||
      typeof parsed.updatedAt !== "string" ||
      !isRecord(parsed.baseline) ||
      typeof parsed.baseline.complete !== "boolean" ||
      !Array.isArray(parsed.baseline.pulls) ||
      !parsed.baseline.pulls.every((item) => typeof item === "string") ||
      !isRecord(parsed.observed) ||
      !isRecord(parsed.pending) ||
      !isRecord(parsed.attempted) ||
      !isRecord(parsed.retry)
    ) {
      return newEvidence(viewer, epoch);
    }

    const observed = Object.values(parsed.observed).every(
      (item) =>
        isRecord(item) &&
        (item.origin === "baseline" || item.origin === "new") &&
        typeof item.headRefOid === "string" &&
        isRecord(item.baseline) &&
        typeof item.baseline.checks === "boolean" &&
        typeof item.baseline.comments === "boolean" &&
        typeof item.baseline.greptile === "boolean" &&
        typeof item.baseline.threads === "boolean" &&
        isCheckRecord(item.checks) &&
        isStringRecord(item.issues) &&
        isStringRecord(item.reviews) &&
        (item.greptile === null || typeof item.greptile === "string") &&
        (legacy || item.phase === null || isPullPhase(item.phase)),
    );
    const pending = Object.values(parsed.pending).every(
      (items) =>
        Array.isArray(items) &&
        items.every(
          (item) =>
            isRecord(item) &&
            (legacyAgent ? item.agent === undefined : isAgent(item.agent)) &&
            typeof item.identity === "string" &&
            isAutoTrigger(item.trigger),
        ),
    );
    const attempted = Object.values(parsed.attempted).every(
      (items) =>
        Array.isArray(items) && items.every((item) => typeof item === "string"),
    );
    const retry = Object.values(parsed.retry).every(
      (item) =>
        isRecord(item) &&
        (legacyAgent ? item.agent === undefined : isAgent(item.agent)) &&
        typeof item.attempt === "number" &&
        Number.isSafeInteger(item.attempt) &&
        item.attempt >= 0 &&
        (item.refreshAttempt === undefined ||
          (typeof item.refreshAttempt === "number" &&
            Number.isSafeInteger(item.refreshAttempt) &&
            item.refreshAttempt >= 0)) &&
        Array.isArray(item.identities) &&
        item.identities.every((identity) => typeof identity === "string") &&
        typeof item.notBefore === "number" &&
        Number.isFinite(item.notBefore) &&
        (item.rebaseline === undefined ||
          isRebaselineObservation(item.rebaseline)),
    );

    if (!observed || !pending || !attempted || !retry) {
      return newEvidence(viewer, epoch);
    }
    if (!legacy) return parsed as AutoEvidence;

    return {
      ...(parsed as Omit<
        AutoEvidence,
        "observed" | "pending" | "retry" | "version"
      >),
      observed: Object.fromEntries(
        Object.entries(parsed.observed).map(([key, item]) => [
          key,
          {
            ...(item as Omit<PullObservation, "phase">),
            phase: null,
          },
        ]),
      ),
      pending: Object.fromEntries(
        Object.entries(parsed.pending).map(([key, items]) => [
          key,
          (items as Array<AutoIncident | Omit<AutoIncident, "agent">>).map(
            (item) => ({
              ...item,
              agent:
                "agent" in item && isAgent(item.agent)
                  ? item.agent
                  : ("claude" as const),
            }),
          ),
        ]),
      ),
      retry: Object.fromEntries(
        Object.entries(parsed.retry).map(([key, item]) => {
          const retry = item as
            RetryObservation | Omit<RetryObservation, "agent">;
          return [
            key,
            {
              ...retry,
              agent:
                "agent" in retry && isAgent(retry.agent)
                  ? retry.agent
                  : ("claude" as const),
            },
          ];
        }),
      ),
      version: EVIDENCE_VERSION,
    };
  } catch {
    return newEvidence(viewer, epoch);
  }
};

const seedActiveAutoEvidence = (
  evidence: AutoEvidence,
  previous: AutoEvidence,
  input: EngineInput,
): AutoEvidence => {
  const next = structuredClone(evidence);
  for (const [key, state] of input.runs.states) {
    if (state.source !== "auto" || !isRunActive(state)) continue;
    const observed = previous.observed[key];
    if (!observed) continue;

    next.observed[key] = {
      ...structuredClone(observed),
      phase: "progress",
    };
    const attempted = new Set(previous.attempted[key] ?? []);
    for (const identity of previous.retry[key]?.identities ?? []) {
      attempted.add(identity);
    }
    next.attempted[key] = [...attempted].sort();
    const pending = (previous.pending[key] ?? []).filter(
      (incident) => !attempted.has(incident.identity),
    );
    if (pending.length > 0) {
      next.pending[key] = structuredClone(pending);
    }
  }
  return next;
};

const readEvidence = (
  viewer: string,
  epoch: string,
  input?: EngineInput,
): AutoEvidence => {
  try {
    const key = getAutoEvidenceStorageKey(viewer);
    const raw = window.localStorage.getItem(key);
    if (raw === null) return newEvidence(viewer, epoch);

    let stored: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return newEvidence(viewer, epoch);
      stored = parsed;
    } catch {
      return newEvidence(viewer, epoch);
    }

    const storedEpoch = typeof stored.epoch === "string" ? stored.epoch : null;
    const previous =
      storedEpoch === null ? null : parseEvidence(raw, viewer, storedEpoch);
    let evidence =
      storedEpoch === epoch && previous !== null
        ? previous
        : newEvidence(viewer, epoch);
    if (storedEpoch !== epoch && previous !== null && input) {
      evidence = seedActiveAutoEvidence(evidence, previous, input);
    }

    if (raw !== null) {
      if (
        storedEpoch === epoch &&
        typeof stored.version === "number" &&
        LEGACY_EVIDENCE_VERSIONS.has(stored.version)
      ) {
        window.localStorage.setItem(key, JSON.stringify(evidence));
      }
    }
    return evidence;
  } catch {
    return newEvidence(viewer, epoch);
  }
};

const cloneEvidence = (evidence: AutoEvidence): AutoEvidence =>
  structuredClone(evidence);

const evidenceContent = (evidence: AutoEvidence): string =>
  JSON.stringify({ ...evidence, updatedAt: "" });

const pendingCount = (evidence: AutoEvidence): number =>
  Object.values(evidence.pending).reduce(
    (count, incidents) => count + incidents.length,
    0,
  );

const identity = (parts: readonly (number | string | null)[]): string =>
  JSON.stringify(parts);

const issueIncident = (
  agent: Agent,
  id: string,
  updatedAt: string,
): AutoIncident => ({
  agent,
  identity: identity(["issue", id, updatedAt]),
  trigger: { id, kind: "issue_comment", updatedAt },
});

const isGreptileComment = (
  comment: PullReadiness["issueComments"][number],
): boolean => comment.author?.toLowerCase() === GREPTILE_LOGIN;

const reviewIncident = (
  agent: Agent,
  threadId: string,
  id: string,
  updatedAt: string,
): AutoIncident => ({
  agent,
  identity: identity(["review", threadId, id, updatedAt]),
  trigger: { id, kind: "review_comment", threadId, updatedAt },
});

const greptileIncident = (
  agent: Agent,
  pull: PullReadiness,
): AutoIncident | null => {
  const { greptile } = pull;
  if (
    !pull.checks.commentsComplete ||
    greptile.current !== true ||
    greptile.commentId === null ||
    greptile.updatedAt === null ||
    greptile.reviewedSha === null ||
    greptile.reviewedSha.toLowerCase() !== pull.headRefOid.toLowerCase() ||
    greptile.confidence === null ||
    greptile.confidence >= 5
  ) {
    return null;
  }
  return {
    agent,
    identity: identity([
      "greptile",
      greptile.commentId,
      greptile.updatedAt,
      greptile.reviewedSha.toLowerCase(),
      greptile.confidence,
    ]),
    trigger: {
      commentId: greptile.commentId,
      confidence: greptile.confidence,
      kind: "greptile",
      reviewedSha: greptile.reviewedSha,
      updatedAt: greptile.updatedAt,
    },
  };
};

const checkLineage = (headRefOid: string, check: CICheck): string =>
  identity([headRefOid.toLowerCase(), check.id, check.detailsUrl]);

const replacePending = (
  pending: readonly AutoIncident[],
  kind: AutoTrigger["kind"],
  current: readonly AutoIncident[],
  attempted: ReadonlySet<string>,
): AutoIncident[] => [
  ...pending.filter((incident) => incident.trigger.kind !== kind),
  ...current
    .filter((incident) => !attempted.has(incident.identity))
    .map(
      (incident) =>
        pending.find((item) => item.identity === incident.identity) ?? incident,
    ),
];

const observePull = (
  evidence: AutoEvidence,
  pull: PullReadiness,
  baseline: boolean,
  agent: Agent,
  phaseBaseline = false,
  admit = true,
): void => {
  const key = pull.url;
  const previous = evidence.observed[key];
  const observed: PullObservation = previous ?? {
    baseline: {
      checks: false,
      comments: false,
      greptile: false,
      threads: false,
    },
    checks: {},
    greptile: null,
    headRefOid: pull.headRefOid,
    issues: {},
    origin: baseline ? "baseline" : "new",
    phase: null,
    reviews: {},
  };
  const attempted = new Set(evidence.attempted[key] ?? []);
  let pending = evidence.pending[key] ?? [];
  const alreadyPending = new Set(pending.map((incident) => incident.identity));
  const baselining = (dimension: keyof PullObservation["baseline"]): boolean =>
    observed.origin === "baseline" && !observed.baseline[dimension];
  const finish = (
    dimension: keyof PullObservation["baseline"],
    incidents: readonly AutoIncident[],
  ): void => {
    if (baselining(dimension) || phaseBaseline) {
      for (const incident of incidents) {
        if (!alreadyPending.has(incident.identity)) {
          attempted.add(incident.identity);
        }
      }
    }
    observed.baseline[dimension] = true;
  };

  if (pull.checks.commentsComplete) {
    const issues = pull.issueComments
      .filter((comment) => !isGreptileComment(comment))
      .map((comment) => issueIncident(agent, comment.id, comment.updatedAt));
    finish("comments", issues);
    pending = replacePending(
      pending,
      "issue_comment",
      admit ? issues : [],
      attempted,
    );
    observed.issues = Object.fromEntries(
      pull.issueComments
        .filter((comment) => !isGreptileComment(comment))
        .map((comment) => [comment.id, comment.updatedAt]),
    );

    const greptile = greptileIncident(agent, pull);
    const greptileIncidents = greptile === null ? [] : [greptile];
    finish("greptile", greptileIncidents);
    pending = replacePending(
      pending,
      "greptile",
      admit ? greptileIncidents : [],
      attempted,
    );
    observed.greptile = greptile?.identity ?? null;
  }

  if (pull.checks.threadsComplete) {
    const reviews = (pull.unresolvedThreads ?? []).flatMap((thread) =>
      thread.comments
        .filter((comment) => !isGreptileComment(comment))
        .map((comment) =>
          reviewIncident(agent, thread.id, comment.id, comment.updatedAt),
        ),
    );
    finish("threads", reviews);
    pending = replacePending(
      pending,
      "review_comment",
      admit ? reviews : [],
      attempted,
    );
    observed.reviews = Object.fromEntries(
      (pull.unresolvedThreads ?? []).flatMap((thread) =>
        thread.comments
          .filter((comment) => !isGreptileComment(comment))
          .map((comment) => [
            identity([thread.id, comment.id]),
            comment.updatedAt,
          ]),
      ),
    );
  }

  if (pull.ci.complete === true) {
    const checks = { ...observed.checks };
    const present = new Set<string>();
    const failures: AutoIncident[] = [];
    for (const check of pull.ci.checks ?? []) {
      const lineage = checkLineage(pull.headRefOid, check);
      present.add(lineage);
      const before = checks[lineage] ?? {
        failed: false,
        failureSequence: 0,
      };
      const failed = check.state === "failure";
      const failureSequence =
        failed && !before.failed
          ? before.failureSequence + 1
          : before.failureSequence;
      checks[lineage] = { failed, failureSequence };
      if (failed) {
        failures.push({
          agent,
          identity: identity(["check", lineage, failureSequence]),
          trigger: {
            detailsUrl: check.detailsUrl,
            headRefOid: pull.headRefOid,
            id: check.id,
            kind: "failed_check",
          },
        });
      }
    }
    for (const [lineage, check] of Object.entries(checks)) {
      if (!present.has(lineage) && check.failed) {
        checks[lineage] = { ...check, failed: false };
      }
    }
    finish("checks", failures);
    pending = replacePending(
      pending,
      "failed_check",
      admit ? failures : [],
      attempted,
    );
    observed.checks = checks;
  }

  observed.headRefOid = pull.headRefOid;
  evidence.observed[key] = observed;
  evidence.attempted[key] = [...attempted].sort();
  if (pending.length === 0) delete evidence.pending[key];
  else {
    evidence.pending[key] = pending.sort((left, right) =>
      left.identity.localeCompare(right.identity),
    );
  }

  const retry = evidence.retry[key];
  const pendingByIdentity = new Map(
    (evidence.pending[key] ?? []).map((incident) => [
      incident.identity,
      incident,
    ]),
  );
  if (
    retry &&
    retry.identities.some(
      (item) => pendingByIdentity.get(item)?.agent !== retry.agent,
    )
  ) {
    const current = evidence.pending[key] ?? [];
    if (retry.rebaseline?.code === "pull_running" && current.length > 0) {
      const agent = current[0]!.agent;
      const incidents = current.filter((incident) => incident.agent === agent);
      const identities = incidents.map((incident) => incident.identity);
      evidence.retry[key] = {
        ...retry,
        agent,
        identities,
        rebaseline: {
          code: "pull_running",
          headRefOid: pull.headRefOid,
          identities,
        },
      };
    } else {
      delete evidence.retry[key];
    }
  }
};

const evidenceComplete = (pull: PullReadiness): boolean =>
  pull.ci.complete === true &&
  pull.checks.commentsComplete &&
  pull.checks.threadsComplete;

const phaseOf = (input: EngineInput, pull: PullReadiness): PullPhase => {
  if (input.tasks.some((state) => sameTaskPull(state, pull))) {
    return "progress";
  }

  const groups = groupPulls([pull], input.runs.states);
  if (groups.progress.length > 0) return "progress";
  if (groups.ready.length > 0) return "ready";
  return "blocked";
};

const progressObservation = (
  pull: PullReadiness,
  origin: PullObservation["origin"],
): PullObservation => ({
  baseline: {
    checks: false,
    comments: false,
    greptile: false,
    threads: false,
  },
  checks: {},
  greptile: null,
  headRefOid: pull.headRefOid,
  issues: {},
  origin,
  phase: "progress",
  reviews: {},
});

const reconcileEvidence = (
  evidence: AutoEvidence,
  input: EngineInput,
): AutoEvidence => {
  if (!input.authoritative) return evidence;
  const next = cloneEvidence(evidence);
  const initial = !next.baseline.complete;
  if (initial) {
    next.baseline.complete = true;
    next.baseline.pulls = input.pulls.map((pull) => pull.url).sort();
  }

  for (const pull of input.pulls) {
    const phase = phaseOf(input, pull);
    const observed = next.observed[pull.url];

    if (phase === "progress") {
      if (observed) {
        if (observed.phase === null) continue;
        observed.phase = phase;
      } else {
        next.observed[pull.url] = progressObservation(pull, "new");
      }
      continue;
    }

    if (!evidenceComplete(pull)) {
      continue;
    }

    if (!observed) {
      observePull(
        next,
        pull,
        initial,
        input.agent,
        initial,
        phase === "blocked",
      );
      next.observed[pull.url]!.phase = phase;
      continue;
    }

    if (observed.phase === null) {
      observePull(next, pull, initial, input.agent, true, phase === "blocked");
      next.observed[pull.url]!.phase = phase;
      continue;
    }

    observePull(next, pull, initial, input.agent, false, phase === "blocked");
    next.observed[pull.url]!.phase = phase;
  }

  const present = new Set(input.pulls.map((pull) => pull.url));
  for (const key of Object.keys(next.observed)) {
    if (present.has(key)) continue;
    delete next.observed[key];
    delete next.pending[key];
    delete next.attempted[key];
    delete next.retry[key];
  }
  for (const key of Object.keys(next.retry)) {
    if ((next.pending[key]?.length ?? 0) === 0) {
      delete next.retry[key];
    }
  }
  next.baseline.pulls = next.baseline.pulls.filter((key) => present.has(key));
  return next;
};

const retryDelay = (attempt: number): number =>
  RETRY_BASE_DELAY *
  2 ** Math.min(Math.max(0, attempt - 1), RETRY_MAX_EXPONENT);

const pullOrder = (pulls: readonly PullReadiness[]): readonly PullReadiness[] =>
  [...pulls].sort(
    (left, right) =>
      left.rank - right.rank || left.url.localeCompare(right.url),
  );

const dispatchIncidents = (
  pending: readonly AutoIncident[],
  retry?: RetryObservation,
): AutoIncident[] => {
  if (retry) {
    const byIdentity = new Map(
      pending.map((incident) => [incident.identity, incident]),
    );
    const retried = retry.identities.flatMap((item) => {
      const incident = byIdentity.get(item);
      return incident?.agent === retry.agent ? [incident] : [];
    });
    if (retried.length === retry.identities.length) return retried;
  }
  const agent = pending[0]?.agent;
  if (agent === undefined) return [];
  return pending
    .filter((incident) => incident.agent === agent)
    .slice(0, AUTO_TRIGGER_LIMIT);
};

const sameIdentities = (
  first: readonly string[],
  second: readonly string[],
): boolean => {
  if (first.length !== second.length) return false;
  const expected = new Set(first);
  return second.every((identity) => expected.has(identity));
};

const revalidationKey = (
  pullUrl: string,
  observation: RebaselineObservation,
): string =>
  [
    pullUrl,
    observation.code,
    observation.headRefOid.toLowerCase(),
    [...observation.identities].sort().join("\n"),
  ].join("\n");

const recordPullRunningRefresh = (
  evidence: AutoEvidence,
  claims: ReadonlySet<string>,
  succeeded: boolean,
  now: number,
): {
  evidence: AutoEvidence;
  matched: string[];
  retryAt: number | null;
} => {
  const next = cloneEvidence(evidence);
  const matched: string[] = [];
  let retryAt: number | null = null;

  for (const [pullUrl, retry] of Object.entries(next.retry)) {
    const observation = retry.rebaseline;
    if (observation?.code !== "pull_running") continue;
    const claim = revalidationKey(pullUrl, observation);
    if (!claims.has(claim)) continue;

    matched.push(claim);
    if (succeeded) {
      retry.refreshAttempt = 0;
      continue;
    }

    const refreshAttempt = Math.min(
      (retry.refreshAttempt ?? 0) + 1,
      RETRY_MAX_EXPONENT + 1,
    );
    const notBefore = now + retryDelay(refreshAttempt);
    retry.refreshAttempt = refreshAttempt;
    retry.notBefore = notBefore;
    retryAt = retryAt === null ? notBefore : Math.min(retryAt, notBefore);
  }

  return { evidence: next, matched, retryAt };
};

const hasFreshRebaselineEvidence = (
  leader: Leader,
  retry: RetryObservation,
  pull: PullReadiness,
  pending: readonly AutoIncident[],
): boolean => {
  const stale = retry.rebaseline;
  if (!stale) return true;
  if (stale.code === "pull_running") {
    return leader.refreshed.has(revalidationKey(pull.url, stale));
  }
  if (stale.headRefOid.toLowerCase() !== pull.headRefOid.toLowerCase()) {
    return true;
  }

  return !sameIdentities(
    stale.identities,
    pending.map((incident) => incident.identity),
  );
};

const sameTaskPull = (state: TaskState, pull: PullReadiness): boolean =>
  isTaskActive(state.task) &&
  state.task.repository.toLowerCase() === pull.repository.toLowerCase() &&
  state.task.pullRequest?.number === pull.number;

const isPullBusy = (input: EngineInput, pull: PullReadiness): boolean =>
  isRunActive(input.runs.states.get(pull.url)) ||
  input.tasks.some((state) => sameTaskPull(state, pull));

const activeAutoKeys = (leader: Leader, input: EngineInput): Set<string> => {
  const keys = new Set(leader.claims);
  for (const [key, state] of input.runs.states) {
    if (state.source === "auto" && isRunActive(state)) keys.add(key);
  }
  return keys;
};

const markAttempted = (
  evidence: AutoEvidence,
  key: string,
  identities: readonly string[],
): void => {
  const attempted = new Set(evidence.attempted[key] ?? []);
  for (const incident of identities) attempted.add(incident);
  evidence.attempted[key] = [...attempted].sort();
  const marked = new Set(identities);
  const pending = (evidence.pending[key] ?? []).filter(
    (incident) => !marked.has(incident.identity),
  );
  if (pending.length === 0) delete evidence.pending[key];
  else evidence.pending[key] = pending;
  delete evidence.retry[key];
};

const summarizeEvidence = (evidence: AutoEvidence): EngineSummary => ({
  ...EMPTY_SUMMARY,
  queued: pendingCount(evidence),
});

const writeEvidence = (evidence: AutoEvidence): void => {
  window.localStorage.setItem(
    getAutoEvidenceStorageKey(evidence.viewer),
    JSON.stringify(evidence),
  );
};

const describe = (
  available: boolean,
  enabled: boolean,
  visible: boolean,
  leader: boolean,
  summary: EngineSummary,
): { description: string; paused: boolean; status: AutoStatus } => {
  if (!available) {
    return {
      description:
        "Auto is unavailable because this browser does not support Web Locks.",
      paused: true,
      status: "unavailable",
    };
  }
  if (!enabled) {
    return { description: "Auto is off.", paused: false, status: "disabled" };
  }
  if (!visible) {
    return {
      description: "Auto is paused while this tab is hidden.",
      paused: true,
      status: "paused",
    };
  }
  if (!leader) {
    return {
      description: "Auto is watching in another tab.",
      paused: false,
      status: "standby",
    };
  }
  if (summary.error) {
    return {
      description: summary.error,
      paused: summary.paused,
      status: "error",
    };
  }
  if (summary.active > 0) {
    return {
      description:
        summary.active === 1
          ? "Auto is fixing a pull request."
          : `Auto is fixing ${summary.active} pull requests.`,
      paused: false,
      status: "running",
    };
  }
  if (summary.paused) {
    return {
      description: `${summary.queued} Auto ${summary.queued === 1 ? "issue is" : "issues are"} waiting for an active task or retry.`,
      paused: true,
      status: "paused",
    };
  }
  if (summary.queued > 0) {
    return {
      description: `${summary.queued} Auto ${summary.queued === 1 ? "issue is" : "issues are"} queued.`,
      paused: false,
      status: "queued",
    };
  }
  return {
    description: "Auto is watching for new pull request blockers.",
    paused: false,
    status: "watching",
  };
};

const newEpoch = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const webLocksAvailable = (): boolean =>
  typeof navigator !== "undefined" &&
  "locks" in navigator &&
  navigator.locks !== undefined &&
  typeof navigator.locks.request === "function";

export function useAuto({
  agent,
  authoritative,
  pulls,
  refresh,
  runs,
  tasks,
  viewerLogin,
}: AutoInput): AutoController {
  const [settings, setSettings] = useState<AutoSettings>(readSettings);
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [leader, setLeader] = useState(false);
  const [summary, setSummary] = useState<EngineSummary>(EMPTY_SUMMARY);
  const available = webLocksAvailable();
  const normalizedViewer = viewerLogin ? normalizeViewer(viewerLogin) : null;
  const inputRef = useRef<EngineInput | null>(null);
  const leaderRef = useRef<Leader | null>(null);
  const processingRef = useRef<number | null>(null);
  const rerunRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const processRef = useRef<() => void>(() => undefined);

  inputRef.current =
    normalizedViewer && settings.epoch
      ? {
          agent,
          authoritative,
          epoch: settings.epoch,
          parallelism: settings.parallelism,
          pulls,
          refresh,
          runs,
          tasks,
          viewer: normalizedViewer,
          viewerLogin,
        }
      : null;

  const publish = useCallback((next: EngineSummary): void => {
    if (!mountedRef.current) return;
    setSummary((current) =>
      current.active === next.active &&
      current.error === next.error &&
      current.paused === next.paused &&
      current.queued === next.queued
        ? current
        : next,
    );
  }, []);

  const commit = useCallback(
    (
      current: Leader,
      next: AutoEvidence,
      change: Partial<EngineSummary> | false = {},
    ): boolean => {
      if (leaderRef.current !== current) return false;
      const changed =
        evidenceContent(current.evidence) !== evidenceContent(next);
      if (changed) {
        next.updatedAt = new Date().toISOString();
        current.evidence = next;
        try {
          writeEvidence(next);
        } catch (error) {
          const input = inputRef.current;
          publish({
            ...summarizeEvidence(next),
            active:
              input && input.epoch === next.epoch
                ? activeAutoKeys(current, input).size
                : current.claims.size,
            error:
              error instanceof Error
                ? `Auto evidence could not be saved: ${error.message}`
                : "Auto evidence could not be saved.",
            paused: true,
            ...(change === false ? {} : change),
          });
          return false;
        }
      } else {
        current.evidence = next;
      }
      if (change !== false) {
        const input = inputRef.current;
        publish({
          ...summarizeEvidence(next),
          active:
            input && input.epoch === next.epoch
              ? activeAutoKeys(current, input).size
              : current.claims.size,
          ...change,
        });
      }
      return true;
    },
    [publish],
  );

  const scheduleRetry = useCallback(
    (current: Leader, notBefore: number): void => {
      if (current.retryAt !== null && current.retryAt <= notBefore) return;
      if (current.retryTimer !== null) window.clearTimeout(current.retryTimer);
      current.retryAt = notBefore;
      current.retryTimer = window.setTimeout(
        () => {
          current.retryAt = null;
          current.retryTimer = null;
          processRef.current();
        },
        Math.max(0, notBefore - Date.now()),
      );
    },
    [],
  );

  const requestRefresh = useCallback(
    (
      current: Leader,
      input: EngineInput,
      claims: readonly string[] = [],
    ): Promise<void> => {
      for (const claim of claims) current.refreshClaims.add(claim);
      if (current.refresh !== null) return current.refresh;

      let activeClaims = new Set<string>();
      const task = Promise.resolve().then(() => {
        activeClaims = new Set(current.refreshClaims);
        current.refreshClaims.clear();
        return input.refresh();
      });
      current.refresh = task;
      void task
        .then(
          () => {
            if (
              leaderRef.current !== current ||
              current.generation !== generationRef.current
            ) {
              return;
            }
            const result = recordPullRunningRefresh(
              current.evidence,
              activeClaims,
              true,
              Date.now(),
            );
            commit(current, result.evidence, false);
            for (const claim of result.matched) {
              current.refreshed.add(claim);
            }
          },
          () => {
            if (
              leaderRef.current !== current ||
              current.generation !== generationRef.current
            ) {
              return;
            }
            const result = recordPullRunningRefresh(
              current.evidence,
              activeClaims,
              false,
              Date.now(),
            );
            commit(current, result.evidence, false);
            if (result.retryAt !== null) {
              scheduleRetry(current, result.retryAt);
            }
          },
        )
        .finally(() => {
          if (
            leaderRef.current !== current ||
            current.generation !== generationRef.current
          ) {
            return;
          }
          current.refresh = null;
          if (current.refreshClaims.size > 0) {
            void requestRefresh(current, input);
          } else {
            processRef.current();
          }
        });
      return task;
    },
    [commit, scheduleRetry],
  );

  const launch = useCallback(
    (
      current: Leader,
      input: EngineInput,
      pull: PullReadiness,
      incidents: readonly AutoIncident[],
    ): void => {
      const key = pull.url;
      const identities = incidents.map((incident) => incident.identity);

      void (async () => {
        let outcome: RunStartOutcome;
        try {
          outcome = await input.runs.start(pull, {
            agent: incidents[0]!.agent,
            message: "",
            parallelism: input.parallelism,
            source: "auto",
            triggers: incidents.map((incident) => incident.trigger),
          });
        } catch (error) {
          outcome = {
            code: "transport",
            kind: "retryable",
            message:
              error instanceof Error
                ? error.message
                : "The automatic run could not be started.",
            source: "auto",
          };
        }
        if (
          leaderRef.current !== current ||
          current.generation !== generationRef.current
        ) {
          return;
        }

        const next = cloneEvidence(current.evidence);
        if (outcome.kind === "accepted") {
          markAttempted(next, key, identities);
          if (!commit(current, next)) return;

          const settle = (): void => {
            if (
              leaderRef.current !== current ||
              current.generation !== generationRef.current
            ) {
              return;
            }
            current.claims.delete(key);
            commit(current, current.evidence);
            processRef.current();
          };
          void outcome.completion.then(settle, settle);
          processRef.current();
          return;
        }

        current.claims.delete(key);
        if (outcome.kind === "accepted-equivalent") {
          markAttempted(next, key, identities);
          if (commit(current, next)) processRef.current();
          return;
        }

        if (outcome.kind === "retryable") {
          const previous = current.evidence.retry[key];
          const attempt = Math.min(
            (previous?.attempt ?? 0) + 1,
            RETRY_MAX_EXPONENT + 1,
          );
          const notBefore = Date.now() + retryDelay(attempt);
          const rebaseline =
            outcome.code === "pull_running"
              ? {
                  code: outcome.code,
                  headRefOid: pull.headRefOid,
                  identities,
                }
              : undefined;
          next.retry[key] = {
            agent: incidents[0]!.agent,
            attempt,
            ...(rebaseline === undefined
              ? {}
              : {
                  refreshAttempt:
                    previous?.rebaseline?.code === "pull_running"
                      ? (previous.refreshAttempt ?? 0)
                      : 0,
                }),
            identities,
            notBefore,
            ...(rebaseline === undefined ? {} : { rebaseline }),
          };
          if (commit(current, next, { error: null, paused: true })) {
            scheduleRetry(current, notBefore);
            if (rebaseline !== undefined) {
              const claim = revalidationKey(key, rebaseline);
              current.refreshed.delete(claim);
              void requestRefresh(current, input, [claim]);
            }
            processRef.current();
          }
          return;
        }

        if (outcome.kind === "rebaseline") {
          const previous = current.evidence.retry[key];
          const attempt = Math.min(
            (previous?.attempt ?? 0) + 1,
            RETRY_MAX_EXPONENT + 1,
          );
          const notBefore = Date.now() + retryDelay(attempt);
          next.retry[key] = {
            agent: incidents[0]!.agent,
            attempt,
            identities,
            notBefore,
            rebaseline: {
              code: outcome.code,
              headRefOid: pull.headRefOid,
              identities,
            },
          };
          if (commit(current, next, { error: null, paused: true })) {
            scheduleRetry(current, notBefore);
            void requestRefresh(current, input);
            processRef.current();
          }
          return;
        }

        if (outcome.kind === "prune") {
          delete next.observed[key];
          delete next.pending[key];
          delete next.attempted[key];
          delete next.retry[key];
          next.baseline.pulls = next.baseline.pulls.filter(
            (pullKey) => pullKey !== key,
          );
        } else {
          markAttempted(next, key, identities);
        }
        if (
          commit(current, next, {
            error:
              outcome.kind === "failed"
                ? `Auto could not start for ${pull.repository} #${pull.number}: ${outcome.message}`
                : null,
            paused: false,
          })
        ) {
          processRef.current();
        }
      })();
    },
    [commit, requestRefresh, scheduleRetry],
  );

  const process = useCallback((): void => {
    const current = leaderRef.current;
    const input = inputRef.current;
    if (!current || !input || current.generation !== generationRef.current)
      return;
    if (processingRef.current === current.generation) {
      rerunRef.current = true;
      return;
    }
    processingRef.current = current.generation;
    try {
      do {
        rerunRef.current = false;
        const active = leaderRef.current;
        const latest = inputRef.current;
        if (
          active !== current ||
          latest === null ||
          current.generation !== generationRef.current
        ) {
          return;
        }

        if (!latest.authoritative) {
          commit(current, current.evidence, { paused: true });
          return;
        }

        const reconciled = reconcileEvidence(current.evidence, latest);
        if (!commit(current, reconciled, false)) return;
        if (!reconciled.baseline.complete) {
          commit(current, reconciled);
          return;
        }

        const now = Date.now();
        const work = activeAutoKeys(current, latest);
        let slots = Math.max(0, latest.parallelism - work.size);
        let retryAt: number | null = null;
        let refreshNeeded = false;
        const refreshClaims: string[] = [];
        let waiting = false;
        const guarded = cloneEvidence(reconciled);
        const launches: Array<{
          incidents: AutoIncident[];
          pull: PullReadiness;
        }> = [];

        for (const pull of pullOrder(latest.pulls)) {
          const pending = reconciled.pending[pull.url] ?? [];
          if (pending.length === 0) {
            delete guarded.retry[pull.url];
            continue;
          }
          const phase = phaseOf(latest, pull);
          const retry = reconciled.retry[pull.url];
          const autoBusy = work.has(pull.url);
          const busy = autoBusy || isPullBusy(latest, pull);
          if (retry?.rebaseline && phase === "ready") {
            markAttempted(
              guarded,
              pull.url,
              pending.map((incident) => incident.identity),
            );
            continue;
          }
          if (autoBusy) {
            waiting = true;
            continue;
          }
          if (busy) {
            const identities = pending.map((incident) => incident.identity);
            const rebaseline: RebaselineObservation = {
              code: "pull_running",
              headRefOid: pull.headRefOid,
              identities,
            };
            guarded.retry[pull.url] = {
              agent: retry?.agent ?? pending[0]!.agent,
              attempt: retry?.attempt ?? 0,
              refreshAttempt:
                retry?.rebaseline?.code === "pull_running"
                  ? (retry.refreshAttempt ?? 0)
                  : 0,
              identities,
              notBefore: now,
              rebaseline,
            };
            current.refreshed.delete(revalidationKey(pull.url, rebaseline));
            waiting = true;
            continue;
          }
          if (!evidenceComplete(pull) || phase !== "blocked") {
            waiting = true;
            continue;
          }
          if (
            retry?.rebaseline &&
            !hasFreshRebaselineEvidence(current, retry, pull, pending)
          ) {
            waiting = true;
            if (current.refresh !== null) continue;
            if (retry.notBefore > now) {
              retryAt =
                retryAt === null
                  ? retry.notBefore
                  : Math.min(retryAt, retry.notBefore);
              continue;
            }

            if (retry.rebaseline.code === "pull_running") {
              refreshClaims.push(revalidationKey(pull.url, retry.rebaseline));
            } else {
              const attempt = Math.min(
                retry.attempt + 1,
                RETRY_MAX_EXPONENT + 1,
              );
              const notBefore = now + retryDelay(attempt);
              guarded.retry[pull.url] = {
                ...retry,
                attempt,
                notBefore,
              };
              retryAt =
                retryAt === null ? notBefore : Math.min(retryAt, notBefore);
            }
            refreshNeeded = true;
            continue;
          }
          if (retry && retry.notBefore > now) {
            retryAt =
              retryAt === null
                ? retry.notBefore
                : Math.min(retryAt, retry.notBefore);
            waiting = true;
            continue;
          }
          if (slots === 0) {
            waiting = true;
            continue;
          }

          const incidents = dispatchIncidents(pending, retry);
          if (incidents.length === 0) continue;
          const identities = incidents.map((incident) => incident.identity);
          if (retry?.rebaseline !== undefined) {
            current.refreshed.delete(
              revalidationKey(pull.url, retry.rebaseline),
            );
          }
          current.claims.add(pull.url);
          work.add(pull.url);
          slots -= 1;
          guarded.retry[pull.url] = {
            agent: incidents[0]!.agent,
            attempt: guarded.retry[pull.url]?.attempt ?? 0,
            identities,
            notBefore: now + START_GUARD_DELAY,
          };
          launches.push({ incidents, pull });
        }

        if (!commit(current, guarded, { paused: waiting })) {
          for (const item of launches) current.claims.delete(item.pull.url);
          return;
        }
        if (retryAt !== null) scheduleRetry(current, retryAt);
        if (refreshNeeded) {
          void requestRefresh(current, latest, refreshClaims);
        }
        for (const item of launches) {
          launch(current, latest, item.pull, item.incidents);
        }
      } while (rerunRef.current);
    } finally {
      if (processingRef.current === current.generation) {
        processingRef.current = null;
        if (rerunRef.current) processRef.current();
      }
    }
  }, [commit, launch, requestRefresh, scheduleRetry]);

  processRef.current = process;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleVisibility = (): void => {
      setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (
        event.storageArea !== null &&
        event.storageArea !== window.localStorage
      )
        return;
      if (event.key === AUTO_SETTINGS_STORAGE_KEY) {
        setSettings(parseSettings(event.newValue));
        return;
      }
      if (
        normalizedViewer &&
        settings.epoch &&
        event.key === getAutoEvidenceStorageKey(normalizedViewer) &&
        leaderRef.current === null
      ) {
        const evidence = parseEvidence(
          event.newValue,
          normalizedViewer,
          settings.epoch,
        );
        setSummary(summarizeEvidence(evidence));
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [normalizedViewer, settings.epoch]);

  useEffect(() => {
    if (
      normalizedViewer === null ||
      settings.epoch === null ||
      leaderRef.current !== null
    ) {
      return;
    }
    setSummary(
      summarizeEvidence(readEvidence(normalizedViewer, settings.epoch)),
    );
  }, [normalizedViewer, settings.epoch]);

  useEffect(() => {
    processRef.current();
  }, [agent, authoritative, pulls, runs.states, settings.parallelism, tasks]);

  useEffect(() => {
    if (
      !available ||
      !settings.enabled ||
      settings.epoch === null ||
      normalizedViewer === null ||
      !visible
    ) {
      setLeader(false);
      if (!settings.enabled) setSummary(EMPTY_SUMMARY);
      return;
    }

    const generation = ++generationRef.current;
    const controller = new AbortController();
    let cancelled = false;
    let release: (() => void) | null = null;

    void navigator.locks
      .request(
        getAutoLockName(normalizedViewer),
        { mode: "exclusive", signal: controller.signal },
        async () => {
          if (cancelled || controller.signal.aborted) return;
          const input = inputRef.current;
          const acquired: Leader = {
            claims: new Set(),
            evidence: readEvidence(
              normalizedViewer,
              settings.epoch!,
              input ?? undefined,
            ),
            generation,
            refreshed: new Set(),
            refresh: null,
            refreshClaims: new Set(),
            retryAt: null,
            retryTimer: null,
          };
          leaderRef.current = acquired;
          setLeader(true);
          setSummary(summarizeEvidence(acquired.evidence));
          processRef.current();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (acquired.retryTimer !== null)
            window.clearTimeout(acquired.retryTimer);
          acquired.refresh = null;
          acquired.retryAt = null;
          if (leaderRef.current === acquired) leaderRef.current = null;
          if (mountedRef.current) setLeader(false);
        },
      )
      .catch((error: unknown) => {
        if (
          !cancelled &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setSummary({
            ...EMPTY_SUMMARY,
            error:
              error instanceof Error
                ? `Auto lock failed: ${error.message}`
                : "Auto lock failed.",
            paused: true,
          });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
      const current = leaderRef.current;
      const refresh =
        current?.generation === generation ? current.refresh : null;
      if (refresh === null) {
        release?.();
      } else {
        void refresh.then(
          () => release?.(),
          () => release?.(),
        );
      }
      if (current?.generation === generation) {
        if (current.retryTimer !== null)
          window.clearTimeout(current.retryTimer);
        current.refresh = null;
        current.retryAt = null;
        leaderRef.current = null;
      }
      generationRef.current += 1;
      if (processingRef.current === generation) processingRef.current = null;
      rerunRef.current = false;
      setLeader(false);
    };
  }, [available, normalizedViewer, settings.enabled, settings.epoch, visible]);

  const setEnabled = useCallback((enabled: boolean): void => {
    setSettings((current) => {
      if (current.enabled === enabled) return current;
      const next: AutoSettings = {
        enabled,
        epoch: enabled ? newEpoch() : current.epoch,
        parallelism: current.parallelism,
        version: SETTINGS_VERSION,
      };
      try {
        window.localStorage.setItem(
          AUTO_SETTINGS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The current page can still use the setting; the status reports evidence errors.
      }
      return next;
    });
  }, []);

  const setParallelism = useCallback((parallelism: AutoParallelism): void => {
    if (!isAutoParallelism(parallelism)) return;
    setSettings((current) => {
      if (current.parallelism === parallelism) return current;
      const next: AutoSettings = { ...current, parallelism };
      try {
        window.localStorage.setItem(
          AUTO_SETTINGS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The current page can still use the selected parallelism.
      }
      return next;
    });
  }, []);

  const state = describe(available, settings.enabled, visible, leader, summary);

  return useMemo(
    () => ({
      available,
      description: state.description,
      enabled: settings.enabled,
      error: summary.error,
      leader,
      parallelism: settings.parallelism,
      paused: state.paused,
      queued: summary.queued,
      setEnabled,
      setParallelism,
      status: state.status,
    }),
    [
      available,
      leader,
      setEnabled,
      setParallelism,
      settings.enabled,
      settings.parallelism,
      state.description,
      state.paused,
      state.status,
      summary.error,
      summary.queued,
    ],
  );
}
