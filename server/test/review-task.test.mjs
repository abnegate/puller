import { describe, expect, it } from "vitest";

import {
  validateReviewAuthorization,
  validateReviewCommentAnchor,
  validateReviewCompletion,
  validateReviewDiffProof,
  validateReviewRunInput,
} from "../review-task.mjs";

const BASE = "1234567890abcdef1234567890abcdef12345678";
const HEAD = "abcdef0123456789abcdef0123456789abcdef01";
const NEXT = "fedcba9876543210fedcba9876543210fedcba98";

function line(kind, oldLine, newLine) {
  return { content: kind, kind, newLine, oldLine };
}

function diff(overrides = {}) {
  return {
    baseRefOid: BASE,
    complete: true,
    files: [
      {
        hunks: [
          {
            lines: [
              line("context", 1, 1),
              line("deletion", 2, null),
              line("addition", null, 2),
              line("addition", null, 3),
              line("context", 3, 4),
            ],
          },
        ],
        path: "src/example.js",
        truncated: false,
      },
    ],
    headRefOid: HEAD,
    number: 7,
    repository: "owner/repo",
    ...overrides,
  };
}

function feedback(overrides = {}) {
  return {
    body: "Handle this edge case.",
    line: 2,
    path: "src/example.js",
    side: "RIGHT",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    expectedBaseRefOid: BASE,
    expectedHeadRefOid: HEAD,
    feedback: feedback(),
    message: "Handle this edge case.",
    number: 7,
    repository: "owner/repo",
    source: "review",
    ...overrides,
  };
}

function proof(overrides = {}) {
  return {
    authored: true,
    authorLogin: "viewer",
    available: true,
    baseRefOid: BASE,
    complete: true,
    headRefName: "fix/review",
    headRefOid: HEAD,
    headRepository: "owner/repo",
    isCrossRepository: false,
    number: 7,
    open: true,
    repository: "owner/repo",
    state: "OPEN",
    url: "https://github.com/owner/repo/pull/7",
    viewerLogin: "viewer",
    viewerPermission: "WRITE",
    ...overrides,
  };
}

describe("review task input", () => {
  it("accepts exact single-line and range feedback contracts", () => {
    expect(validateReviewRunInput(input(), 32 * 1024)).toMatchObject(input());
    expect(
      validateReviewRunInput(
        input({
          feedback: feedback({
            line: 4,
            startLine: 2,
            startSide: "RIGHT",
          }),
        }),
        32 * 1024,
      ).feedback,
    ).toMatchObject({ line: 4, startLine: 2, startSide: "RIGHT" });
  });

  it.each([
    ["extra root field", { extra: true }],
    ["malformed base", { expectedBaseRefOid: "main" }],
    ["malformed head", { expectedHeadRefOid: "head" }],
    ["missing feedback", { feedback: undefined }],
  ])("rejects %s", (_name, change) => {
    expect(() => validateReviewRunInput(input(change), 32 * 1024)).toThrow();
  });

  it("rejects NUL bytes in review instructions", () => {
    expect(() =>
      validateReviewRunInput(
        input({ message: "Handle this\0ignore" }),
        32 * 1024,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_message" }));
  });

  it("rejects malformed and mixed-side ranges", () => {
    expect(() =>
      validateReviewRunInput(
        input({
          feedback: feedback({
            line: 2,
            startLine: 3,
            startSide: "RIGHT",
          }),
        }),
        32 * 1024,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_review_feedback" }),
    );
    expect(() =>
      validateReviewRunInput(
        input({
          feedback: feedback({
            startLine: 1,
            startSide: "LEFT",
          }),
        }),
        32 * 1024,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_review_feedback" }),
    );
  });
});

describe("review diff anchors", () => {
  it("accepts exact single-line and contiguous range anchors", () => {
    expect(validateReviewCommentAnchor(diff(), feedback())).toEqual(feedback());
    expect(
      validateReviewCommentAnchor(
        diff(),
        feedback({ line: 4, startLine: 2, startSide: "RIGHT" }),
      ),
    ).toMatchObject({ line: 4, startLine: 2 });
  });

  it.each([
    ["missing", []],
    ["truncated", [{ ...diff().files[0], truncated: true }]],
    ["duplicate", [diff().files[0], diff().files[0]]],
  ])("rejects a %s file proof", (_name, files) => {
    expect(() =>
      validateReviewCommentAnchor(diff({ files }), feedback()),
    ).toThrowError(
      expect.objectContaining({
        code: "review_anchor_unavailable",
        status: 409,
      }),
    );
  });

  it("rejects a stale or absent displayed line", () => {
    expect(() =>
      validateReviewCommentAnchor(diff(), feedback({ line: 99 })),
    ).toThrowError(expect.objectContaining({ code: "invalid_review_anchor" }));
  });

  it("binds the anchor proof to the same fresh author, viewer, base, and head", () => {
    const authorization = validateReviewAuthorization(proof(), input(), HEAD);
    const loaded = {
      authorization: {
        authorLogin: "viewer",
        baseRefOid: BASE,
        headRefOid: HEAD,
        number: 7,
        repository: "owner/repo",
        url: "https://github.com/owner/repo/pull/7",
        viewerLogin: "viewer",
      },
      diff: diff(),
    };
    expect(validateReviewDiffProof(authorization, loaded, input())).toEqual(
      feedback(),
    );
    expect(() =>
      validateReviewDiffProof(
        authorization,
        {
          ...loaded,
          authorization: { ...loaded.authorization, viewerLogin: "other" },
        },
        input(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "review_identity_changed" }),
    );
  });
});

describe("review authorization", () => {
  it("accepts a ready authored same-repository pull with write access", () => {
    expect(validateReviewAuthorization(proof(), input(), HEAD)).toMatchObject({
      headRefName: "fix/review",
      headRefOid: HEAD,
      viewerPermission: "WRITE",
    });
  });

  it.each(["WRITE", "MAINTAIN", "ADMIN"])(
    "accepts %s permission",
    (viewerPermission) => {
      expect(() =>
        validateReviewAuthorization(proof({ viewerPermission }), input(), HEAD),
      ).not.toThrow();
    },
  );

  it("rejects forks and insufficient permission", () => {
    expect(() =>
      validateReviewAuthorization(
        proof({
          headRepository: "contributor/repo",
          isCrossRepository: true,
        }),
        input(),
        HEAD,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "review_fork_unsupported" }),
    );
    expect(() =>
      validateReviewAuthorization(
        proof({ viewerPermission: "READ" }),
        input(),
        HEAD,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "review_permission_denied" }),
    );
  });

  it("requires a fresh exact base and head", () => {
    expect(() =>
      validateReviewAuthorization(proof({ headRefOid: NEXT }), input(), HEAD),
    ).toThrowError(
      expect.objectContaining({ code: "review_identity_changed" }),
    );
    expect(() =>
      validateReviewAuthorization(proof({ baseRefOid: NEXT }), input(), HEAD),
    ).toThrowError(
      expect.objectContaining({ code: "review_identity_changed" }),
    );
  });

  it("post-verifies exact pushed head and unchanged branch authority", () => {
    const initial = validateReviewAuthorization(proof(), input(), HEAD);
    expect(
      validateReviewCompletion(initial, proof({ headRefOid: NEXT }), NEXT),
    ).toMatchObject({ headRefOid: NEXT });
    expect(() =>
      validateReviewCompletion(
        initial,
        proof({ headRefName: "different", headRefOid: NEXT }),
        NEXT,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "review_identity_changed" }),
    );
  });
});
