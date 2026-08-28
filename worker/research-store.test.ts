import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import { isDateKey, isResearchKind, RESEARCH_KINDS } from './research-contract'
import {
  getLatestSummary,
  getSummary,
  listSummaryDates,
  putSummary,
} from './research-store'

const makeSummary = (generatedAt: string, totalCount: number) => ({
  kind: 'wrong-kind',
  date: '1900-01-01',
  generatedAt,
  totalCount,
  files: [],
  topGood: [],
  topBad: [],
})

beforeEach(async () => {
  await applyD1Migrations(env.RESEARCH_DB, env.TEST_MIGRATIONS)
  await env.RESEARCH_DB.prepare('DELETE FROM research_summaries').run()
})

describe('research contract validation', () => {
  it('accepts only the four supported research kinds', () => {
    expect(RESEARCH_KINDS).toEqual(['cninfo', 'earnings', 'earnings-report', 'risk'])
    expect(isResearchKind('risk')).toBe(true)
    expect(isResearchKind('news')).toBe(false)
  })

  it('accepts real YYYY-MM-DD calendar dates only', () => {
    expect(isDateKey('2026-08-28')).toBe(true)
    expect(isDateKey('2026-02-29')).toBe(false)
    expect(isDateKey('2026-8-28')).toBe(false)
  })
})

describe('research summary store', () => {
  it('upserts summaries, forces path identity, and returns newest dates first', async () => {
    await putSummary(env.RESEARCH_DB, {
      kind: 'cninfo',
      date: '2026-08-27',
      summary: makeSummary('2026-08-27T01:00:00.000Z', 4),
    })
    await putSummary(env.RESEARCH_DB, {
      kind: 'cninfo',
      date: '2026-08-28',
      summary: makeSummary('2026-08-28T01:00:00.000Z', 7),
    })

    await expect(getLatestSummary(env.RESEARCH_DB, 'cninfo')).resolves.toMatchObject({
      kind: 'cninfo',
      date: '2026-08-28',
      totalCount: 7,
    })
    await expect(getSummary(env.RESEARCH_DB, 'cninfo', '2026-08-27')).resolves.toMatchObject({
      kind: 'cninfo',
      date: '2026-08-27',
    })
    await expect(listSummaryDates(env.RESEARCH_DB, 'cninfo')).resolves.toEqual([
      '2026-08-28',
      '2026-08-27',
    ])
  })

  it('updates an existing kind and date instead of creating a duplicate', async () => {
    await putSummary(env.RESEARCH_DB, {
      kind: 'risk',
      date: '2026-08-28',
      summary: makeSummary('2026-08-28T01:00:00.000Z', 2),
    })
    await putSummary(env.RESEARCH_DB, {
      kind: 'risk',
      date: '2026-08-28',
      summary: makeSummary('2026-08-28T02:00:00.000Z', 9),
    })

    await expect(getLatestSummary(env.RESEARCH_DB, 'risk')).resolves.toMatchObject({
      totalCount: 9,
      generatedAt: '2026-08-28T02:00:00.000Z',
    })
    await expect(listSummaryDates(env.RESEARCH_DB, 'risk')).resolves.toEqual(['2026-08-28'])
  })

  it('returns null when no summary exists', async () => {
    await expect(getLatestSummary(env.RESEARCH_DB, 'earnings')).resolves.toBeNull()
    await expect(getSummary(env.RESEARCH_DB, 'earnings', '2026-08-28')).resolves.toBeNull()
  })

  it('reports corrupted stored JSON without leaking its contents', async () => {
    await env.RESEARCH_DB.prepare(
      `INSERT INTO research_summaries
        (kind, date, generated_at, total_count, summary_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind('cninfo', '2026-08-28', '2026-08-28T01:00:00.000Z', 1, '{secret broken json')
      .run()

    await expect(getSummary(env.RESEARCH_DB, 'cninfo', '2026-08-28')).rejects.toThrow(
      'Stored research summary is invalid JSON',
    )
    await expect(getSummary(env.RESEARCH_DB, 'cninfo', '2026-08-28')).rejects.not.toThrow(
      'secret broken json',
    )
  })

  it('rejects invalid kinds, dates, and summary bodies before writing', async () => {
    await expect(
      putSummary(env.RESEARCH_DB, {
        kind: 'news',
        date: '2026-08-28',
        summary: makeSummary('2026-08-28T01:00:00.000Z', 1),
      }),
    ).rejects.toThrow('Invalid research kind')
    await expect(
      putSummary(env.RESEARCH_DB, {
        kind: 'cninfo',
        date: '2026-02-30',
        summary: makeSummary('2026-08-28T01:00:00.000Z', 1),
      }),
    ).rejects.toThrow('Invalid research date')
    await expect(
      putSummary(env.RESEARCH_DB, {
        kind: 'cninfo',
        date: '2026-08-28',
        summary: null,
      }),
    ).rejects.toThrow('Research summary must be an object')

    const row = await env.RESEARCH_DB.prepare(
      'SELECT COUNT(*) AS count FROM research_summaries',
    ).first<{ count: number }>()
    expect(row?.count).toBe(0)
  })
})
