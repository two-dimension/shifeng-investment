import {
  isDateKey,
  isResearchKind,
  type ResearchKind,
  type ResearchSummary,
} from './research-contract'

export interface PutSummaryInput {
  kind: unknown
  date: unknown
  summary: unknown
}

export class ResearchStoreError extends Error {
  readonly code: 'CORRUPT_SUMMARY'

  constructor() {
    super('Stored research summary is invalid JSON')
    this.name = 'ResearchStoreError'
    this.code = 'CORRUPT_SUMMARY'
  }
}

function requireKind(value: unknown): ResearchKind {
  if (!isResearchKind(value)) {
    throw new RangeError('Invalid research kind')
  }
  return value
}

function requireDate(value: unknown): string {
  if (!isDateKey(value)) {
    throw new RangeError('Invalid research date')
  }
  return value
}

function requireSummary(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Research summary must be an object')
  }
  return value as Record<string, unknown>
}

function parseStoredSummary(value: string): ResearchSummary {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || !isResearchKind(Reflect.get(parsed, 'kind'))
      || !isDateKey(Reflect.get(parsed, 'date'))
    ) {
      throw new ResearchStoreError()
    }
    return parsed as ResearchSummary
  } catch (error) {
    if (error instanceof ResearchStoreError) {
      throw error
    }
    throw new ResearchStoreError()
  }
}

function numericTotalCount(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return 0
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0
}

export async function getLatestSummary(
  db: D1Database,
  kindValue: unknown,
): Promise<ResearchSummary | null> {
  const kind = requireKind(kindValue)
  const row = await db
    .prepare(
      `SELECT summary_json
       FROM research_summaries
       WHERE kind = ?
       ORDER BY date DESC
       LIMIT 1`,
    )
    .bind(kind)
    .first<{ summary_json: string }>()

  return row ? parseStoredSummary(row.summary_json) : null
}

export async function getSummary(
  db: D1Database,
  kindValue: unknown,
  dateValue: unknown,
): Promise<ResearchSummary | null> {
  const kind = requireKind(kindValue)
  const date = requireDate(dateValue)
  const row = await db
    .prepare(
      `SELECT summary_json
       FROM research_summaries
       WHERE kind = ? AND date = ?`,
    )
    .bind(kind, date)
    .first<{ summary_json: string }>()

  return row ? parseStoredSummary(row.summary_json) : null
}

export async function listSummaryDates(
  db: D1Database,
  kindValue: unknown,
): Promise<string[]> {
  const kind = requireKind(kindValue)
  const result = await db
    .prepare(
      `SELECT date
       FROM research_summaries
       WHERE kind = ?
       ORDER BY date DESC`,
    )
    .bind(kind)
    .all<{ date: string }>()

  return result.results.map(({ date }) => date)
}

export async function putSummary(
  db: D1Database,
  input: PutSummaryInput,
): Promise<ResearchSummary> {
  const kind = requireKind(input.kind)
  const date = requireDate(input.date)
  const summary = requireSummary(input.summary)
  const storedSummary: ResearchSummary = { ...summary, kind, date }
  const generatedAt = typeof storedSummary.generatedAt === 'string' && storedSummary.generatedAt
    ? storedSummary.generatedAt
    : new Date().toISOString()
  const totalCount = numericTotalCount(storedSummary.totalCount)

  await db
    .prepare(
      `INSERT INTO research_summaries
        (kind, date, generated_at, total_count, summary_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, date) DO UPDATE SET
         generated_at = excluded.generated_at,
         total_count = excluded.total_count,
         summary_json = excluded.summary_json`,
    )
    .bind(kind, date, generatedAt, totalCount, JSON.stringify(storedSummary))
    .run()

  return storedSummary
}
