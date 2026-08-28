import { isDateKey, isResearchKind } from './research-contract'
import { handleResearchPublishRequest } from './research-publish'
import { handleResearchRefreshRequest, type DispatchFetch, type RefreshContext } from './research-refresh'
import { getLatestSummary, getSummary, listSummaryDates } from './research-store'

export type WorkerEnv = Pick<
  Env,
  | 'ASSETS'
  | 'RESEARCH_DB'
  | 'RESEARCH_REPORTS'
  | 'GITHUB_DISPATCH_TOKEN'
  | 'RESEARCH_PUBLISH_TOKEN'
  | 'GITHUB_OWNER'
  | 'GITHUB_REPO'
  | 'LEGACY_API_ORIGIN'
>

const RESEARCH_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]

function jsonResponse(body: unknown, status = 200, cacheControl = 'no-store'): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': cacheControl },
  })
}

function errorResponse(error: string, code: string, status: number): Response {
  return jsonResponse({ error, code }, status)
}

function decodedSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
}

async function handleResearchReadRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response | null> {
  const segments = decodedSegments(new URL(request.url).pathname)
  if (
    segments === null
    || segments.length !== 4
    || segments[0] !== 'api'
    || segments[1] !== 'research'
  ) {
    return null
  }

  const kind = segments[2]
  const selector = segments[3]
  if (!isResearchKind(kind)) {
    return errorResponse('Invalid research kind.', 'INVALID_RESEARCH_KIND', 400)
  }
  if (request.method !== 'GET') {
    return errorResponse('Method not allowed.', 'METHOD_NOT_ALLOWED', 405)
  }

  if (selector === 'latest') {
    return jsonResponse(
      await getLatestSummary(env.RESEARCH_DB, kind),
      200,
      RESEARCH_CACHE_CONTROL,
    )
  }
  if (selector === 'history') {
    return jsonResponse(
      { kind, dates: await listSummaryDates(env.RESEARCH_DB, kind) },
      200,
      RESEARCH_CACHE_CONTROL,
    )
  }
  if (!isDateKey(selector)) {
    return errorResponse(
      'Invalid research date; expected YYYY-MM-DD.',
      'INVALID_RESEARCH_DATE',
      400,
    )
  }

  const summary = await getSummary(env.RESEARCH_DB, kind, selector)
  if (summary === null) {
    return errorResponse(
      `No ${kind} data for ${selector}.`,
      'RESEARCH_NOT_FOUND',
      404,
    )
  }
  return jsonResponse(summary, 200, RESEARCH_CACHE_CONTROL)
}

function legacyTarget(requestUrl: URL, configuredOrigin: string): URL | null {
  let base: URL
  try {
    base = new URL(configuredOrigin)
  } catch {
    return null
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password) {
    return null
  }
  const target = new URL(requestUrl.pathname + requestUrl.search, base.origin)
  return target.origin === requestUrl.origin ? null : target
}

async function proxyLegacyApi(
  request: Request,
  env: WorkerEnv,
  fetchImpl: DispatchFetch,
): Promise<Response> {
  const configuredOrigin = env.LEGACY_API_ORIGIN.trim()
  if (configuredOrigin.length === 0) {
    return errorResponse(
      'This feature needs the legacy local service, which is currently offline.',
      'LEGACY_API_OFFLINE',
      503,
    )
  }

  const requestUrl = new URL(request.url)
  const target = legacyTarget(requestUrl, configuredOrigin)
  if (target === null) {
    const recursive = (() => {
      try {
        return new URL(configuredOrigin).origin === requestUrl.origin
      } catch {
        return false
      }
    })()
    return errorResponse(
      recursive
        ? 'The legacy API origin cannot point back to this Worker.'
        : 'The legacy API origin is invalid.',
      recursive ? 'LEGACY_API_RECURSIVE' : 'LEGACY_API_INVALID_ORIGIN',
      503,
    )
  }

  const headers = new Headers(request.headers)
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name)
  }
  if (headers.get('Authorization') === `Bearer ${env.RESEARCH_PUBLISH_TOKEN}`) {
    headers.delete('Authorization')
  }

  try {
    return await fetchImpl(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      redirect: 'manual',
    })
  } catch {
    return errorResponse(
      'The legacy local service is currently offline.',
      'LEGACY_API_OFFLINE',
      503,
    )
  }
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  ctx: RefreshContext,
  fetchImpl: DispatchFetch = fetch,
): Promise<Response> {
  const startedAt = performance.now()
  const requestUrl = new URL(request.url)
  const requestId = request.headers.get('CF-Ray') ?? crypto.randomUUID()
  let route = 'unknown'
  let response: Response

  try {
    const publishResponse = await handleResearchPublishRequest(request, env)
    if (publishResponse !== null) {
      route = 'research-publish'
      response = publishResponse
    } else {
      const refreshResponse = await handleResearchRefreshRequest(
        request,
        env,
        ctx,
        new Date(),
        fetchImpl,
      )
      if (refreshResponse !== null) {
        route = 'research-refresh'
        response = refreshResponse
      } else {
        const readResponse = await handleResearchReadRequest(request, env)
        if (readResponse !== null) {
          route = 'research-read'
          response = readResponse
        } else if (requestUrl.pathname === '/api/research' || requestUrl.pathname.startsWith('/api/research/')) {
          route = 'research-not-found'
          response = errorResponse('Research route not found.', 'RESEARCH_ROUTE_NOT_FOUND', 404)
        } else if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
          route = 'legacy-api'
          response = await proxyLegacyApi(request, env, fetchImpl)
        } else {
          route = 'assets'
          response = await env.ASSETS.fetch(request)
        }
      }
    }
  } catch (error) {
    route = `${route}-error`
    console.error({
      event: 'worker_request_error',
      requestId,
      method: request.method,
      path: requestUrl.pathname,
      message: error instanceof Error ? error.message : String(error),
    })
    response = errorResponse('Unexpected Worker error.', 'INTERNAL_ERROR', 500)
  }

  console.log({
    event: 'worker_request',
    requestId,
    method: request.method,
    path: requestUrl.pathname,
    route,
    status: response.status,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  })
  return response
}

export default {
  fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
