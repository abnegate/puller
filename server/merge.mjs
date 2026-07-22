import { ActionError } from "./claude.mjs";
import { ExecutorError } from "./executor.mjs";
import { assessPull } from "./readiness.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const SUCCESS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function canonicalRepository(value) {
  if (
    typeof value !== "string" ||
    !REPOSITORY.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ActionError(
      400,
      "invalid_repository",
      "The repository is invalid.",
    );
  }
  return value;
}

function canonicalUrl(repository, number) {
  return `https://github.com/${repository}/pull/${number}`;
}

function pullFrom(result) {
  if (result?.pull && typeof result.pull === "object") {
    const readiness =
      typeof result.pull.ready === "boolean"
        ? result.pull
        : assessPull(result.pull, 1);
    return { ...result, ...result.pull, ...readiness };
  }
  if (result?.data?.pull && typeof result.data.pull === "object") {
    return { ...result.data, ...result.data.pull };
  }
  return result;
}

function viewerFrom(result, pull) {
  return (
    result?.viewerLogin ?? result?.viewer?.login ?? pull?.viewerLogin ?? null
  );
}

function incomplete(result, pull) {
  return (
    !result ||
    result.available === false ||
    result.stale === true ||
    result.partial === true ||
    result.complete === false ||
    pull?.available === false ||
    pull?.partial === true ||
    pull?.complete === false
  );
}

function openState(pull) {
  return (
    pull?.state === "OPEN" ||
    pull?.state === "open" ||
    pull?.open === true ||
    pull?.isOpen === true
  );
}

function readinessComplete(pull) {
  const ci = pull?.ci;
  const checks = pull?.checks;
  const ciComplete =
    ci?.complete === true ||
    (ci?.state === "none" &&
      Number(ci?.total ?? 0) === 0 &&
      ci?.complete !== false);
  const greptile = pull?.greptile;
  return (
    pull?.ready === true &&
    Array.isArray(pull?.blockers) &&
    pull.blockers.length === 0 &&
    pull?.unresolved === 0 &&
    checks?.threadsComplete === true &&
    checks?.commentsComplete === true &&
    ciComplete &&
    (ci?.state === "success" || ci?.state === "none") &&
    greptile?.confidence === 5 &&
    typeof greptile?.commentUrl === "string" &&
    greptile.commentUrl !== "" &&
    typeof greptile?.reviewedSha === "string" &&
    greptile.reviewedSha.toLowerCase() === pull.headRefOid.toLowerCase()
  );
}

function serviceError(error, code, message) {
  if (error instanceof ActionError) return error;
  if (error instanceof ExecutorError) {
    return new ActionError(error.status, code, message);
  }
  return new ActionError(502, code, message);
}

function settle(result) {
  void Promise.resolve(result).catch(() => undefined);
}

function headRepositoryFrom(value) {
  return (
    value?.headRepository?.nameWithOwner ??
    (typeof value?.headRepository?.name === "string" &&
    typeof value?.headRepositoryOwner?.login === "string"
      ? `${value.headRepositoryOwner.login}/${value.headRepository.name}`
      : null)
  );
}

function checksGreen(value) {
  return (
    Array.isArray(value?.statusCheckRollup) &&
    value.statusCheckRollup.every((check) => {
      if (
        check?.__typename === "StatusContext" ||
        typeof check?.state === "string"
      ) {
        return check.state === "SUCCESS";
      }
      return (
        check?.status === "COMPLETED" &&
        SUCCESS_CONCLUSIONS.has(check?.conclusion)
      );
    })
  );
}

export function mergeFailureArguments(repository, number) {
  return [
    "pr",
    "view",
    canonicalUrl(repository, number),
    "--json",
    "number,url,state,headRefOid,baseRefOid,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus,statusCheckRollup",
  ];
}

export function confirmedConflict(value, input) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const expectedUrl = canonicalUrl(input.repository, input.number);
  const sameIdentity =
    value.number === input.number &&
    value.url === expectedUrl &&
    openState(value) &&
    typeof value.headRefOid === "string" &&
    value.headRefOid.toLowerCase() === input.expectedHeadRefOid &&
    typeof value.baseRefOid === "string" &&
    SHA.test(value.baseRefOid) &&
    typeof value.headRefName === "string" &&
    value.headRefName !== "" &&
    typeof value.baseRefName === "string" &&
    value.baseRefName !== "";
  const conflicts =
    value.mergeable === "CONFLICTING" || value.mergeStateStatus === "DIRTY";
  if (!sameIdentity || !conflicts || !checksGreen(value)) return null;

  return {
    baseRefName: value.baseRefName,
    expectedBaseRefOid: value.baseRefOid.toLowerCase(),
    expectedHeadRefOid: input.expectedHeadRefOid,
    headRefName: value.headRefName,
    headRepository: headRepositoryFrom(value),
    isCrossRepository: value.isCrossRepository,
    maintainerCanModify: value.maintainerCanModify,
    number: input.number,
    repository: input.repository,
  };
}

export function validateMergeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActionError(
      400,
      "invalid_request",
      "The merge request is invalid.",
    );
  }
  const repository = canonicalRepository(value.repository);
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw new ActionError(
      400,
      "invalid_number",
      "The pull request number is invalid.",
    );
  }
  if (
    typeof value.expectedHeadRefOid !== "string" ||
    !SHA.test(value.expectedHeadRefOid)
  ) {
    throw new ActionError(
      400,
      "invalid_head",
      "The expected pull request head is invalid.",
    );
  }
  return {
    repository,
    number: value.number,
    expectedHeadRefOid: value.expectedHeadRefOid.toLowerCase(),
  };
}

export function createMergeService({
  executor,
  loadPull,
  repairManager = null,
  invalidate = () => undefined,
  refetch = () => undefined,
} = {}) {
  if (!executor || typeof executor.action !== "function") {
    throw new TypeError("A GitHub executor is required.");
  }
  if (typeof loadPull !== "function") {
    throw new TypeError("A fresh pull request loader is required.");
  }

  const active = new Set();

  return Object.freeze({
    async merge(value) {
      const input = validateMergeInput(value);
      const key = `${input.repository.toLowerCase()}#${input.number}`;
      if (active.has(key)) {
        throw new ActionError(
          409,
          "merge_running",
          "This pull request is already being merged.",
        );
      }
      active.add(key);

      try {
        let result;
        try {
          result = await loadPull({
            repository: input.repository,
            number: input.number,
            refresh: true,
          });
        } catch {
          throw new ActionError(
            503,
            "pull_unavailable",
            "A complete fresh pull request check is required before merging.",
          );
        }

        const pull = pullFrom(result);
        const viewerLogin = viewerFrom(result, pull);
        if (
          incomplete(result, pull) ||
          !pull ||
          typeof viewerLogin !== "string"
        ) {
          throw new ActionError(
            503,
            "pull_unavailable",
            "A complete fresh pull request check is required before merging.",
          );
        }

        if (
          typeof result?.headRefOid === "string" &&
          result.headRefOid.toLowerCase() !== input.expectedHeadRefOid
        ) {
          throw new ActionError(
            409,
            "head_changed",
            "The pull request head changed. Refresh before merging.",
          );
        }

        const expectedUrl = canonicalUrl(input.repository, input.number);
        const identityMatches =
          pull.repository === input.repository &&
          pull.number === input.number &&
          pull.url === expectedUrl &&
          openState(pull) &&
          pull.authored === true;
        if (!identityMatches) {
          throw new ActionError(
            409,
            "pull_changed",
            "The pull request identity or state changed. Refresh before merging.",
          );
        }
        if (
          typeof pull.headRefOid !== "string" ||
          pull.headRefOid.toLowerCase() !== input.expectedHeadRefOid
        ) {
          throw new ActionError(
            409,
            "head_changed",
            "The pull request head changed. Refresh before merging.",
          );
        }
        if (!readinessComplete(pull)) {
          throw new ActionError(
            409,
            "pull_not_ready",
            "The pull request no longer meets every readiness criterion.",
          );
        }

        try {
          await executor.action([
            "pr",
            "merge",
            expectedUrl,
            "--admin",
            "--merge",
            "--match-head-commit",
            input.expectedHeadRefOid,
          ]);
        } catch (error) {
          if (
            repairManager &&
            typeof repairManager.enqueue === "function" &&
            typeof executor.json === "function"
          ) {
            try {
              const conflict = confirmedConflict(
                await executor.json(
                  mergeFailureArguments(input.repository, input.number),
                ),
                input,
              );
              if (conflict) {
                const repair = repairManager.enqueue(conflict);
                if (
                  repair?.accepted === true &&
                  typeof repair.id === "string" &&
                  repair.id !== "" &&
                  typeof repair.token === "string" &&
                  /^[A-Za-z0-9_-]{43}$/.test(repair.token) &&
                  (repair.state === "repair_queued" ||
                    repair.state === "repair_running")
                ) {
                  return {
                    action: {
                      deduplicated: repair.deduplicated === true,
                      id: repair.id,
                      state: repair.state,
                      token: repair.token,
                      type: "repair_queued",
                    },
                    headRefOid: input.expectedHeadRefOid,
                    merged: false,
                    number: input.number,
                    repository: input.repository,
                    url: expectedUrl,
                  };
                }
              }
            } catch {
              // Only a fully accepted, exact-identity repair is safe to expose.
            }
          }
          throw serviceError(
            error,
            "merge_failed",
            "GitHub could not merge the pull request.",
          );
        }

        try {
          settle(
            invalidate({ repository: input.repository, number: input.number }),
          );
        } catch {
          // A completed GitHub merge must not be reported as failed locally.
        }
        void Promise.resolve()
          .then(() =>
            refetch({ repository: input.repository, number: input.number }),
          )
          .catch(() => undefined);

        return {
          mergeCommitOid: null,
          merged: true,
          number: input.number,
          repository: input.repository,
          url: expectedUrl,
        };
      } finally {
        active.delete(key);
      }
    },
    activeCount: () => active.size,
  });
}
