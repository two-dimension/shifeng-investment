import { authorizeBearer } from './auth'

export const REFRESH_FRESH_MS = 6 * 60 * 60 * 1000
export const REFRESH_LOCK_MS = 45 * 60 * 1000

export type RefreshStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed'

export interface RefreshState {
  scope: 'all'
  jobId: string | null
  status: RefreshStatus
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

export type DispatchFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type RefreshContext = Pick<ExecutionContext, 'waitUntil'>

type RefreshEnv = Pick<
  Env,
  | 'RESEARCH_DB'
  | 'GITHUB_DISPATCH_TOKEN'
  | 'GITHUB_OWNER'
  | 'GITHUB_REPO'
  | 'RESEARCH_PUBLISH_TOKEN'
>

type InternalRefreshEnv = Pick<Env, 'RESEARCH_DB' | 'RESEARCH_PUBLISH_TOKEN'>

interface RefreshRow {
  scope: string
  jobId: string | null
  status: string
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

function isRefreshStatus(value: string): value is RefreshStatus {
  return value === 'idle'
    || value === 'queued'
    || value === 'running'
    || value === 'success'
    || value === 'failed'
}

function mapRefreshRow(row: RefreshRow): RefreshState {
  if (row.scope !== 'all' || !isRefreshStatus(row.status)) {
    throw new Error('Stored research refresh state is invalid')
  }
  return {
    scope: 'all',
    jobId: row.jobId,
    status: row.status,
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
  }
}

async function ensureRefreshState(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO research_refresh_state (scope, status)
       VALUES ('all', 'idle')`,
    )
    .run()
}

export async function getRefreshStatus(db: D1Database): Promise<RefreshState> {
  await ensureRefreshState(db)
  const row = await db
    .prepare(
      `SELECT
         scope,
         job_id AS jobId,
         status,
         requested_at AS requestedAt,
         started_at AS startedAt,
         finished_at AS finishedAt,
         last_success_at AS lastSuccessAt,
         last_error AS lastError
       FROM research_refresh_state
       WHERE scope = 'all'`,
    )
    .first<RefreshRow>()

  if (row === null) {
    throw new Error('Research refresh state is missing')
  }
  return mapRefreshRow(row)
}

async function markDispatchFailed(
  db: D1Database,
  jobId: string,
  finishedAt: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE research_refresh_state
       SET status = 'failed', finished_at = ?, last_error = ?
       WHERE scope = 'all'
         AND job_id = ?
         AND status IN ('queued', 'running')`,
    )
    .bind(finishedAt, error.slice(0, 1000), jobId)
    .run()
}

async function dispatchRefresh(
  env: RefreshEnv,
  jobId: string,
  nowIso: string,
  dispatchFetch: DispatchFetch,
): Promise<void> {
  try {
    const response = await dispatchFetch(
      `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'shifeng-investment-cloud-worker',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'research-refresh',
          client_payload: { job_id: jobId },
        }),
      },
    )
    if (!response.ok) {
      await markDispatchFailed(
        env.RESEARCH_DB,
        jobId,
        nowIso,
        `GitHub dispatch failed with HTTP ${response.status}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markDispatchFailed(
      env.RESEARCH_DB,
      jobId,
      nowIso,
      `GitHub dispatch failed: ${message}`,
    )
  }
}

export async function requestRefresh(
  env: RefreshEnv,
  ctx: RefreshContext,
  now: Date,
  dispatchFetch: DispatchFetch = fetch,
  createJobId: () => string = () => crypto.randomUUID(),
): Promise<{ dispatched: boolean; state: RefreshState }> {
  await ensureRefreshState(env.RESEARCH_DB)
  const nowIso = now.toISOString()
  const freshCutoff = new Date(now.getTime() - REFRESH_FRESH_MS).toISOString()
  const lockCutoff = new Date(now.getTime() - REFRESH_LOCK_MS).toISOString()
  const jobId = createJobId()
  const claim = await env.RESEARCH_DB
    .prepare(
      `UPDATE research_refresh_state
       SET
         job_id = ?,
         status = 'queued',
         requested_at = ?,
         started_at = NULL,
         finished_at = NULL,
         last_error = NULL
       WHERE scope = 'all'
         AND (last_success_at IS NULL OR last_success_at < ?)
         AND (
           status NOT IN ('queued', 'running')
           OR COALESCE(started_at, requested_at, '') <= ?
         )`,
    )
    .bind(jobId, nowIso, freshCutoff, lockCutoff)
    .run()

  const state = await getRefreshStatus(env.RESEARCH_DB)
  if (claim.meta.changes !== 1) {
    return { dispatched: false, state }
  }

  ctx.waitUntil(dispatchRefresh(env, jobId, nowIso, dispatchFetch))
  return { dispatched: true, state }
}

async function transitionRefreshState(
  db: D1Database,
  jobId: string,
  status: 'running' | 'success' | 'failed',
  nowIso: string,
  error: string | null,
): Promise<{ updated: boolean; state: RefreshState }> {
  let statement: D1PreparedStatement
  if (status === 'running') {
    statement = db
      .prepare(
        `UPDATE research_refresh_state
         SET status = 'running', started_at = COALESCE(started_at, ?),
             finished_at = NULL, last_error = NULL
         WHERE scope = 'all' AND job_id = ? AND status IN ('queued', 'running')`,
      )
      .bind(nowIso, jobId)
  } else if (status === 'success') {
    statement = db
      .prepare(
        `UPDATE research_refresh_state
         SET status = 'success', started_at = COALESCE(started_at, ?),
             finished_at = ?, last_success_at = ?, last_error = NULL
         WHERE scope = 'all' AND job_id = ? AND status IN ('queued', 'running')`,
      )
      .bind(nowIso, nowIso, nowIso, jobId)
  } else {
    statement = db
      .prepare(
        `UPDATE research_refresh_state
         SET status = 'failed', started_at = COALESCE(started_at, ?),
             finished_at = ?, last_error = ?
         WHERE scope = 'all' AND job_id = ? AND status IN ('queued', 'running')`,
      )
      .bind(nowIso, nowIso, (error ?? 'Research refresh failed').slice(0, 1000), jobId)
  }

  const result = await statement.run()
  const state = await getRefreshStatus(db)
  const repeatedTerminalUpdate = state.jobId === jobId && state.status === status
  return { updated: result.meta.changes === 1 || repeatedTerminalUpdate, state }
}

function jsonResponse(body: unknown, status = 200): Response {
  const errorCodes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    405: 'METHOD_NOT_ALLOWED',
    409: 'REFRESH_CONFLICT',
  }
  let responseBody = body
  if (status >= 400 && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string' && typeof record.code !== 'string') {
      responseBody = { ...record, code: errorCodes[status] ?? 'REQUEST_FAILED' }
    }
  }

  return Response.json(responseBody, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function handleInternalRefreshStateRequest(
  request: Request,
  env: InternalRefreshEnv,
  now: Date = new Date(),
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/research/internal/refresh-state') {
    return null
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }
  if (!(await authorizeBearer(request, env.RESEARCH_PUBLISH_TOKEN))) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonResponse({ error: 'Request body must be an object' }, 400)
  }

  const jobId = Reflect.get(body, 'jobId')
  const status = Reflect.get(body, 'status')
  const errorValue = Reflect.get(body, 'error')
  if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 128) {
    return jsonResponse({ error: 'Invalid refresh job ID' }, 400)
  }
  if (status !== 'running' && status !== 'success' && status !== 'failed') {
    return jsonResponse({ error: 'Invalid refresh status' }, 400)
  }
  if (errorValue !== undefined && typeof errorValue !== 'string') {
    return jsonResponse({ error: 'Invalid refresh error' }, 400)
  }

  const result = await transitionRefreshState(
    env.RESEARCH_DB,
    jobId,
    status,
    now.toISOString(),
    errorValue ?? null,
  )
  if (!result.updated) {
    return jsonResponse({ error: 'Refresh job is not active', state: result.state }, 409)
  }
  return jsonResponse(result.state)
}

export async function handleResearchRefreshRequest(
  request: Request,
  env: RefreshEnv,
  ctx: RefreshContext,
  now: Date = new Date(),
  dispatchFetch: DispatchFetch = fetch,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (pathname === '/api/research/refresh/status') {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }
    return jsonResponse(await getRefreshStatus(env.RESEARCH_DB))
  }
  if (pathname === '/api/research/refresh') {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }
    const result = await requestRefresh(env, ctx, now, dispatchFetch)
    return jsonResponse(result, result.dispatched ? 202 : 200)
  }
  return null
}
