import { authorizeBearer } from './auth'
import { isDateKey, isResearchKind } from './research-contract'
import {
  attachmentDisposition,
  isResearchFilename,
  researchContentType,
  researchObjectKey,
} from './research-files'
import { putSummary } from './research-store'
import { handleInternalRefreshStateRequest } from './research-refresh'

export const MAX_SUMMARY_BYTES = 1024 * 1024
export const MAX_REPORT_BYTES = 20 * 1024 * 1024

type ResearchPublishEnv = Pick<
  Env,
  'RESEARCH_DB' | 'RESEARCH_REPORTS' | 'RESEARCH_PUBLISH_TOKEN'
>

class PayloadTooLargeError extends Error {}

function jsonResponse(body: unknown, status: number): Response {
  const errorCodes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    411: 'LENGTH_REQUIRED',
    413: 'PAYLOAD_TOO_LARGE',
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
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function routeSegments(url: URL): string[] | null {
  try {
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get('Content-Length')
  if (value === null) {
    return null
  }
  if (!/^\d+$/u.test(value)) {
    return Number.NaN
  }
  return Number(value)
}

async function readLimitedText(request: Request, maximumBytes: number): Promise<string> {
  const declared = declaredContentLength(request)
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > maximumBytes)) {
    throw new PayloadTooLargeError()
  }
  if (request.body === null) {
    return ''
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new PayloadTooLargeError()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function isSummaryRoute(segments: string[]): boolean {
  return segments.length === 6
    && segments[0] === 'api'
    && segments[1] === 'research'
    && segments[2] === 'internal'
    && segments[3] === 'summaries'
}

function isInternalFileRoute(segments: string[]): boolean {
  return segments.length === 7
    && segments[0] === 'api'
    && segments[1] === 'research'
    && segments[2] === 'internal'
    && segments[3] === 'files'
}

function isPublicFileRoute(segments: string[]): boolean {
  return segments.length === 6
    && segments[0] === 'api'
    && segments[1] === 'research'
    && segments[2] === 'files'
}

function validPathIdentity(kind: string, date: string): boolean {
  return isResearchKind(kind) && isDateKey(date)
}

async function publishSummary(
  request: Request,
  env: ResearchPublishEnv,
  kind: string,
  date: string,
): Promise<Response> {
  if (!(await authorizeBearer(request, env.RESEARCH_PUBLISH_TOKEN))) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }
  if (!validPathIdentity(kind, date)) {
    return jsonResponse({ error: 'Invalid research kind or date' }, 400)
  }

  let text: string
  try {
    text = await readLimitedText(request, MAX_SUMMARY_BYTES)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return jsonResponse({ error: 'Summary exceeds 1 MiB' }, 413)
    }
    throw error
  }

  let summary: unknown
  try {
    summary = JSON.parse(text)
  } catch {
    return jsonResponse({ error: 'Summary must be valid JSON' }, 400)
  }

  try {
    await putSummary(env.RESEARCH_DB, { kind, date, summary })
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return jsonResponse({ error: error.message }, 400)
    }
    throw error
  }

  return jsonResponse({ success: true, kind, date }, 201)
}

async function publishFile(
  request: Request,
  env: ResearchPublishEnv,
  kind: string,
  date: string,
  filename: string,
): Promise<Response> {
  if (!(await authorizeBearer(request, env.RESEARCH_PUBLISH_TOKEN))) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }
  if (!validPathIdentity(kind, date) || !isResearchFilename(filename)) {
    return jsonResponse({ error: 'Invalid research file path' }, 400)
  }

  const contentLength = declaredContentLength(request)
  if (contentLength === null) {
    return jsonResponse({ error: 'Content-Length is required' }, 411)
  }
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    return jsonResponse({ error: 'Invalid Content-Length' }, 400)
  }
  if (contentLength > MAX_REPORT_BYTES) {
    return jsonResponse({ error: 'Report exceeds 20 MiB' }, 413)
  }
  if (request.body === null) {
    return jsonResponse({ error: 'Report body is required' }, 400)
  }

  const key = researchObjectKey(kind, date, filename)
  await env.RESEARCH_REPORTS.put(key, request.body, {
    httpMetadata: {
      contentType: researchContentType(filename),
    },
    customMetadata: { kind, date, filename },
  })

  return jsonResponse({ success: true, kind, date, filename }, 201)
}

async function downloadFile(
  env: ResearchPublishEnv,
  kind: string,
  date: string,
  filename: string,
): Promise<Response> {
  if (!validPathIdentity(kind, date) || !isResearchFilename(filename)) {
    return jsonResponse({ error: 'Invalid research file path' }, 400)
  }

  const object = await env.RESEARCH_REPORTS.get(researchObjectKey(kind, date, filename))
  if (object === null) {
    return jsonResponse({ error: 'Research file not found' }, 404)
  }

  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType ?? researchContentType(filename),
    'Content-Length': String(object.size),
    'Content-Disposition': attachmentDisposition(filename),
    'Cache-Control': 'public, max-age=3600',
    ETag: object.httpEtag,
  })
  return new Response(object.body, { status: 200, headers })
}

export async function handleResearchPublishRequest(
  request: Request,
  env: ResearchPublishEnv,
  now: Date = new Date(),
): Promise<Response | null> {
  const refreshStateResponse = await handleInternalRefreshStateRequest(request, env, now)
  if (refreshStateResponse !== null) {
    return refreshStateResponse
  }

  const segments = routeSegments(new URL(request.url))
  if (segments === null) {
    return jsonResponse({ error: 'Invalid request path' }, 400)
  }

  if (isSummaryRoute(segments)) {
    if (request.method !== 'PUT') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }
    return publishSummary(request, env, segments[4], segments[5])
  }

  if (isInternalFileRoute(segments)) {
    if (request.method !== 'PUT') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }
    return publishFile(request, env, segments[4], segments[5], segments[6])
  }

  if (isPublicFileRoute(segments)) {
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405)
    }
    return downloadFile(env, segments[3], segments[4], segments[5])
  }

  return null
}
