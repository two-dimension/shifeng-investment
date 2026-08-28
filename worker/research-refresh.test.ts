import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleResearchPublishRequest } from './research-publish'
import {
  getRefreshStatus,
  handleResearchRefreshRequest,
  requestRefresh,
  type DispatchFetch,
  type RefreshContext,
} from './research-refresh'
import { getSummary, putSummary } from './research-store'

const now = new Date('2026-08-28T03:00:00.000Z')
const fixedJobId = '7ce179d8-014f-4a79-bf2d-3a99933071c1'

function hoursBefore(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString()
}

function createContext(): { ctx: RefreshContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil(promise) {
        tasks.push(promise)
      },
    },
    tasks,
  }
}

async function setRefreshState(values: {
  jobId?: string | null
  status?: string
  requestedAt?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
}): Promise<void> {
  await env.RESEARCH_DB.prepare(
    `UPDATE research_refresh_state SET
       job_id = ?, status = ?, requested_at = ?, started_at = ?, finished_at = ?,
       last_success_at = ?, last_error = ?
     WHERE scope = 'all'`,
  )
    .bind(
      values.jobId ?? null,
      values.status ?? 'idle',
      values.requestedAt ?? null,
      values.startedAt ?? null,
      values.finishedAt ?? null,
      values.lastSuccessAt ?? null,
      values.lastError ?? null,
    )
    .run()
}

function successfulDispatch(calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>): DispatchFetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return new Response(null, { status: 204 })
  })
}

beforeEach(async () => {
  await applyD1Migrations(env.RESEARCH_DB, env.TEST_MIGRATIONS)
  await env.RESEARCH_DB.prepare('DELETE FROM research_summaries').run()
  await setRefreshState({})
})

describe('refresh lock and GitHub dispatch', () => {
  it('does not dispatch while the cache is fresh', async () => {
    await setRefreshState({ status: 'success', lastSuccessAt: hoursBefore(1) })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const { ctx, tasks } = createContext()

    const result = await requestRefresh(env, ctx, now, successfulDispatch(calls), () => fixedJobId)

    expect(result.dispatched).toBe(false)
    expect(result.state.status).toBe('success')
    expect(calls).toHaveLength(0)
    expect(tasks).toHaveLength(0)
  })

  it('claims stale work once and dispatches the exact GitHub event', async () => {
    await setRefreshState({ status: 'success', lastSuccessAt: hoursBefore(7) })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const { ctx, tasks } = createContext()

    const result = await requestRefresh(env, ctx, now, successfulDispatch(calls), () => fixedJobId)
    await Promise.all(tasks)

    expect(result.dispatched).toBe(true)
    expect(result.state).toMatchObject({ jobId: fixedJobId, status: 'queued' })
    expect(calls).toHaveLength(1)
    expect(String(calls[0].input)).toBe(
      'https://api.github.com/repos/raywang99131/shifeng-investment/dispatches',
    )
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      event_type: 'research-refresh',
      client_payload: { job_id: fixedJobId },
    })
  })

  it('allows only one of two simultaneous refresh requests to dispatch', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const dispatch = successfulDispatch(calls)
    const first = createContext()
    const second = createContext()

    const results = await Promise.all([
      requestRefresh(env, first.ctx, now, dispatch, () => `${fixedJobId}-first`),
      requestRefresh(env, second.ctx, now, dispatch, () => `${fixedJobId}-second`),
    ])
    await Promise.all([...first.tasks, ...second.tasks])

    expect(results.filter(({ dispatched }) => dispatched)).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it.each(['queued', 'running'] as const)('reuses an active %s job', async (status) => {
    await setRefreshState({
      jobId: fixedJobId,
      status,
      requestedAt: hoursBefore(0.25),
      startedAt: status === 'running' ? hoursBefore(0.2) : null,
    })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const { ctx } = createContext()

    const result = await requestRefresh(env, ctx, now, successfulDispatch(calls))

    expect(result).toMatchObject({ dispatched: false, state: { jobId: fixedJobId, status } })
    expect(calls).toHaveLength(0)
  })

  it('reclaims a running lock after 45 minutes', async () => {
    await setRefreshState({
      jobId: 'abandoned-job',
      status: 'running',
      requestedAt: hoursBefore(1),
      startedAt: new Date(now.getTime() - 46 * 60 * 1000).toISOString(),
    })
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const { ctx, tasks } = createContext()

    const result = await requestRefresh(env, ctx, now, successfulDispatch(calls), () => fixedJobId)
    await Promise.all(tasks)

    expect(result).toMatchObject({ dispatched: true, state: { jobId: fixedJobId, status: 'queued' } })
    expect(calls).toHaveLength(1)
  })

  it('marks the claimed job failed when GitHub rejects dispatch', async () => {
    const { ctx, tasks } = createContext()
    const rejectedDispatch: DispatchFetch = vi.fn(async () => new Response('no', { status: 500 }))

    const result = await requestRefresh(env, ctx, now, rejectedDispatch, () => fixedJobId)
    await Promise.all(tasks)

    expect(result.dispatched).toBe(true)
    await expect(getRefreshStatus(env.RESEARCH_DB)).resolves.toMatchObject({
      jobId: fixedJobId,
      status: 'failed',
      finishedAt: now.toISOString(),
      lastError: 'GitHub dispatch failed with HTTP 500',
    })
  })
})

describe('refresh routes and internal transitions', () => {
  it('exposes public status and refresh routes', async () => {
    await setRefreshState({ status: 'success', lastSuccessAt: hoursBefore(1) })
    const { ctx } = createContext()

    const status = await handleResearchRefreshRequest(
      new Request('https://example.com/api/research/refresh/status'),
      env,
      ctx,
      now,
    )
    const refresh = await handleResearchRefreshRequest(
      new Request('https://example.com/api/research/refresh', { method: 'POST' }),
      env,
      ctx,
      now,
    )

    expect(status?.status).toBe(200)
    await expect(status?.json()).resolves.toMatchObject({ status: 'success' })
    expect(refresh?.status).toBe(200)
    await expect(refresh?.json()).resolves.toMatchObject({ dispatched: false })
  })

  it('requires authorization and the matching job for internal transitions', async () => {
    await setRefreshState({
      jobId: fixedJobId,
      status: 'queued',
      requestedAt: now.toISOString(),
    })
    const path = '/api/research/internal/refresh-state'
    const unauthorized = await handleResearchPublishRequest(
      new Request(`https://example.com${path}`, {
        method: 'POST',
        body: JSON.stringify({ jobId: fixedJobId, status: 'running' }),
      }),
      env,
    )
    const wrongJob = await handleResearchPublishRequest(
      new Request(`https://example.com${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-publish-token' },
        body: JSON.stringify({ jobId: 'wrong-job', status: 'running' }),
      }),
      env,
    )

    expect(unauthorized?.status).toBe(401)
    expect(wrongJob?.status).toBe(409)
  })

  it('records running and success timestamps for the active job', async () => {
    await setRefreshState({
      jobId: fixedJobId,
      status: 'queued',
      requestedAt: now.toISOString(),
    })
    const path = '/api/research/internal/refresh-state'
    const running = await handleResearchPublishRequest(
      new Request(`https://example.com${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-publish-token' },
        body: JSON.stringify({ jobId: fixedJobId, status: 'running' }),
      }),
      env,
      now,
    )
    const finishedAt = new Date(now.getTime() + 60_000)
    const success = await handleResearchPublishRequest(
      new Request(`https://example.com${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-publish-token' },
        body: JSON.stringify({ jobId: fixedJobId, status: 'success' }),
      }),
      env,
      finishedAt,
    )

    expect(running?.status).toBe(200)
    expect(success?.status).toBe(200)
    await expect(getRefreshStatus(env.RESEARCH_DB)).resolves.toMatchObject({
      jobId: fixedJobId,
      status: 'success',
      startedAt: now.toISOString(),
      finishedAt: finishedAt.toISOString(),
      lastSuccessAt: finishedAt.toISOString(),
      lastError: null,
    })
  })

  it('records failure without deleting the last good summary', async () => {
    await putSummary(env.RESEARCH_DB, {
      kind: 'risk',
      date: '2026-08-27',
      summary: { generatedAt: hoursBefore(8), totalCount: 3 },
    })
    await setRefreshState({
      jobId: fixedJobId,
      status: 'running',
      requestedAt: hoursBefore(1),
      startedAt: hoursBefore(0.5),
      lastSuccessAt: hoursBefore(8),
    })

    const response = await handleResearchPublishRequest(
      new Request('https://example.com/api/research/internal/refresh-state', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-publish-token' },
        body: JSON.stringify({ jobId: fixedJobId, status: 'failed', error: 'upstream timeout' }),
      }),
      env,
      now,
    )

    expect(response?.status).toBe(200)
    await expect(getRefreshStatus(env.RESEARCH_DB)).resolves.toMatchObject({
      status: 'failed',
      lastSuccessAt: hoursBefore(8),
      lastError: 'upstream timeout',
    })
    await expect(getSummary(env.RESEARCH_DB, 'risk', '2026-08-27')).resolves.toMatchObject({
      totalCount: 3,
    })
  })
})
