import { validateAgent } from "./agent.mjs";
import { validateGitBranch } from "./workspace.mjs";

const PERMISSIONS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const SIDES = new Set(["LEFT", "RIGHT"]);

export class ReviewTaskError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ReviewTaskError";
    this.status = status;
    this.code = code;
  }
}

function invalid(code, message, status = 400) {
  return new ReviewTaskError(status, code, message);
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

function validRepository(value) {
  return (
    typeof value === "string" &&
    REPOSITORY.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function validateReviewFeedback(value, bodyLimit) {
  const single = ["body", "line", "path", "side"];
  const range = [...single, "startLine", "startSide"];
  if (!exactKeys(value, single) && !exactKeys(value, range)) {
    throw invalid("invalid_review_feedback", "The review feedback is invalid.");
  }
  if (
    typeof value.body !== "string" ||
    value.body.trim() === "" ||
    value.body.includes("\0")
  ) {
    throw invalid(
      "invalid_review_feedback",
      "The review feedback body is invalid.",
    );
  }
  if (
    Number.isSafeInteger(bodyLimit) &&
    bodyLimit > 0 &&
    byteLength(value.body) > bodyLimit
  ) {
    throw invalid(
      "review_feedback_too_large",
      "The review feedback exceeds the 32 KiB limit.",
      413,
    );
  }
  if (
    typeof value.path !== "string" ||
    value.path === "" ||
    value.path.includes("\0")
  ) {
    throw invalid(
      "invalid_review_feedback",
      "The review feedback path is invalid.",
    );
  }
  if (!SIDES.has(value.side)) {
    throw invalid(
      "invalid_review_feedback",
      "The review feedback side is invalid.",
    );
  }
  if (!Number.isSafeInteger(value.line) || value.line < 1) {
    throw invalid(
      "invalid_review_feedback",
      "The review feedback line is invalid.",
    );
  }

  const ranged = Object.prototype.hasOwnProperty.call(value, "startLine");
  if (
    ranged &&
    (!Number.isSafeInteger(value.startLine) ||
      value.startLine < 1 ||
      value.startLine > value.line ||
      value.startSide !== value.side)
  ) {
    throw invalid(
      "invalid_review_feedback",
      "The review feedback range is invalid.",
    );
  }

  return Object.freeze({
    body: value.body.trim(),
    line: value.line,
    path: value.path,
    side: value.side,
    ...(ranged
      ? { startLine: value.startLine, startSide: value.startSide }
      : {}),
  });
}

export function validateReviewRunInput(value, messageLimit) {
  const keys = [
    "agent",
    "expectedBaseRefOid",
    "expectedHeadRefOid",
    "feedback",
    "message",
    "number",
    "repository",
    "source",
  ];
  if (!exactKeys(value, keys) || value.source !== "review") {
    throw invalid("invalid_request", "The review run request is invalid.");
  }
  if (!validRepository(value.repository)) {
    throw invalid("invalid_repository", "The repository is invalid.");
  }
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw invalid("invalid_number", "The pull request number is invalid.");
  }
  if (!SHA.test(value.expectedBaseRefOid ?? "")) {
    throw invalid("invalid_base", "The expected pull request base is invalid.");
  }
  if (!SHA.test(value.expectedHeadRefOid ?? "")) {
    throw invalid("invalid_head", "The expected pull request head is invalid.");
  }
  if (typeof value.message !== "string" || value.message.includes("\0")) {
    throw invalid(
      "invalid_message",
      "The agent instructions must be a string.",
    );
  }
  if (byteLength(value.message) > messageLimit) {
    throw invalid(
      "message_too_large",
      "The message exceeds the 32 KiB limit.",
      413,
    );
  }

  return Object.freeze({
    agent: validateAgent(value.agent),
    expectedBaseRefOid: value.expectedBaseRefOid.toLowerCase(),
    expectedHeadRefOid: value.expectedHeadRefOid.toLowerCase(),
    feedback: validateReviewFeedback(value.feedback, messageLimit),
    message: value.message.trim(),
    number: value.number,
    repository: value.repository,
    source: "review",
  });
}

function coordinate(line, side) {
  if (!isRecord(line)) return null;
  if (
    side === "RIGHT" &&
    (line.kind === "addition" || line.kind === "context")
  ) {
    return Number.isSafeInteger(line.newLine) && line.newLine > 0
      ? line.newLine
      : null;
  }
  if (side === "LEFT" && line.kind === "deletion") {
    return Number.isSafeInteger(line.oldLine) && line.oldLine > 0
      ? line.oldLine
      : null;
  }
  return null;
}

function hunkContainsRange(hunk, side, startLine, endLine) {
  if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return false;
  const coordinates = hunk.lines.flatMap((line) => {
    const value = coordinate(line, side);
    return value === null ? [] : [value];
  });

  for (let start = 0; start < coordinates.length; start += 1) {
    if (coordinates[start] !== startLine) continue;
    if (startLine === endLine) return true;
    let previous = startLine;
    for (let index = start + 1; index < coordinates.length; index += 1) {
      const current = coordinates[index];
      if (current !== previous + 1) break;
      if (current === endLine) return true;
      if (current > endLine) break;
      previous = current;
    }
  }
  return false;
}

export function validateReviewCommentAnchor(diff, feedback) {
  const selection = validateReviewFeedback(feedback);
  if (!isRecord(diff) || !Array.isArray(diff.files)) {
    throw invalid(
      "review_anchor_unavailable",
      "The displayed diff can no longer prove this review location.",
      409,
    );
  }

  const files = diff.files.filter(
    (file) => isRecord(file) && file.path === selection.path,
  );
  if (
    files.length !== 1 ||
    files[0].truncated !== false ||
    !Array.isArray(files[0].hunks)
  ) {
    throw invalid(
      "review_anchor_unavailable",
      "The displayed diff can no longer prove this review location.",
      409,
    );
  }

  const startLine = selection.startLine ?? selection.line;
  const matches = files[0].hunks.filter((hunk) =>
    hunkContainsRange(hunk, selection.side, startLine, selection.line),
  );
  if (matches.length !== 1) {
    throw invalid(
      "invalid_review_anchor",
      "Choose one or more contiguous lines from the same displayed diff hunk.",
    );
  }
  return selection;
}

function pullUrl(value, repository, number) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.toLowerCase() ===
        `/${repository}/pull/${number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function stringIdentity(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function validateReviewAuthorization(proof, input, expectedHead) {
  if (!isRecord(proof) || proof.complete !== true) {
    throw invalid(
      "review_proof_incomplete",
      "GitHub could not completely authorize this review task.",
      503,
    );
  }
  if (
    proof.available !== true ||
    proof.authored !== true ||
    proof.open !== true ||
    proof.state !== "OPEN"
  ) {
    throw invalid(
      "review_pull_unavailable",
      "The pull request is no longer an authored open pull request.",
      404,
    );
  }
  if (
    !stringIdentity(proof.authorLogin) ||
    !stringIdentity(proof.viewerLogin) ||
    !validRepository(proof.repository) ||
    proof.repository.toLowerCase() !== input.repository.toLowerCase() ||
    proof.number !== input.number ||
    !pullUrl(proof.url, input.repository, input.number) ||
    !SHA.test(proof.baseRefOid ?? "") ||
    !SHA.test(proof.headRefOid ?? "") ||
    !validateGitBranch(proof.headRefName) ||
    !validRepository(proof.headRepository) ||
    typeof proof.isCrossRepository !== "boolean" ||
    typeof proof.viewerPermission !== "string"
  ) {
    throw invalid(
      "review_proof_incomplete",
      "GitHub returned incomplete review task authorization.",
      503,
    );
  }
  if (
    proof.isCrossRepository ||
    proof.headRepository.toLowerCase() !== proof.repository.toLowerCase()
  ) {
    throw invalid(
      "review_fork_unsupported",
      "Review tasks cannot push to pull requests from forks.",
      409,
    );
  }
  if (!PERMISSIONS.has(proof.viewerPermission)) {
    throw invalid(
      "review_permission_denied",
      "The current GitHub user cannot push to this repository.",
      403,
    );
  }
  if (
    proof.headRefOid.toLowerCase() !== expectedHead.toLowerCase() ||
    (input.expectedBaseRefOid !== undefined &&
      proof.baseRefOid.toLowerCase() !== input.expectedBaseRefOid)
  ) {
    throw invalid(
      "review_identity_changed",
      "The pull request changed. Refresh its diff before running the agent.",
      409,
    );
  }

  return Object.freeze({
    authorLogin: proof.authorLogin.trim(),
    baseRefOid: proof.baseRefOid.toLowerCase(),
    headRefName: proof.headRefName,
    headRefOid: proof.headRefOid.toLowerCase(),
    headRepository: proof.headRepository,
    isCrossRepository: false,
    number: proof.number,
    repository: proof.repository,
    state: "OPEN",
    url: proof.url,
    viewerLogin: proof.viewerLogin.trim(),
    viewerPermission: proof.viewerPermission,
  });
}

export function validateReviewCompletion(initial, proof, headRefOid) {
  const current = validateReviewAuthorization(
    proof,
    {
      number: initial.number,
      repository: initial.repository,
    },
    headRefOid,
  );
  if (
    current.authorLogin.toLowerCase() !== initial.authorLogin.toLowerCase() ||
    current.viewerLogin.toLowerCase() !== initial.viewerLogin.toLowerCase() ||
    current.repository.toLowerCase() !== initial.repository.toLowerCase() ||
    current.headRepository.toLowerCase() !==
      initial.headRepository.toLowerCase() ||
    current.headRefName !== initial.headRefName ||
    current.viewerPermission !== initial.viewerPermission
  ) {
    throw invalid(
      "review_identity_changed",
      "The pull request authorization changed before the push was verified.",
      409,
    );
  }
  return current;
}

export function validateReviewReauthorization(initial, proof, input) {
  const current = validateReviewAuthorization(
    proof,
    input,
    input.expectedHeadRefOid,
  );
  if (
    current.authorLogin.toLowerCase() !== initial.authorLogin.toLowerCase() ||
    current.viewerLogin.toLowerCase() !== initial.viewerLogin.toLowerCase() ||
    current.repository.toLowerCase() !== initial.repository.toLowerCase() ||
    current.headRepository.toLowerCase() !==
      initial.headRepository.toLowerCase() ||
    current.headRefName !== initial.headRefName ||
    current.viewerPermission !== initial.viewerPermission ||
    current.baseRefOid !== initial.baseRefOid ||
    current.headRefOid !== initial.headRefOid
  ) {
    throw invalid(
      "review_identity_changed",
      "The pull request authorization changed during review preflight.",
      409,
    );
  }
  return current;
}

export function validateReviewDiffProof(authorization, loaded, input) {
  if (
    !isRecord(loaded) ||
    !isRecord(loaded.authorization) ||
    !isRecord(loaded.diff) ||
    loaded.authorization.repository?.toLowerCase() !==
      authorization.repository.toLowerCase() ||
    loaded.authorization.number !== authorization.number ||
    loaded.authorization.url?.toLowerCase() !==
      authorization.url.toLowerCase() ||
    loaded.authorization.authorLogin?.toLowerCase() !==
      authorization.authorLogin.toLowerCase() ||
    loaded.authorization.viewerLogin?.toLowerCase() !==
      authorization.viewerLogin.toLowerCase() ||
    loaded.authorization.baseRefOid?.toLowerCase() !==
      input.expectedBaseRefOid ||
    loaded.authorization.headRefOid?.toLowerCase() !==
      input.expectedHeadRefOid ||
    loaded.diff.repository?.toLowerCase() !==
      authorization.repository.toLowerCase() ||
    loaded.diff.number !== authorization.number ||
    loaded.diff.baseRefOid?.toLowerCase() !== input.expectedBaseRefOid ||
    loaded.diff.headRefOid?.toLowerCase() !== input.expectedHeadRefOid
  ) {
    throw invalid(
      "review_identity_changed",
      "The pull request changed. Refresh its diff before running the agent.",
      409,
    );
  }
  return validateReviewCommentAnchor(loaded.diff, input.feedback);
}
