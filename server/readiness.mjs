import { selectGreptileSummary } from "./greptile.mjs";
import { SEARCH_QUERY } from "./github.mjs";

const CI_STATES = new Set(["failure", "none", "pending", "success", "unknown"]);

function shortSha(sha) {
  return sha.slice(0, 7);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizeCi(ci) {
  const stateValid = CI_STATES.has(ci?.state);
  const state = stateValid ? ci.state : "unknown";
  const checks = Array.isArray(ci?.checks) ? ci.checks : [];
  const inProgress = nonNegativeInteger(ci?.inProgress) ? ci.inProgress : 0;
  const queued = nonNegativeInteger(ci?.queued)
    ? ci.queued
    : nonNegativeInteger(ci?.running)
      ? ci.running
      : 0;
  const countsValid =
    nonNegativeInteger(ci?.failed) &&
    nonNegativeInteger(ci?.passed) &&
    nonNegativeInteger(ci?.running) &&
    inProgress + queued === ci.running &&
    nonNegativeInteger(ci?.total) &&
    nonNegativeInteger(ci?.unknown) &&
    ci.failed + ci.passed + ci.running + ci.unknown === ci.total;
  const complete =
    ci?.complete === true && countsValid && stateValid && state !== "unknown";

  return {
    checks,
    complete,
    failed: countsValid ? ci.failed : 0,
    inProgress: countsValid ? inProgress : 0,
    passed: countsValid ? ci.passed : 0,
    queued: countsValid ? queued : 0,
    running: countsValid ? ci.running : 0,
    state: complete ? state : "unknown",
    total: countsValid ? ci.total : 0,
    unknown: countsValid ? ci.unknown : 0,
  };
}

export function assessPull(pull, rank) {
  const reviewThreads = Array.isArray(pull.reviewThreads)
    ? pull.reviewThreads
    : [];
  const unresolved = reviewThreads.filter(
    (thread) => thread?.isResolved === false,
  ).length;
  const unresolvedThreads = Array.isArray(pull.unresolvedThreads)
    ? pull.unresolvedThreads
    : [];
  const comments = Array.isArray(pull.comments) ? pull.comments : [];
  const summary = selectGreptileSummary(comments);
  const confidence = summary?.confidence ?? null;
  const reviewedSha = summary?.reviewedSha ?? null;
  const reviewUrl = summary?.commentUrl ?? null;
  const baseRefOid =
    typeof pull.baseRefOid === "string" ? pull.baseRefOid.toLowerCase() : "";
  const headRefOid =
    typeof pull.headRefOid === "string" ? pull.headRefOid.toLowerCase() : "";
  const ci = normalizeCi(pull.ci);
  const blockers = [];

  if (unresolved > 0) {
    blockers.push(
      `${unresolved} unresolved review ${unresolved === 1 ? "thread" : "threads"}`,
    );
  }

  if (!summary) {
    blockers.push("Greptile summary missing");
  } else {
    if (confidence === null) {
      blockers.push("Greptile confidence missing or unreadable");
    } else if (confidence !== 5) {
      blockers.push(`Greptile confidence ${confidence}/5`);
    }

    if (reviewedSha === null) {
      blockers.push("Last reviewed commit missing or unreadable");
    } else if (reviewedSha !== headRefOid) {
      blockers.push(
        `Greptile reviewed ${shortSha(reviewedSha)}; head is ${shortSha(headRefOid)}`,
      );
    }

    if (reviewUrl === null) blockers.push("Greptile review link missing");
  }

  if (pull.threadsComplete !== true) {
    blockers.push("Review threads could not be fully checked");
  }
  if (pull.commentsComplete !== true) {
    blockers.push("Greptile comments could not be fully checked");
  }

  if (ci.state === "pending") blockers.push("CI checks pending");
  else if (ci.state === "failure") blockers.push("CI checks failed");
  else if (ci.state === "unknown")
    blockers.push("CI checks could not be fully checked");

  const current = reviewedSha !== null && reviewedSha === headRefOid;
  const ready =
    pull.threadsComplete === true &&
    pull.commentsComplete === true &&
    unresolved === 0 &&
    confidence === 5 &&
    current &&
    reviewUrl !== null &&
    ci.complete &&
    (ci.state === "success" || ci.state === "none");
  const greptileComment =
    reviewUrl === null
      ? null
      : (comments.find((comment) => comment?.url === reviewUrl) ?? null);

  return {
    baseRefOid,
    blockers,
    checks: {
      commentsComplete: pull.commentsComplete === true,
      threadsComplete: pull.threadsComplete === true,
    },
    ci,
    greptile: {
      body: greptileComment?.body ?? null,
      commentId: summary?.commentId ?? null,
      commentUrl: reviewUrl,
      confidence,
      current,
      reviewedSha,
      updatedAt: summary?.updatedAt ?? null,
    },
    headRefOid,
    issueComments: comments,
    number: pull.number,
    rank,
    ready,
    repository: pull.repository,
    repositoryUrl: pull.repositoryUrl,
    title: pull.title,
    unresolved,
    unresolvedThreads,
    updatedAt: pull.updatedAt,
    url: pull.url,
  };
}

export function createReadinessSnapshot(result) {
  const pulls = result.pulls.map((pull, index) => assessPull(pull, index + 1));
  const ready = pulls.filter((pull) => pull.ready);
  const notReady = pulls.filter((pull) => !pull.ready);

  return {
    counts: {
      notReady: notReady.length,
      ready: ready.length,
      total: pulls.length,
    },
    notReady,
    partial: result.partial,
    query: SEARCH_QUERY,
    ready,
    viewerLogin: result.viewerLogin ?? null,
    warnings: [...result.warnings],
  };
}
