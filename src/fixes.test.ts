import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelAgentRun,
  cancelClaudeRun,
  ClaudeRunHttpError,
  DEFAULT_FIX_INSTRUCTIONS,
  DEFAULT_FIX_PLACEHOLDER,
  resetActionTokenForTests,
  streamAgentRun,
  streamClaudeRun,
  type AutoTrigger,
  type ClaudeRunRequest,
} from "./fixes";

const encoder = new TextEncoder();

const streamResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    {
      headers: { "Content-Type": "application/x-ndjson" },
      status: 200,
    },
  );

const tokenResponse = (token = "action-token"): Response =>
  new Response(JSON.stringify({ token }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

const request = {
  expectedHeadRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  message: "Resolve the open review feedback.",
  number: 102,
  repository: "appwrite/cloud",
};

afterEach(() => {
  resetActionTokenForTests();
  vi.unstubAllGlobals();
});

describe("default fix instructions", () => {
  it("names the shepherd bar as the blank-run target", () => {
    expect(DEFAULT_FIX_INSTRUCTIONS).toContain(
      "The target is the shepherd bar.",
    );
    expect(DEFAULT_FIX_INSTRUCTIONS).toContain("Do not merge.");
    expect(DEFAULT_FIX_PLACEHOLDER).toBe(
      "Leave blank to drive this pull request to the shepherd bar.",
    );
  });
});

describe("rate-limit events", () => {
  it("accepts a tagged rate-limit error from the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          streamResponse([
            '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
            '{"type":"error","code":"rate_limit","message":"You\'ve hit your weekly limit."}\n',
          ]),
        ),
    );

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      code: "rate_limit",
      message: "You've hit your weekly limit.",
      type: "error",
    });
  });
});

describe("streamClaudeRun", () => {
  it("decodes fragmented, coalesced, and final unterminated NDJSON incrementally", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"sta',
          'rt","runId":"run-1","repository":"appwrite/cloud","number":102}\n' +
            '{"type":"text","text":"first"}\n{"type":"tool","name":"Edit"',
          ',"status":"done"}\n{"type":"complete","exitCode":0}',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        number: 102,
        repository: "appwrite/cloud",
        runId: "run-1",
        type: "start",
      },
      { text: "first", type: "text" },
      { name: "Edit", status: "done", type: "tool" },
      { exitCode: 0, type: "complete" },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/claude/runs",
      expect.objectContaining({
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
          "X-Action-Token": "action-token",
        }),
        method: "POST",
      }),
    );
  });

  it.each([1, 2, 3, 4] as const)(
    "sends automatic trigger identities with parallelism %i",
    async (parallelism) => {
      const triggers: AutoTrigger[] = [
        {
          id: "comment-1",
          kind: "issue_comment",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
        {
          id: "review-1",
          kind: "review_comment",
          threadId: "thread-1",
          updatedAt: "2026-07-22T00:01:00.000Z",
        },
        {
          detailsUrl: "https://github.com/appwrite/cloud/actions/runs/1",
          headRefOid: request.expectedHeadRefOid,
          id: "check-1",
          kind: "failed_check",
        },
        {
          commentId: "greptile-1",
          confidence: 4,
          kind: "greptile",
          reviewedSha: request.expectedHeadRefOid,
          updatedAt: "2026-07-22T00:02:00.000Z",
        },
      ];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          streamResponse([
            '{"type":"start","runId":"auto-1","repository":"appwrite/cloud","number":102}\n',
            '{"type":"complete","exitCode":0}\n',
          ]),
        );
      vi.stubGlobal("fetch", fetchMock);

      for await (const _event of streamClaudeRun({
        ...request,
        parallelism,
        source: "auto",
        triggers,
      })) {
        // Consume the automatic run stream.
      }

      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        ...request,
        parallelism,
        source: "auto",
        triggers,
      });
    },
  );

  it("validates and serializes review feedback as an exact one-shot run payload", async () => {
    const review = {
      ...request,
      expectedBaseRefOid: "B".repeat(40),
      expectedHeadRefOid: "A".repeat(40),
      feedback: {
        body: "Handle this race without weakening the assertion.",
        line: 44,
        path: "src/Worker.php",
        side: "RIGHT",
        startLine: 41,
        startSide: "RIGHT",
      },
      message: "",
      source: "review",
    } satisfies ClaudeRunRequest;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"review-1","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    for await (const _event of streamClaudeRun(review)) {
      // Consume the review run stream.
    }

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedBaseRefOid: "b".repeat(40),
      expectedHeadRefOid: "a".repeat(40),
      feedback: {
        body: "Handle this race without weakening the assertion.",
        line: 44,
        path: "src/Worker.php",
        side: "RIGHT",
        startLine: 41,
        startSide: "RIGHT",
      },
      message: "",
      number: 102,
      repository: "appwrite/cloud",
      source: "review",
    });
  });

  it.each([
    ["an invalid base SHA", { expectedBaseRefOid: "not-a-sha" }],
    ["an invalid head SHA", { expectedHeadRefOid: "not-a-sha" }],
    ["a blank body", { feedback: { body: "   " } }],
    ["a body containing NUL", { feedback: { body: "unsafe\0body" } }],
    ["a blank path", { feedback: { path: "   " } }],
    ["a path containing NUL", { feedback: { path: "src\0/file.ts" } }],
    ["an unknown side", { feedback: { side: "BOTH" } }],
    ["a non-positive line", { feedback: { line: 0 } }],
    ["a fractional line", { feedback: { line: 4.5 } }],
    ["an unpaired start line", { feedback: { startLine: 3 } }],
    ["an unpaired start side", { feedback: { startSide: "RIGHT" } }],
    [
      "a reversed range",
      { feedback: { line: 4, startLine: 5, startSide: "RIGHT" } },
    ],
    [
      "a range crossing diff sides",
      { feedback: { startLine: 3, startSide: "LEFT" } },
    ],
    ["an unknown feedback field", { feedback: { context: "extra" } }],
    ["an unknown request field", { parallelism: 2 }],
  ])(
    "rejects review feedback with %s before authorization",
    async (_label, change) => {
      const feedback = {
        body: "Address this feedback.",
        line: 4,
        path: "src/Worker.php",
        side: "RIGHT",
        ...("feedback" in change ? change.feedback : {}),
      };
      const invalid = {
        ...request,
        expectedBaseRefOid: "b".repeat(40),
        feedback,
        message: "",
        source: "review",
        ...change,
        ...("feedback" in change ? { feedback } : {}),
      } as unknown as ClaudeRunRequest;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const consume = async () => {
        for await (const _event of streamClaudeRun(invalid)) {
          // Validation rejects before the action token is requested.
        }
      };

      await expect(consume()).rejects.toThrow(
        "The review fix request is invalid.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("preserves the HTTP status and service error code before streaming starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              code: "auto_trigger_stale",
              error: "The automatic evidence is stale.",
            }),
            { status: 409 },
          ),
        ),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // The response is rejected before the first stream event.
      }
    };

    await expect(consume()).rejects.toEqual(
      expect.objectContaining<Partial<ClaudeRunHttpError>>({
        code: "auto_trigger_stale",
        message: "The automatic evidence is stale.",
        name: "ClaudeRunHttpError",
        status: 409,
      }),
    );
  });

  it("accepts the server-shaped cancellation event as a successful terminal event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
          '{"type":"cancelled","message":"Run cancelled."}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      message: "Run cancelled.",
      type: "cancelled",
    });
  });

  it.each([
    ["a numeric cancellation message", '{"type":"cancelled","message":42}\n'],
    ["a null cancellation message", '{"type":"cancelled","message":null}\n'],
    ["an empty cancellation message", '{"type":"cancelled","message":""}\n'],
    [
      "an unknown terminal event",
      '{"type":"canceled","message":"Run cancelled."}\n',
    ],
  ])("rejects %s", async (_label, terminal) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          streamResponse([
            '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
            terminal,
          ]),
        ),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // Consume until validation fails.
      }
    };

    await expect(consume()).rejects.toThrow(
      "Claude returned an invalid stream event.",
    );
  });

  it("caches the token across runs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"one","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"two","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    for await (const _event of streamClaudeRun(request)) {
      // Consume the first stream.
    }
    for await (const _event of streamClaudeRun(request)) {
      // Consume the second stream.
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/actions/token"),
    ).toHaveLength(1);
  });

  it("refreshes an expired token once before a stream has started", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("old-token"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(tokenResponse("new-token"))
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"run-2","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ exitCode: 0, type: "complete" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Action-Token": "new-token" }),
      }),
    );
  });

  it.each([
    ["a non-start first event", '{"type":"text","text":"wrong"}\n'],
    [
      "an event with extra properties",
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102,"extra":true}\n',
    ],
    [
      "a start event for another pull request",
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":999}\n',
    ],
    [
      "malformed JSON",
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\nnot-json',
    ],
  ])("rejects %s", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(streamResponse([body])),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // Consume until validation fails.
      }
    };

    await expect(consume()).rejects.toThrow(
      /different|invalid|malformed|without a start/,
    );
  });

  it.each([
    [
      "a stream without a terminal event",
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
      /before reporting completion/,
    ],
    [
      "data after a terminal event",
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n' +
        '{"type":"complete","exitCode":0}\n' +
        '{"type":"text","text":"late"}\n',
      /after a terminal event/,
    ],
  ])("rejects %s", async (_label, body, error) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(streamResponse([body])),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // Consume until validation fails.
      }
    };

    await expect(consume()).rejects.toThrow(error);
  });

  it("accepts a legacy bare cancellation and forwards AbortSignal to both requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
          '{"type":"cancelled"}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request, controller.signal)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "cancelled" });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("streamAgentRun", () => {
  it("sends the selected agent to the provider-neutral endpoint and validates the echo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        streamResponse([
          '{"agent":"codex","type":"start","runId":"run-codex","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = [];
    for await (const event of streamAgentRun({
      ...request,
      agent: "codex",
      source: "manual",
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      agent: "codex",
      runId: "run-codex",
      type: "start",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agents/runs",
      expect.objectContaining({
        body: JSON.stringify({
          agent: "codex",
          ...request,
          source: "manual",
        }),
        method: "POST",
      }),
    );
  });

  it("rejects a start event from a different agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          streamResponse([
            '{"agent":"claude","type":"start","runId":"wrong-agent","repository":"appwrite/cloud","number":102}\n',
          ]),
        ),
    );

    await expect(
      (async () => {
        for await (const _event of streamAgentRun({
          ...request,
          agent: "codex",
          source: "manual",
        })) {
          // Consume the validated stream.
        }
      })(),
    ).rejects.toThrow("different agent or pull request");
  });

  it("attributes malformed neutral stream events to the selected agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          streamResponse([
            '{"agent":"codex","type":"start","runId":"run-codex","repository":"appwrite/cloud","number":102}\n',
            '{"type":"complete","exitCode":"zero"}\n',
          ]),
        ),
    );

    await expect(
      (async () => {
        for await (const _event of streamAgentRun({
          ...request,
          agent: "codex",
          source: "manual",
        })) {
          // Consume the validated stream.
        }
      })(),
    ).rejects.toThrow("Codex returned an invalid stream event.");
  });
});

describe("cancelClaudeRun", () => {
  it("uses the cached action token and URL-encodes the run id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelClaudeRun("run/with spaces");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/claude/runs/run%2Fwith%20spaces",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Action-Token": "action-token" }),
        method: "DELETE",
      }),
    );
  });
});

describe("cancelAgentRun", () => {
  it("cancels through the provider-neutral endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelAgentRun("run/codex");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/agents/runs/run%2Fcodex",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
