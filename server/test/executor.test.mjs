import { describe, expect, it, vi } from "vitest";

import { ExecutorError, createExecutor } from "../executor.mjs";

function processDouble({ error = null, stderr = "", stdout = "" } = {}) {
  return vi.fn((_file, _arguments, _options, callback) => {
    callback(error, stdout, stderr);
  });
}

describe("GitHub executor", () => {
  it("executes gh with strict arguments, explicit limits, and preserved non-interactive environment", async () => {
    const executeFile = processDouble({ stdout: '{"ok":true}' });
    const executor = createExecutor({
      environment: {
        GH_PROMPT_DISABLED: "0",
        GH_TOKEN: "secret-token",
        PATH: "/custom/bin",
      },
      executeFile,
      maxBuffer: 2048,
      timeout: 4321,
    });

    await expect(
      executor.json(["pr", "view", "7", "--json", "number"], {
        validate: (value) => value?.ok === true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(executeFile).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "7", "--json", "number"],
      expect.objectContaining({
        encoding: "utf8",
        env: {
          GH_PROMPT_DISABLED: "1",
          GH_TOKEN: "secret-token",
          PATH: "/custom/bin",
        },
        maxBuffer: 2048,
        timeout: 4321,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  it("discards action output and never invokes a shell", async () => {
    const executeFile = processDouble({
      stdout: "Merged secret-token /Users/person/repo",
    });
    const executor = createExecutor({ executeFile });

    await expect(
      executor.action(["pr", "merge", "https://github.com/o/r/pull/1"]),
    ).resolves.toBeUndefined();
    expect(executeFile.mock.calls[0][2]).not.toHaveProperty("shell");
  });

  it("returns fixed-argument text output without invoking a shell", async () => {
    const executeFile = processDouble({ stdout: "failed step output\n" });
    const executor = createExecutor({ executeFile });

    await expect(
      executor.output([
        "run",
        "view",
        "123",
        "--job",
        "456",
        "--log-failed",
        "-R",
        "owner/repo",
      ]),
    ).resolves.toBe("failed step output\n");
    expect(executeFile).toHaveBeenCalledWith(
      "gh",
      [
        "run",
        "view",
        "123",
        "--job",
        "456",
        "--log-failed",
        "-R",
        "owner/repo",
      ],
      expect.not.objectContaining({ shell: expect.anything() }),
      expect.any(Function),
    );
  });

  it("forwards an AbortSignal to the child process and preserves cancellation", async () => {
    const executeFile = vi.fn((_file, _arguments, options, callback) => {
      options.signal.addEventListener(
        "abort",
        () =>
          callback(
            Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
            "",
          ),
        { once: true },
      );
    });
    const executor = createExecutor({ executeFile });
    const controller = new AbortController();

    const pending = executor.output(["api", "user"], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(executeFile.mock.calls[0][2]).toMatchObject({
      signal: controller.signal,
    });
  });

  it("does not spawn a child for an already-aborted signal", async () => {
    const executeFile = processDouble({ stdout: "{}" });
    const executor = createExecutor({ executeFile });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.rest("user", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("bounds concurrent GitHub subprocesses with one shared admission limit", async () => {
    let active = 0;
    let maximum = 0;
    const callbacks = [];
    const executeFile = vi.fn((_file, _arguments, _options, callback) => {
      active += 1;
      maximum = Math.max(maximum, active);
      callbacks.push((stdout = "output") => {
        active -= 1;
        callback(null, stdout);
      });
    });
    const executor = createExecutor({ concurrency: 2, executeFile });
    const pending = Array.from({ length: 5 }, (_, index) =>
      executor.output(["api", `resource-${index}`]),
    );

    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(2));
    callbacks.shift()();
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(3));
    callbacks.shift()();
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(4));
    callbacks.shift()();
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(5));
    for (const complete of callbacks.splice(0)) complete();

    await expect(Promise.all(pending)).resolves.toEqual(
      Array(5).fill("output"),
    );
    expect(maximum).toBe(2);
  });

  it("removes an aborted queued command before admitting the next caller", async () => {
    const callbacks = [];
    const executeFile = vi.fn((_file, _arguments, _options, callback) => {
      callbacks.push(callback);
    });
    const executor = createExecutor({ concurrency: 1, executeFile });
    const controller = new AbortController();
    const reason = new DOMException("Queued request closed.", "AbortError");

    const first = executor.output(["api", "first"]);
    const abandoned = executor.output(["api", "abandoned"], {
      signal: controller.signal,
    });
    const next = executor.output(["api", "next"]);
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledOnce());

    controller.abort(reason);
    await expect(abandoned).rejects.toBe(reason);
    expect(executeFile).toHaveBeenCalledOnce();

    callbacks.shift()(null, "first");
    await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(2));
    expect(executeFile.mock.calls[1][1]).toEqual(["api", "next"]);
    callbacks.shift()(null, "next");

    await expect(first).resolves.toBe("first");
    await expect(next).resolves.toBe("next");
  });

  it("does not publish output when cancellation wins before the caller resumes", async () => {
    const controller = new AbortController();
    const executeFile = vi.fn((_file, _arguments, _options, callback) => {
      callback(null, "late output");
      controller.abort();
    });
    const executor = createExecutor({ executeFile });

    await expect(
      executor.output(["api", "user"], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("forwards signals through JSON, GraphQL, REST, and action helpers", async () => {
    const executeFile = processDouble({
      stdout: '{"data":{"viewer":{"login":"me"}}}',
    });
    const executor = createExecutor({ executeFile });
    const controller = new AbortController();

    await executor.json(["api", "user"], { signal: controller.signal });
    await executor.graphql(
      "query Viewer { viewer { login } }",
      {},
      { signal: controller.signal },
    );
    await executor.rest("user", { signal: controller.signal });
    await executor.action(["auth", "status"], { signal: controller.signal });

    expect(executeFile).toHaveBeenCalledTimes(4);
    expect(
      executeFile.mock.calls.every(
        ([, , options]) => options.signal === controller.signal,
      ),
    ).toBe(true);
  });

  it("supports a GraphQL-specific response budget without changing later command limits", async () => {
    const executeFile = processDouble({
      stdout: '{"data":{"viewer":{"login":"me"}}}',
    });
    const executor = createExecutor({ executeFile, maxBuffer: 1_024 });

    await executor.graphql(
      "query Viewer { viewer { login } }",
      {},
      { maxBuffer: 2_048 },
    );
    await executor.output(["api", "user"]);

    expect(executeFile.mock.calls[0][2].maxBuffer).toBe(2_048);
    expect(executeFile.mock.calls[1][2].maxBuffer).toBe(1_024);
  });

  it.each([
    [
      "missing",
      { code: "ENOENT", message: "spawn /Users/person/bin/gh secret-token" },
    ],
    ["timeout", { code: "ETIMEDOUT", killed: true, message: "secret-token" }],
    [
      "output_limit",
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        message: "/Users/person/repo",
      },
    ],
    ["failed", { code: 1, message: "stderr secret-token /Users/person/repo" }],
  ])(
    "maps process failures to a sanitized %s error",
    async (code, processError) => {
      const error = Object.assign(
        new Error(processError.message),
        processError,
        {
          stderr: "ghp_really_secret",
          stdout: "/Users/person/private",
        },
      );
      const executor = createExecutor({
        executeFile: processDouble({ error }),
      });

      const thrown = await executor
        .action(["auth", "status"])
        .catch((value) => value);
      expect(thrown).toBeInstanceOf(ExecutorError);
      expect(thrown).toMatchObject({ code });
      expect(`${thrown.message} ${JSON.stringify(thrown)}`).not.toMatch(
        /secret|\/Users\/person|stdout|stderr/i,
      );
      expect(thrown).not.toHaveProperty("cause");
    },
  );

  it("classifies one canonical gh REST rejection without retaining process output", async () => {
    const error = Object.assign(new Error("private process failure"), {
      code: 1,
    });
    const executor = createExecutor({
      executeFile: processDouble({
        error,
        stderr: "gh: Validation Failed (HTTP 422)\n",
        stdout: '{"message":"private response body"}',
      }),
    });

    const thrown = await executor
      .rest("repos/owner/repo/pulls/7/comments", {
        method: "POST",
      })
      .catch((value) => value);

    expect(thrown).toBeInstanceOf(ExecutorError);
    expect(thrown).toMatchObject({
      apiStatus: 422,
      code: "api_rejected",
      message: "GitHub rejected the API request.",
      status: 502,
    });
    expect(`${thrown.message} ${JSON.stringify(thrown)}`).not.toMatch(
      /private|stderr|stdout|arguments|environment/i,
    );
    expect(thrown).not.toHaveProperty("cause");
  });

  it("scopes API rejection parsing to REST stderr", async () => {
    const error = Object.assign(new Error("failed"), { code: 1 });
    const stderr = "gh: Not Found (HTTP 404)\n";
    const generic = createExecutor({
      executeFile: processDouble({ error, stderr }),
    });
    const stdoutOnly = createExecutor({
      executeFile: processDouble({
        error,
        stdout: '{"message":"gh: Not Found (HTTP 404)"}',
      }),
    });

    await expect(generic.json(["api", "user"])).rejects.toMatchObject({
      code: "failed",
    });
    await expect(generic.action(["auth", "status"])).rejects.toMatchObject({
      code: "failed",
    });
    await expect(stdoutOnly.rest("user")).rejects.toMatchObject({
      code: "failed",
    });
  });

  it.each([
    ["incidental marker", "prefix gh: Not Found (HTTP 404)\n"],
    ["noncanonical suffix", "gh: Not Found (HTTP 404) trailing\n"],
    [
      "duplicate markers",
      "gh: Not Found (HTTP 404)\ngh: Not Found (HTTP 404)\n",
    ],
    [
      "conflicting markers",
      "gh: Not Found (HTTP 404)\ngh: Forbidden (HTTP 403)\n",
    ],
    [
      "canonical plus incidental marker",
      "gh: Not Found (HTTP 404)\nprefix (HTTP 403)\n",
    ],
    ["status below API-error range", "gh: Redirected (HTTP 399)\n"],
    ["status above API-error range", "gh: Invalid (HTTP 600)\n"],
    [
      "stderr over the inspection ceiling",
      `${"x".repeat(64 * 1024)}\ngh: Not Found (HTTP 404)\n`,
    ],
  ])("does not classify a %s", async (_label, stderr) => {
    const error = Object.assign(new Error("failed"), { code: 1 });
    const executor = createExecutor({
      executeFile: processDouble({ error, stderr }),
    });

    const thrown = await executor.rest("user").catch((value) => value);
    expect(thrown).toMatchObject({ code: "failed", status: 502 });
    expect(thrown).not.toHaveProperty("apiStatus");
  });

  it.each([
    ["missing", { code: "ENOENT", killed: true }],
    ["timeout", { code: "ETIMEDOUT" }],
    ["timeout", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }],
    ["output_limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
  ])(
    "preserves %s precedence over REST status parsing",
    async (code, details) => {
      const executor = createExecutor({
        executeFile: processDouble({
          error: Object.assign(new Error("failed"), details),
          stderr: "gh: Not Found (HTTP 404)\n",
        }),
      });

      const thrown = await executor.rest("user").catch((value) => value);
      expect(thrown).toMatchObject({ code });
      expect(thrown).not.toHaveProperty("apiStatus");
    },
  );

  it("publishes apiStatus only for a valid API rejection error", () => {
    expect(new ExecutorError("failed", 422)).not.toHaveProperty("apiStatus");
    expect(new ExecutorError("api_rejected", 399)).not.toHaveProperty(
      "apiStatus",
    );
    expect(new ExecutorError("api_rejected", 600)).not.toHaveProperty(
      "apiStatus",
    );
    expect(new ExecutorError("api_rejected", 422)).toMatchObject({
      apiStatus: 422,
    });
  });

  it("rejects unreadable JSON and data that fails the caller shape guard", async () => {
    const malformed = createExecutor({
      executeFile: processDouble({ stdout: "{nope" }),
    });
    await expect(malformed.json(["api", "user"])).rejects.toMatchObject({
      code: "invalid_response",
    });

    const wrongShape = createExecutor({
      executeFile: processDouble({ stdout: "[]" }),
    });
    await expect(wrongShape.json(["api", "user"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("enforces the configured byte ceiling even when a test process ignores maxBuffer", async () => {
    const executor = createExecutor({
      executeFile: processDouble({ stdout: "é".repeat(6) }),
      maxBuffer: 10,
    });

    await expect(executor.json(["api", "user"])).rejects.toMatchObject({
      code: "output_limit",
    });
  });

  it("validates GraphQL envelopes without surfacing GraphQL error details", async () => {
    const executeFile = processDouble({
      stdout: JSON.stringify({
        errors: [{ message: "secret-token /Users/person/repo" }],
      }),
    });
    const executor = createExecutor({ executeFile });
    const thrown = await executor
      .graphql("query Viewer { viewer { login } }")
      .catch((value) => value);

    expect(thrown).toMatchObject({ code: "invalid_response" });
    expect(thrown.message).not.toMatch(/secret|\/Users\/person/i);
  });

  it("builds typed GraphQL variables and REST fields as discrete arguments", async () => {
    const graphqlProcess = processDouble({
      stdout: '{"data":{"viewer":{"login":"me"}}}',
    });
    const graphql = createExecutor({ executeFile: graphqlProcess });
    await graphql.graphql("query Viewer($count: Int!) { viewer { login } }", {
      count: 2,
      cursor: "abc",
      ids: ["first", "second"],
    });
    expect(graphqlProcess.mock.calls[0][1]).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query Viewer($count: Int!) { viewer { login } }",
      "-F",
      "count=2",
      "-f",
      "cursor=abc",
      "-f",
      "ids[]=first",
      "-f",
      "ids[]=second",
    ]);

    const restProcess = processDouble({ stdout: "[]" });
    const rest = createExecutor({ executeFile: restProcess });
    await rest.rest("repos/owner/repo/releases", {
      fields: { generate_release_notes: true },
      method: "POST",
      paginate: true,
      rawFields: { tag_name: "v1.2.3" },
      slurp: true,
      validate: Array.isArray,
    });
    expect(restProcess.mock.calls[0][1]).toEqual([
      "api",
      "repos/owner/repo/releases",
      "--method",
      "POST",
      "--paginate",
      "--slurp",
      "-F",
      "generate_release_notes=true",
      "-f",
      "tag_name=v1.2.3",
    ]);
  });

  it("supports empty GraphQL lists and rejects unsafe or nested list values", async () => {
    const executeFile = processDouble({ stdout: '{"data":{"nodes":[]}}' });
    const executor = createExecutor({ executeFile });

    await executor.graphql(
      "query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id } }",
      { ids: [] },
    );
    expect(executeFile.mock.calls[0][1]).toContain("ids[]");

    for (const ids of [[{ id: "nested" }], [["nested"]], ["bad\0value"]]) {
      await expect(
        executor.graphql(
          "query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id } }",
          { ids },
        ),
      ).rejects.toThrow("scalar values");
    }
    expect(executeFile).toHaveBeenCalledTimes(1);
  });

  it("flattens only the complete annotated-tag tagger object into gh bracket fields", async () => {
    const executeFile = processDouble({ stdout: "{}" });
    const executor = createExecutor({ executeFile });

    await executor.rest("repos/owner/repo/git/tags", {
      fields: {
        message: "release",
        object: "abcdef0123456789abcdef0123456789abcdef01",
        tag: "v1.2.4",
        tagger: {
          name: "Puller",
          email: "puller@users.noreply.github.com",
          date: "2026-07-21T00:00:00.000Z",
        },
        type: "commit",
      },
      method: "POST",
    });

    expect(executeFile.mock.calls[0][1]).toEqual([
      "api",
      "repos/owner/repo/git/tags",
      "--method",
      "POST",
      "-f",
      "message=release",
      "-f",
      "object=abcdef0123456789abcdef0123456789abcdef01",
      "-f",
      "tag=v1.2.4",
      "-f",
      "tagger[name]=Puller",
      "-f",
      "tagger[email]=puller@users.noreply.github.com",
      "-f",
      "tagger[date]=2026-07-21T00:00:00.000Z",
      "-f",
      "type=commit",
    ]);
  });

  it.each([
    { "tagger[name]": "Puller" },
    { owner: { name: "Puller" } },
    {
      tagger: {
        date: "2026-07-21T00:00:00Z",
        email: "a@b.c",
        extra: "no",
        name: "Puller",
      },
    },
    { tagger: { email: "a@b.c", name: "Puller" } },
    { tagger: { date: { nested: true }, email: "a@b.c", name: "Puller" } },
  ])(
    "rejects arbitrary, incomplete, or deeper nested REST fields",
    async (fields) => {
      const executeFile = processDouble({ stdout: "{}" });
      const executor = createExecutor({ executeFile });

      await expect(
        executor.rest("repos/owner/repo/git/tags", {
          fields,
          method: "POST",
        }),
      ).rejects.toThrow("GitHub API");
      expect(executeFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    [[], "arguments"],
    [["api", "\0bad"], "arguments"],
  ])(
    "rejects unsafe process arguments before execution",
    async (argumentsList, message) => {
      const executeFile = processDouble({ stdout: "{}" });
      const executor = createExecutor({ executeFile });
      await expect(executor.json(argumentsList)).rejects.toThrow(message);
      expect(executeFile).not.toHaveBeenCalled();
    },
  );
});
