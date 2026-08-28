export const RESEARCH_KINDS = [
  'cninfo',
  'earnings',
  'earnings-report',
  'risk',
] as const

export type ResearchKind = (typeof RESEARCH_KINDS)[number]

export type ResearchSummary = Record<string, unknown> & {
  kind: ResearchKind
  date: string
}

export function isResearchKind(value: unknown): value is ResearchKind {
  return typeof value === 'string' && RESEARCH_KINDS.some((kind) => kind === value)
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}
