// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();

  return {
    ...original,
    getCheckLog: vi.fn(),
  };
});

import { getCheckLog } from "../api";
import { createPullsResponse } from "../test/fixtures";
import type { CheckLog, PullReadiness } from "../types";
import BlockerDetailsComponent, {
  CHECK_LOG_BODY_BUDGET_BYTES,
  cleanCommentText,
  formatCheckLog,
  materializeCheckLog,
} from "./BlockerDetails";

const BlockerDetails = ({ pull }: { pull: PullReadiness }) => (
  <BlockerDetailsComponent pull={pull} viewerLogin="jake" />
);

const JOB_URL =
  "https://github.com/appwrite/cloud/actions/runs/123456789/job/987654321";

const withSupportedCheck = (): PullReadiness => {
  const pull = createPullsResponse().notReady[0]!;
  pull.ci.checks![1]!.detailsUrl = JOB_URL;
  return pull;
};

const checkLog = (
  pull: Pick<PullReadiness, "headRefOid" | "number" | "repository">,
  log = "Run pnpm test\nTests failed",
): CheckLog => ({
  cached: false,
  fetchedAt: "2026-07-21T08:04:00.000Z",
  headRefOid: pull.headRefOid,
  jobId: "987654321",
  log,
  number: pull.number,
  repository: pull.repository,
  runId: "123456789",
});

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

afterEach(() => {
  cleanup();
  vi.mocked(getCheckLog).mockReset();
});

describe("BlockerDetails", () => {
  it("preserves meaningful text and layout while removing GitHub decoration", () => {
    expect(
      cleanCommentText(
        '<h3>Retry <code>deploy()</code></h3><p>Read the <a href="https://example.com">retry guide</a><br>before merging &amp; releasing.</p><a href="https://example.com/badge"><img alt="status badge" src="badge.svg"></a>',
      ),
    ).toBe("Retry deploy()\nRead the retry guide\nbefore merging & releasing.");
  });

  it.each([
    {
      expected: "2026-07-21T05:51:02Z Tests failed",
      label: "an unknown step",
      value:
        "Integration tests\tUNKNOWN STEP\t2026-07-21T05:51:02Z Tests failed",
    },
    {
      expected: "Run tests\t2026-07-21T05:51:02Z Tests failed",
      label: "a named step",
      value: "Integration tests\tRun tests\t2026-07-21T05:51:02Z Tests failed",
    },
    {
      expected: "Another check\tUNKNOWN STEP\tKeep this",
      label: "another check name",
      value: "Another check\tUNKNOWN STEP\tKeep this",
    },
    {
      expected: "A non-tab log line",
      label: "a non-tab line",
      value: "A non-tab log line",
    },
    {
      expected: '<script>alert("safe text")</script>',
      label: "HTML-like content",
      value:
        'Integration tests\tUNKNOWN STEP\t<script>alert("safe text")</script>',
    },
    {
      expected: "First\n\nRun tests\tLast\n",
      label: "blank lines and a final newline",
      value:
        "Integration tests\tUNKNOWN STEP\tFirst\n\nIntegration tests\tRun tests\tLast\n",
    },
    {
      expected: "First\r\n\r\nLast\r\n",
      label: "CRLF line endings",
      value:
        "Integration tests\tUNKNOWN STEP\tFirst\r\n\r\nIntegration tests\tUNKNOWN STEP\tLast\r\n",
    },
  ])("formats GitHub log lines with $label", ({ expected, value }) => {
    expect(formatCheckLog(value, "Integration tests")).toBe(expected);
  });

  it("materializes retained log text through independent UTF-8 byte storage", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const value = "Failure details: café, 漢字, and 🚀";

    try {
      expect(materializeCheckLog(value)).toBe(value);
      expect(encode).toHaveBeenCalledOnce();
      expect(encode).toHaveBeenCalledWith(value);
      const bytes = encode.mock.results[0]!.value;
      expect(Object.prototype.toString.call(bytes)).toBe("[object Uint8Array]");
      expect(decode).toHaveBeenCalledOnce();
      expect(decode.mock.calls[0]![0]).toBe(bytes);
    } finally {
      encode.mockRestore();
      decode.mockRestore();
    }
  });

  it("renders blocker content immediately without an internal disclosure trigger", () => {
    const pull = createPullsResponse().notReady[0]!;
    render(<BlockerDetails pull={pull} />);

    expect(
      screen.queryByRole("button", { name: /blocker details/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Failed checks")).toBeInTheDocument();
    const failedChecks = screen.getByText("Failed checks").closest("section")!;
    const unresolvedComments = screen
      .getByText("Unresolved comments")
      .closest("section")!;
    const greptileReview = screen
      .getByText("Greptile review")
      .closest("section")!;
    const details = failedChecks.parentElement!;

    expect(failedChecks).toHaveClass("min-w-0");
    expect(failedChecks).not.toHaveClass("md:col-span-2");
    expect(details).toHaveClass("grid", "grid-cols-1");
    expect(details).not.toHaveClass("md:grid-cols-2", "xl:grid-cols-3");
    expect(unresolvedComments.parentElement).toBe(details);
    expect(greptileReview.parentElement).toBe(details);
    expect(screen.getByText("Integration tests")).toBeInTheDocument();
    expect(screen.queryByText("Unit tests")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open check" })).toHaveAttribute(
      "href",
      "https://github.com/appwrite/cloud/actions/runs/3",
    );
    expect(screen.getByRole("link", { name: "Open check" })).toHaveAttribute(
      "data-pull-focus-token",
      `blocker:check:${pull.ci.checks!.find(({ state }) => state === "failure")!.id}:open`,
    );
    expect(screen.getByText("Unresolved comments")).toBeInTheDocument();
    expect(screen.getByText("@reviewer-one")).toBeInTheDocument();
    expect(screen.getByText("src/deploy.ts:42")).toBeInTheDocument();
    expect(
      screen.getByText("Please cover the retry path."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Open thread" })[0],
    ).toHaveAttribute(
      "data-pull-focus-token",
      `blocker:thread:${pull.unresolvedThreads![0]!.id}:${pull.unresolvedThreads![0]!.path}:open`,
    );
    expect(screen.getByText("Greptile review")).toBeInTheDocument();
    expect(screen.getByText("4/5 confidence")).toBeInTheDocument();
    expect(screen.getByText(/Current head/)).toHaveTextContent(
      "Current head bbbbbbb reviewed",
    );
    expect(
      screen.getByRole("link", { name: "Open Greptile comment" }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByRole("link", { name: "Open Greptile comment" }),
    ).toHaveAttribute(
      "data-pull-focus-token",
      `blocker:greptile:${pull.greptile.commentId}:open`,
    );
  });

  it("loads a supported failed job automatically when mounted", async () => {
    const pull = withSupportedCheck();
    const pending = deferred<CheckLog>();
    vi.mocked(getCheckLog).mockReturnValue(pending.promise);
    render(<BlockerDetails pull={pull} />);

    expect(
      screen.getByRole("status", { name: "Loading Integration tests logs" }),
    ).toHaveTextContent("Loading logs…");
    expect(getCheckLog).toHaveBeenCalledOnce();
    expect(getCheckLog).toHaveBeenCalledWith(
      { ...pull, viewerLogin: "jake" },
      { jobId: "987654321", runId: "123456789" },
      expect.any(AbortSignal),
    );

    await act(async () => pending.resolve(checkLog(pull)));

    expect(
      screen.getByRole("region", { name: "Integration tests logs" }),
    ).toHaveTextContent("Run pnpm test Tests failed");
    expect(
      screen.getByRole("region", { name: "Integration tests logs" }),
    ).toHaveAttribute(
      "data-pull-focus-token",
      `blocker:check:${pull.ci.checks![1]!.id}:log`,
    );
  });

  it("autoloads every unique failed check and deduplicates canonical jobs", async () => {
    const pull = withSupportedCheck();
    pull.ci.checks = [
      pull.ci.checks![1]!,
      {
        detailsUrl: JOB_URL,
        id: "check-run-duplicate-integration",
        name: "Duplicate integration result",
        state: "failure",
        workflow: "CI duplicate",
      },
      {
        detailsUrl:
          "https://github.com/appwrite/cloud/actions/runs/222222222/job/888888888",
        id: "check-run-lint",
        name: "Lint",
        state: "failure",
        workflow: "Quality",
      },
      {
        detailsUrl: "https://github.com/appwrite/cloud/actions/runs/333333333",
        id: "status-context-external",
        name: "External status",
        state: "failure",
        workflow: null,
      },
    ];
    vi.mocked(getCheckLog).mockImplementation(async (current, job) => ({
      ...checkLog(current, `Log for ${job.jobId}`),
      jobId: job.jobId,
      runId: job.runId,
    }));
    render(<BlockerDetails pull={pull} />);

    await waitFor(() => expect(getCheckLog).toHaveBeenCalledTimes(2));
    const section = screen.getByText("Failed checks").closest("section")!;
    expect(within(section).getByText("3")).toBeInTheDocument();
    expect(within(section).getByText("Integration tests")).toBeInTheDocument();
    expect(within(section).getByText("Lint")).toBeInTheDocument();
    expect(within(section).getByText("External status")).toBeInTheDocument();
    expect(
      within(section).queryByText("Duplicate integration result"),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Integration tests logs" }),
    ).toHaveTextContent("Log for 987654321");
    expect(
      await screen.findByRole("region", { name: "Lint logs" }),
    ).toHaveTextContent("Log for 888888888");
    expect(screen.getByText("Logs unavailable")).toBeInTheDocument();
  });

  it("autoloads and progressively renders every near-limit log within one aggregate budget", async () => {
    const pull = withSupportedCheck();
    const checks = [
      {
        detailsUrl: JOB_URL,
        id: "check-run-integration",
        name: "Integration tests",
        state: "failure" as const,
        workflow: "CI",
      },
      {
        detailsUrl:
          "https://github.com/appwrite/cloud/actions/runs/222222222/job/888888888",
        id: "check-run-lint",
        name: "Lint",
        state: "failure" as const,
        workflow: "Quality",
      },
      {
        detailsUrl:
          "https://github.com/appwrite/cloud/actions/runs/333333333/job/777777777",
        id: "check-run-build",
        name: "Build",
        state: "failure" as const,
        workflow: "Release",
      },
    ];
    pull.ci.checks = checks;
    const line =
      "A detailed GitHub Actions diagnostic line that remains available.\n";
    const finalLine = "FINAL FAILURE: command exited with status 1\n";
    const maximum = 16 * 1024 * 1024;
    const nearLimit = `${line.repeat(
      Math.floor((maximum - finalLine.length) / line.length),
    )}${finalLine}`;
    vi.mocked(getCheckLog).mockImplementation(async (current, job) => ({
      ...checkLog(current, nearLimit),
      jobId: job.jobId,
      runId: job.runId,
    }));
    render(<BlockerDetails pull={pull} />);

    await waitFor(() => expect(getCheckLog).toHaveBeenCalledTimes(3));
    const terminals = await screen.findAllByRole("region", { name: / logs$/ });
    expect(terminals).toHaveLength(3);
    for (const check of checks) {
      expect(screen.getByText(check.name)).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: `${check.name} logs` }),
      ).toHaveTextContent("FINAL FAILURE: command exited with status 1");
    }

    let reveals = screen.queryAllByRole("button", {
      name: /Show \d+ earlier .* log lines/,
    });
    expect(reveals).toHaveLength(3);

    for (
      let iteration = 0;
      iteration < 50 && reveals.length > 0;
      iteration += 1
    ) {
      for (const reveal of reveals) fireEvent.click(reveal);
      reveals = screen.queryAllByRole("button", {
        name: /Show \d+ earlier .* log lines/,
      });
    }

    expect(reveals).toHaveLength(0);
    expect(
      terminals.reduce(
        (bytes, terminal) => bytes + (terminal.textContent?.length ?? 0) * 2,
        0,
      ),
    ).toBeLessThanOrEqual(CHECK_LOG_BODY_BUDGET_BYTES);
    expect(
      screen.getAllByText(
        "Showing a bounded start-and-end preview. Open the check for the complete log.",
      ),
    ).toHaveLength(3);
  });

  it("materializes distinct near-limit giant-line previews before retaining them", async () => {
    const pull = withSupportedCheck();
    const jobs = [
      {
        detailsUrl: JOB_URL,
        ending: "FINAL FAILURE: integration 🚀",
        jobId: "987654321",
        name: "Integration tests",
        runId: "123456789",
        workflow: "CI",
      },
      {
        detailsUrl:
          "https://github.com/appwrite/cloud/actions/runs/222222222/job/888888888",
        ending: "FINAL FAILURE: lint café",
        jobId: "888888888",
        name: "Lint",
        runId: "222222222",
        workflow: "Quality",
      },
      {
        detailsUrl:
          "https://github.com/appwrite/cloud/actions/runs/333333333/job/777777777",
        ending: "FINAL FAILURE: build 漢字",
        jobId: "777777777",
        name: "Build",
        runId: "333333333",
        workflow: "Release",
      },
    ];
    pull.ci.checks = jobs.map((job) => ({
      detailsUrl: job.detailsUrl,
      id: `check-run-${job.jobId}`,
      name: job.name,
      state: "failure",
      workflow: job.workflow,
    }));
    const maximum = 16 * 1024 * 1024;
    const logs = new Map(
      jobs.map((job, index) => [
        job.jobId,
        `${String.fromCharCode(65 + index).repeat(maximum - job.ending.length)}${job.ending}`,
      ]),
    );
    vi.mocked(getCheckLog).mockImplementation(async (current, job) => {
      const log = logs.get(job.jobId);
      if (!log) throw new Error(`Unexpected job ${job.jobId}`);

      return {
        ...checkLog(current, log),
        jobId: job.jobId,
        runId: job.runId,
      };
    });
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    try {
      render(<BlockerDetails pull={pull} />);

      await waitFor(() => expect(getCheckLog).toHaveBeenCalledTimes(3));
      const terminals = await screen.findAllByRole("region", {
        name: / logs$/,
      });
      expect(terminals).toHaveLength(3);
      for (const job of jobs) {
        expect(
          screen.getByRole("region", { name: `${job.name} logs` }),
        ).toHaveTextContent(job.ending);
      }

      const materialized = encode.mock.calls
        .map(([value]) => value)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.includes("log output omitted"),
        );
      expect(materialized).toHaveLength(3);
      expect(new Set(materialized.map((value) => value[0]))).toEqual(
        new Set(["A", "B", "C"]),
      );
      expect(
        materialized.reduce((bytes, value) => bytes + value.length * 2, 0),
      ).toBeLessThanOrEqual(CHECK_LOG_BODY_BUDGET_BYTES);
    } finally {
      encode.mockRestore();
    }
  });

  it.each([
    [
      "a run-only URL",
      "https://github.com/appwrite/cloud/actions/runs/123456789",
    ],
    [
      "a third-party job URL",
      "https://github.com/appwrite/console/actions/runs/123456789/job/987654321",
    ],
  ])("shows Logs unavailable without requesting %s", (_label, detailsUrl) => {
    const pull = createPullsResponse().notReady[0]!;
    pull.ci.checks![1]!.detailsUrl = detailsUrl;
    render(<BlockerDetails pull={pull} />);

    expect(screen.getByText("Logs unavailable")).toBeInTheDocument();
    expect(getCheckLog).not.toHaveBeenCalled();
  });

  it("aborts a pending log request when the details unmount", async () => {
    const pull = withSupportedCheck();
    const pending = deferred<CheckLog>();
    vi.mocked(getCheckLog).mockReturnValue(pending.promise);
    const { unmount } = render(<BlockerDetails pull={pull} />);
    await waitFor(() => expect(getCheckLog).toHaveBeenCalledOnce());
    const signal = vi.mocked(getCheckLog).mock.calls[0]![2]!;

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it("reloads failed-check logs when remounted", async () => {
    const pull = withSupportedCheck();
    const pending = deferred<CheckLog>();
    vi.mocked(getCheckLog)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(checkLog(pull, "Fresh remounted log"));
    const first = render(<BlockerDetails pull={pull} />);
    await waitFor(() => expect(getCheckLog).toHaveBeenCalledOnce());
    const firstSignal = vi.mocked(getCheckLog).mock.calls[0]![2]!;

    first.unmount();
    render(<BlockerDetails pull={pull} />);

    await waitFor(() => expect(getCheckLog).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(
      await screen.findByRole("region", { name: "Integration tests logs" }),
    ).toHaveTextContent("Fresh remounted log");
  });

  it.each(["baseRefOid", "headRefOid"] as const)(
    "aborts the old request and fetches again when %s changes",
    async (field) => {
      const pull = withSupportedCheck();
      const pending = deferred<CheckLog>();
      vi.mocked(getCheckLog)
        .mockReturnValueOnce(pending.promise)
        .mockImplementationOnce(async (nextPull) => checkLog(nextPull));
      const { rerender } = render(<BlockerDetails pull={pull} />);
      await waitFor(() => expect(getCheckLog).toHaveBeenCalledOnce());
      const oldSignal = vi.mocked(getCheckLog).mock.calls[0]![2]!;
      const nextPull = {
        ...pull,
        [field]:
          field === "baseRefOid"
            ? "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            : "cccccccccccccccccccccccccccccccccccccccc",
      };

      rerender(<BlockerDetails pull={nextPull} />);

      await waitFor(() => expect(getCheckLog).toHaveBeenCalledTimes(2));
      expect(oldSignal.aborted).toBe(true);
      expect(vi.mocked(getCheckLog).mock.calls[1]![0][field]).toBe(
        nextPull[field],
      );
      expect(
        await screen.findByRole("region", { name: "Integration tests logs" }),
      ).toHaveTextContent("Tests failed");
    },
  );

  it("shows a safe inline error and retries the same job on demand", async () => {
    const pull = withSupportedCheck();
    vi.mocked(getCheckLog)
      .mockRejectedValueOnce(new Error("GitHub did not return logs yet."))
      .mockResolvedValueOnce(checkLog(pull, "Retry passed"));
    render(<BlockerDetails pull={pull} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Logs unavailable: GitHub did not return logs yet.",
    );
    const retry = screen.getByRole("button", {
      name: "Retry Integration tests logs",
    });
    expect(retry).toHaveAttribute(
      "data-pull-focus-token",
      `blocker:check:${pull.ci.checks![1]!.id}:retry`,
    );
    fireEvent.click(retry);

    expect(
      screen.getByRole("status", { name: "Loading Integration tests logs" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Integration tests logs" }),
    ).toHaveTextContent("Retry passed");
    expect(getCheckLog).toHaveBeenCalledTimes(2);
  });

  it("renders HTML-like log content as text in a bounded accessible terminal", async () => {
    const pull = withSupportedCheck();
    const contents =
      "<script>window.hacked = true</script>\n\tError: expected <main> & received <aside>";
    vi.mocked(getCheckLog).mockResolvedValue(checkLog(pull, contents));
    const { container } = render(<BlockerDetails pull={pull} />);

    const terminal = await screen.findByRole("region", {
      name: "Integration tests logs",
    });
    expect(terminal).toHaveClass("max-h-72", "overflow-auto");
    expect(terminal.textContent).toBe(contents);
    expect(container.querySelector("script, main, aside")).toBeNull();
    expect(window).not.toHaveProperty("hacked");
  });

  it("shows useful failed-check log content without repeated check prefixes", async () => {
    const pull = withSupportedCheck();
    const contents = [
      "Integration tests\tUNKNOWN STEP\t2026-07-21T05:51:02Z Starting tests",
      "Integration tests\tRun tests\t2026-07-21T05:51:03Z Tests failed",
      "Unmatched line",
      "",
    ].join("\n");
    vi.mocked(getCheckLog).mockResolvedValue(checkLog(pull, contents));
    render(<BlockerDetails pull={pull} />);

    const terminal = await screen.findByRole("region", {
      name: "Integration tests logs",
    });
    expect(terminal).toHaveClass("max-h-72", "overflow-auto");
    expect(terminal.textContent).toBe(
      "2026-07-21T05:51:02Z Starting tests\nRun tests\t2026-07-21T05:51:03Z Tests failed\nUnmatched line\n",
    );
  });

  it("shows passing Greptile evidence even when another category is the blocker", () => {
    const pull = createPullsResponse().notReady[0]!;
    pull.unresolved = 0;
    pull.unresolvedThreads = [];
    pull.greptile.confidence = 5;
    pull.greptile.current = true;
    pull.greptile.reviewedSha = pull.headRefOid;
    render(<BlockerDetails pull={pull} />);

    expect(screen.getByText("Failed checks")).toBeInTheDocument();
    expect(screen.queryByText("Unresolved comments")).not.toBeInTheDocument();
    expect(screen.getByText("Greptile review")).toBeInTheDocument();
    expect(screen.getByText("5/5 confidence")).toBeInTheDocument();
    expect(
      screen.getByText("Confidence: 4/5", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Current head/)).toHaveTextContent(
      "Current head bbbbbbb reviewed",
    );
    expect(screen.queryByText("Evidence unavailable")).not.toBeInTheDocument();
  });

  it("explains missing evidence instead of inventing check or comment details", () => {
    const pull = createPullsResponse().notReady[0]!;
    pull.ci = { state: "unknown" };
    pull.unresolved = 0;
    pull.unresolvedThreads = [];
    pull.checks.commentsComplete = false;
    pull.checks.threadsComplete = false;
    pull.greptile.confidence = 5;
    pull.greptile.current = true;
    pull.greptile.reviewedSha = pull.headRefOid;
    render(<BlockerDetails pull={pull} />);

    expect(screen.getByText("Evidence unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Failed checks")).not.toBeInTheDocument();
    expect(screen.queryByText("Unresolved comments")).not.toBeInTheDocument();
    expect(screen.getByText("Greptile review")).toBeInTheDocument();
  });

  it("states exactly which Greptile evidence is unavailable", () => {
    const pull = createPullsResponse().notReady[0]!;
    pull.greptile.body = null;
    pull.greptile.commentUrl = null;
    pull.greptile.confidence = null;
    pull.greptile.current = false;
    pull.greptile.reviewedSha = null;
    render(<BlockerDetails pull={pull} />);

    expect(screen.getByText("Confidence unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Reviewed/)).toHaveTextContent(
      "Reviewed unknown, but current head is bbbbbbb",
    );
    expect(
      screen.getByText("Greptile confidence comment was not available."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Greptile comment link was not available."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open Greptile comment" }),
    ).not.toBeInTheDocument();
  });

  it("renders GitHub comment HTML as readable text and marks stale head context", () => {
    const pull = createPullsResponse().notReady[0]!;
    pull.unresolvedThreads![0]!.body = [
      "<h3>Retry <code>deploy()</code></h3>",
      '<p>Read the <a href="https://example.com/retries">retry guide</a><br>before merging &amp; releasing.</p>',
      '<a href="https://example.com/badge"><img alt="decorative status badge" src="https://example.com/badge.svg"></a>',
    ].join("");
    pull.greptile.current = false;
    pull.greptile.reviewedSha = "cccccccccccccccccccccccccccccccccccccccc";
    const { container } = render(<BlockerDetails pull={pull} />);

    expect(container).toHaveTextContent(
      "Retry deploy() Read the retry guide before merging & releasing.",
    );
    expect(container).not.toHaveTextContent("decorative status badge");
    expect(container).not.toHaveTextContent("<h3>");
    expect(
      screen.queryByRole("link", { name: "retry guide" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Reviewed/)).toHaveTextContent(
      "Reviewed ccccccc, but current head is bbbbbbb",
    );
  });

  it("removes executable and decorative markup from review and Greptile bodies", () => {
    const pull = createPullsResponse().notReady[0]!;
    pull.unresolvedThreads![0]!.body = [
      "<script>window.hacked = true</script>",
      "<style>body { display: none }</style>",
      '<p onclick="window.hacked = true">Keep this &lt;safe&gt; text.</p>',
      '<a href="javascript:window.hacked=true">Meaningful link text</a>',
      '<img src="invalid" onerror="window.hacked=true" alt="unsafe badge">',
    ].join("");
    pull.greptile.body = [
      "<h3>Confidence Score: <code>4&#x2F;5</code></h3>",
      '<a href="https://example.com"><img alt="Greptile badge" src="invalid"></a>',
      "<p>One issue&nbsp;remains.</p>",
      '<iframe srcdoc="&lt;script&gt;window.hacked=true&lt;/script&gt;"></iframe>',
    ].join("");

    const { container } = render(<BlockerDetails pull={pull} />);

    expect(container).toHaveTextContent(
      "Keep this <safe> text. Meaningful link text",
    );
    expect(container).toHaveTextContent(
      "Confidence Score: 4/5 One issue remains.",
    );
    expect(container).not.toHaveTextContent("window.hacked");
    expect(container).not.toHaveTextContent("unsafe badge");
    expect(container).not.toHaveTextContent("Greptile badge");
    expect(container.querySelector("script, style, img, iframe")).toBeNull();
    expect(container.querySelector("[onclick], [onerror]")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Meaningful link text" }),
    ).not.toBeInTheDocument();
  });
});
