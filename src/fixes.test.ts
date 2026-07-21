import { afterEach, describe, expect, it, vi } from 'vitest';

import { cancelClaudeRun, resetActionTokenForTests, streamClaudeRun } from './fixes';

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
      headers: { 'Content-Type': 'application/x-ndjson' },
      status: 200,
    },
  );

const tokenResponse = (token = 'action-token'): Response =>
  new Response(JSON.stringify({ token }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });

const request = {
  expectedHeadRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  message: 'Resolve the open review feedback.',
  number: 102,
  repository: 'appwrite/cloud',
};

afterEach(() => {
  resetActionTokenForTests();
  vi.unstubAllGlobals();
});

describe('streamClaudeRun', () => {
  it('decodes fragmented, coalesced, and final unterminated NDJSON incrementally', async () => {
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
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events).toEqual([
      { number: 102, repository: 'appwrite/cloud', runId: 'run-1', type: 'start' },
      { text: 'first', type: 'text' },
      { name: 'Edit', status: 'done', type: 'tool' },
      { exitCode: 0, type: 'complete' },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/claude/runs',
      expect.objectContaining({
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Accept: 'application/x-ndjson',
          'Content-Type': 'application/json',
          'X-Action-Token': 'action-token',
        }),
        method: 'POST',
      }),
    );
  });

  it('caches the token across runs', async () => {
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
    vi.stubGlobal('fetch', fetchMock);

    for await (const _event of streamClaudeRun(request)) {
      // Consume the first stream.
    }
    for await (const _event of streamClaudeRun(request)) {
      // Consume the second stream.
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/actions/token')).toHaveLength(1);
  });

  it('refreshes an expired token once before a stream has started', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('old-token'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('new-token'))
      .mockResolvedValueOnce(
        streamResponse([
          '{"type":"start","runId":"run-2","repository":"appwrite/cloud","number":102}\n',
          '{"type":"complete","exitCode":0}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of streamClaudeRun(request)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ exitCode: 0, type: 'complete' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Action-Token': 'new-token' }),
      }),
    );
  });

  it.each([
    ['a non-start first event', '{"type":"text","text":"wrong"}\n'],
    [
      'an event with extra properties',
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102,"extra":true}\n',
    ],
    [
      'a start event for another pull request',
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":999}\n',
    ],
    [
      'malformed JSON',
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\nnot-json',
    ],
  ])('rejects %s', async (_label, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(streamResponse([body])),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // Consume until validation fails.
      }
    };

    await expect(consume()).rejects.toThrow(/different|invalid|malformed|without a start/);
  });

  it.each([
    [
      'a stream without a terminal event',
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n',
      /before reporting completion/,
    ],
    [
      'data after a terminal event',
      '{"type":"start","runId":"run-1","repository":"appwrite/cloud","number":102}\n' +
        '{"type":"complete","exitCode":0}\n' +
        '{"type":"text","text":"late"}\n',
      /after a terminal event/,
    ],
  ])('rejects %s', async (_label, body, error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(streamResponse([body])),
    );

    const consume = async () => {
      for await (const _event of streamClaudeRun(request)) {
        // Consume until validation fails.
      }
    };

    await expect(consume()).rejects.toThrow(error);
  });

  it('forwards AbortSignal to token and run requests', async () => {
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
    vi.stubGlobal('fetch', fetchMock);

    for await (const _event of streamClaudeRun(request, controller.signal)) {
      // Consume the stream.
    }

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('cancelClaudeRun', () => {
  it('uses the cached action token and URL-encodes the run id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await cancelClaudeRun('run/with spaces');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/claude/runs/run%2Fwith%20spaces',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Action-Token': 'action-token' }),
        method: 'DELETE',
      }),
    );
  });
});
