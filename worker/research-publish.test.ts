import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import { authorizeBearer } from './auth'
import { researchObjectKey } from './research-files'
import {
  MAX_REPORT_BYTES,
  MAX_SUMMARY_BYTES,
  handleResearchPublishRequest,
} from './research-publish'
import { getSummary } from './research-store'

const baseUrl = 'https://example.com'
const authorization = { Authorization: 'Bearer test-publish-token' }

function request(path: string, init?: RequestInit): Request {
  return new Request(`${baseUrl}${path}`, init)
}

beforeEach(async () => {
  await applyD1Migrations(env.RESEARCH_DB, env.TEST_MIGRATIONS)
  await env.RESEARCH_DB.prepare('DELETE FROM research_summaries').run()
})

describe('publish authorization', () => {
  it('uses the expected bearer token', async () => {
    await expect(authorizeBearer(request('/'), 'test-publish-token')).resolves.toBe(false)
    await expect(
      authorizeBearer(request('/', { headers: { Authorization: 'Bearer wrong' } }), 'test-publish-token'),
    ).resolves.toBe(false)
    await expect(
      authorizeBearer(request('/', { headers: authorization }), 'test-publish-token'),
    ).resolves.toBe(true)
  })

  it('rejects missing and incorrect publish tokens', async () => {
    const path = '/api/research/internal/summaries/cninfo/2026-08-28'
    const withoutToken = await handleResearchPublishRequest(
      request(path, { method: 'PUT', body: '{}' }),
      env,
    )
    const wrongToken = await handleResearchPublishRequest(
      request(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer wrong' },
        body: '{}',
      }),
      env,
    )

    expect(withoutToken?.status).toBe(401)
    expect(wrongToken?.status).toBe(401)
  })
})

describe('research publishing routes', () => {
  it('validates kind, date, and report filename', async () => {
    const invalidKind = await handleResearchPublishRequest(
      request('/api/research/internal/summaries/news/2026-08-28', {
        method: 'PUT',
        headers: authorization,
        body: '{}',
      }),
      env,
    )
    const invalidDate = await handleResearchPublishRequest(
      request('/api/research/internal/summaries/cninfo/2026-02-30', {
        method: 'PUT',
        headers: authorization,
        body: '{}',
      }),
      env,
    )
    const invalidFilename = await handleResearchPublishRequest(
      request('/api/research/internal/files/cninfo/2026-08-28/report%2Fsecret.pdf', {
        method: 'PUT',
        headers: authorization,
        body: new Uint8Array([1]),
      }),
      env,
    )

    expect(invalidKind?.status).toBe(400)
    expect(invalidDate?.status).toBe(400)
    expect(invalidFilename?.status).toBe(400)
    expect(() => researchObjectKey('cninfo', '2026-08-28', '../secret.pdf')).toThrow(
      'Invalid research filename',
    )
  })

  it('rejects oversized summaries and reports before upload', async () => {
    const summary = await handleResearchPublishRequest(
      request('/api/research/internal/summaries/cninfo/2026-08-28', {
        method: 'PUT',
        headers: {
          ...authorization,
          'Content-Length': String(MAX_SUMMARY_BYTES + 1),
        },
        body: '{}',
      }),
      env,
    )
    const report = await handleResearchPublishRequest(
      request('/api/research/internal/files/cninfo/2026-08-28/report.pdf', {
        method: 'PUT',
        headers: {
          ...authorization,
          'Content-Length': String(MAX_REPORT_BYTES + 1),
        },
        body: new Uint8Array([1]),
      }),
      env,
    )

    expect(summary?.status).toBe(413)
    expect(report?.status).toBe(413)
  })

  it('upserts a normalized summary into D1', async () => {
    const response = await handleResearchPublishRequest(
      request('/api/research/internal/summaries/earnings/2026-08-28', {
        method: 'PUT',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'wrong-kind',
          date: '1900-01-01',
          generatedAt: '2026-08-28T02:00:00.000Z',
          totalCount: 12,
          files: [],
        }),
      }),
      env,
    )

    expect(response?.status).toBe(201)
    await expect(getSummary(env.RESEARCH_DB, 'earnings', '2026-08-28')).resolves.toMatchObject({
      kind: 'earnings',
      date: '2026-08-28',
      totalCount: 12,
    })
  })

  it('streams a report to R2 and downloads the same bytes publicly', async () => {
    const filename = '公告研判 2026-08-28.pdf'
    const encodedFilename = encodeURIComponent(filename)
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    const upload = await handleResearchPublishRequest(
      request(`/api/research/internal/files/cninfo/2026-08-28/${encodedFilename}`, {
        method: 'PUT',
        headers: {
          ...authorization,
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfBytes.byteLength),
        },
        body: pdfBytes,
      }),
      env,
    )

    expect(upload?.status).toBe(201)
    const key = researchObjectKey('cninfo', '2026-08-28', filename)
    const stored = await env.RESEARCH_REPORTS.get(key)
    expect(stored?.customMetadata).toEqual({ kind: 'cninfo', date: '2026-08-28', filename })
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(pdfBytes)

    const download = await handleResearchPublishRequest(
      request(`/api/research/files/cninfo/2026-08-28/${encodedFilename}`),
      env,
    )
    expect(download?.status).toBe(200)
    expect(download?.headers.get('Content-Type')).toBe('application/pdf')
    expect(download?.headers.get('Content-Disposition')).toContain(encodeURIComponent(filename))
    expect(new Uint8Array(await download!.arrayBuffer())).toEqual(pdfBytes)
  })

  it('returns controlled errors for malformed JSON and missing files', async () => {
    const malformed = await handleResearchPublishRequest(
      request('/api/research/internal/summaries/risk/2026-08-28', {
        method: 'PUT',
        headers: authorization,
        body: '{bad json',
      }),
      env,
    )
    const missing = await handleResearchPublishRequest(
      request('/api/research/files/risk/2026-08-28/missing.pdf'),
      env,
    )

    expect(malformed?.status).toBe(400)
    expect(missing?.status).toBe(404)
  })
})
