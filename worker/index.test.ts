import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { researchObjectKey } from './research-files'
import { handleWorkerRequest, type WorkerEnv } from './index'
import { getSummary, putSummary } from './research-store'

function createEnv(options?: {
  legacyOrigin?: string
  assetFetch?: WorkerEnv['ASSETS']['fetch']
}): WorkerEnv {
  return {
    RESEARCH_DB: env.RESEARCH_DB,
    RESEARCH_REPORTS: env.RESEARCH_REPORTS,
    RESEARCH_PUBLISH_TOKEN: env.RESEARCH_PUBLISH_TOKEN,
    GITHUB_DISPATCH_TOKEN: env.GITHUB_DISPATCH_TOKEN,
    GITHUB_OWNER: env.GITHUB_OWNER,
    GITHUB_REPO: env.GITHUB_REPO,
    LEGACY_API_ORIGIN: options?.legacyOrigin ?? '',
    ASSETS: {
      fetch: options?.assetFetch ?? (async () => new Response('asset fallback')),
    } as Fetcher,
  }
}

function createContext(): Pick<ExecutionContext, 'waitUntil'> {
  return { waitUntil: vi.fn() }
}

async function get(
  path: string,
  workerEnv = createEnv(),
): Promise<Response> {
  return handleWorkerRequest(
    new Request(`https://example.com${path}`),
    workerEnv,
    createContext(),
  )
}

beforeEach(async () => {
  await applyD1Migrations(env.RESEARCH_DB, env.TEST_MIGRATIONS)
  await env.RESEARCH_DB.prepare('DELETE FROM research_summaries').run()
})

describe('public research API', () => {
  it('serves latest, history, and a selected date from D1', async () => {
    await putSummary(env.RESEARCH_DB, {
      kind: 'cninfo',
      date: '2026-08-27',
      summary: { generatedAt: '2026-08-27T01:00:00.000Z', totalCount: 2 },
    })
    await putSummary(env.RESEARCH_DB, {
      kind: 'cninfo',
      date: '2026-08-28',
      summary: { generatedAt: '2026-08-28T01:00:00.000Z', totalCount: 5 },
    })

    const latest = await get('/api/research/cninfo/latest')
    const history = await get('/api/research/cninfo/history')
    const selected = await get('/api/research/cninfo/2026-08-27')

    expect(latest.status).toBe(200)
    await expect(latest.json()).resolves.toMatchObject({ date: '2026-08-28', totalCount: 5 })
    expect(latest.headers.get('Cache-Control')).toContain('stale-while-revalidate')
    await expect(history.json()).resolves.toEqual({
      kind: 'cninfo',
      dates: ['2026-08-28', '2026-08-27'],
    })
    await expect(selected.json()).resolves.toMatchObject({ date: '2026-08-27', totalCount: 2 })
  })

  it('returns null for an empty latest route and structured errors for bad dates', async () => {
    const latest = await get('/api/research/risk/latest')
    const invalid = await get('/api/research/risk/2026-02-30')
    const missing = await get('/api/research/risk/2026-08-28')

    expect(await latest.json()).toBeNull()
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'INVALID_RESEARCH_DATE' })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ code: 'RESEARCH_NOT_FOUND' })
  })

  it('serves R2 files before the SPA asset fallback', async () => {
    const assetFetch = vi.fn(async () => new Response('wrong route'))
    const filename = 'risk-report.pdf'
    const bytes = new Uint8Array([1, 2, 3, 4])
    await env.RESEARCH_REPORTS.put(
      researchObjectKey('risk', '2026-08-28', filename),
      bytes,
      { httpMetadata: { contentType: 'application/pdf' } },
    )

    const response = await get(
      `/api/research/files/risk/2026-08-28/${filename}`,
      createEnv({ assetFetch }),
    )

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(assetFetch).not.toHaveBeenCalled()
  })
})

describe('workers.dev internal-only surface', () => {
  it('blocks the public site and read APIs on the unprotected workers.dev hostname', async () => {
    const workerEnv = createEnv()
    const site = await handleWorkerRequest(
      new Request('https://shifeng-investment.example.workers.dev/'),
      workerEnv,
      createContext(),
    )
    const research = await handleWorkerRequest(
      new Request('https://shifeng-investment.example.workers.dev/api/research/cninfo/latest'),
      workerEnv,
      createContext(),
    )

    expect(site.status).toBe(404)
    expect(research.status).toBe(404)
    await expect(research.json()).resolves.toEqual({
      error: 'This hostname only accepts internal research publishing requests.',
      code: 'INTERNAL_HOST_ONLY',
    })
  })

  it('keeps authenticated internal publishing available on workers.dev', async () => {
    const response = await handleWorkerRequest(
      new Request(
        'https://shifeng-investment.example.workers.dev/api/research/internal/summaries/cninfo/2026-08-28',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${env.RESEARCH_PUBLISH_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ generatedAt: '2026-08-28T02:00:00.000Z', totalCount: 3 }),
        },
      ),
      createEnv(),
      createContext(),
    )

    expect(response.status).toBe(201)
    await expect(getSummary(env.RESEARCH_DB, 'cninfo', '2026-08-28')).resolves.toMatchObject({
      totalCount: 3,
    })
  })
})

describe('site assets and legacy API fallback', () => {
  it('passes non-API navigation to the static asset binding', async () => {
    const assetFetch = vi.fn(async (request: RequestInfo | URL) => (
      new Response(`asset:${new Request(request).url}`)
    ))
    const response = await get('/research', createEnv({ assetFetch }))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset:https://example.com/research')
    expect(assetFetch).toHaveBeenCalledOnce()
  })

  it('returns a clear 503 when the old local API is offline', async () => {
    const response = await get('/api/news')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'This feature needs the legacy local service, which is currently offline.',
      code: 'LEGACY_API_OFFLINE',
    })
  })

  it('proxies the URL, method, safe headers, body, status, and response headers', async () => {
    const proxiedRequests: Request[] = []
    const legacyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      proxiedRequests.push(new Request(input, init))
      return new Response('legacy response', {
        status: 201,
        headers: { 'X-Legacy': 'yes' },
      })
    })
    const response = await handleWorkerRequest(
      new Request('https://example.com/api/news?market=cn', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-publish-token',
          'Content-Type': 'application/json',
          'X-Client': 'web',
        },
        body: '{"query":"latest"}',
      }),
      createEnv({ legacyOrigin: 'https://legacy.example' }),
      createContext(),
      legacyFetch,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('X-Legacy')).toBe('yes')
    expect(await response.text()).toBe('legacy response')
    const proxiedRequest = proxiedRequests[0]
    expect(proxiedRequest).toBeDefined()
    expect(proxiedRequest.url).toBe('https://legacy.example/api/news?market=cn')
    expect(proxiedRequest.method).toBe('POST')
    expect(proxiedRequest.headers.get('X-Client')).toBe('web')
    expect(proxiedRequest.headers.get('Authorization')).toBeNull()
    expect(await proxiedRequest.text()).toBe('{"query":"latest"}')
  })

  it('rejects a recursive legacy origin without fetching', async () => {
    const legacyFetch = vi.fn(async () => new Response('must not run'))
    const response = await handleWorkerRequest(
      new Request('https://example.com/api/news'),
      createEnv({ legacyOrigin: 'https://example.com' }),
      createContext(),
      legacyFetch,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'LEGACY_API_RECURSIVE' })
    expect(legacyFetch).not.toHaveBeenCalled()
  })
})
