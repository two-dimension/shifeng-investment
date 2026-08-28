import assert from 'node:assert/strict';
import test from 'node:test';

import {
  keepCachedResearchData,
  pollResearchRefresh,
  requestResearchRefresh,
} from '../src/hooks/researchRefresh.ts';

const BASE_STATE = {
  scope: 'all' as const,
  jobId: 'job-123',
  status: 'queued' as const,
  requestedAt: '2026-08-28T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: '2026-08-28T01:00:00.000Z',
  lastError: null,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('request returns fresh cached state without requiring a new job', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const result = await requestResearchRefresh(async (input, init) => {
    calls.push({ input: String(input), init });
    return response({
      dispatched: false,
      state: { ...BASE_STATE, status: 'success', jobId: 'previous-job' },
    });
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.state.status, 'success');
  assert.deepEqual(calls.map((call) => [call.input, call.init?.method]), [
    ['/api/research/refresh', 'POST'],
  ]);
});

test('polling follows queued and running states until success', async () => {
  const states = [
    { ...BASE_STATE, status: 'queued' as const },
    { ...BASE_STATE, status: 'running' as const, startedAt: '2026-08-28T12:01:00.000Z' },
    { ...BASE_STATE, status: 'success' as const, finishedAt: '2026-08-28T12:02:00.000Z' },
  ];
  const result = await pollResearchRefresh(async () => response(states.shift()), {
    intervalMs: 1,
    timeoutMs: 100,
    wait: async () => {},
  });

  assert.equal(result.status, 'success');
  assert.equal(states.length, 0);
});

test('polling returns a failed state so cached content can remain visible', async () => {
  const state = {
    ...BASE_STATE,
    status: 'failed' as const,
    finishedAt: '2026-08-28T12:02:00.000Z',
    lastError: '上游超时',
  };
  const result = await pollResearchRefresh(async () => response(state), {
    wait: async () => {},
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.lastError, '上游超时');
});

test('polling rejects on timeout, abort, malformed state, and HTTP errors', async () => {
  let now = 0;
  await assert.rejects(
    pollResearchRefresh(async () => response(BASE_STATE), {
      intervalMs: 5,
      timeoutMs: 10,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    }),
    /等待云端更新超时/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pollResearchRefresh(async () => response(BASE_STATE), { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );

  await assert.rejects(
    requestResearchRefresh(async () => response({ dispatched: true, state: { status: 'mystery' } })),
    /返回格式不正确/,
  );
  await assert.rejects(
    requestResearchRefresh(async () => response({ error: '服务不可用' }, 503)),
    /服务不可用/,
  );
});

test('a refresh error preserves the last-good summary', () => {
  const cached = { kind: 'cninfo', date: '2026-08-27', totalCount: 8 };
  assert.deepEqual(keepCachedResearchData(cached, new Error('刷新失败')), {
    data: cached,
    loading: false,
    error: '刷新失败',
  });
});
