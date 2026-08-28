import {
  isDateKey,
  isResearchKind,
  type ResearchKind,
} from './research-contract'

export type ResearchFileType = 'pdf' | 'xlsx'

export function isResearchFilename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 4
    && value.length <= 180
    && value.trim() === value
    && !/[\\/\u0000-\u001f\u007f]/u.test(value)
    && !value.includes('..')
    && /\.(?:pdf|xlsx)$/iu.test(value)
}

export function researchFileType(filename: string): ResearchFileType {
  if (!isResearchFilename(filename)) {
    throw new RangeError('Invalid research filename')
  }
  return filename.toLocaleLowerCase().endsWith('.pdf') ? 'pdf' : 'xlsx'
}

export function researchContentType(filename: string): string {
  return researchFileType(filename) === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

export function researchObjectKey(
  kindValue: unknown,
  dateValue: unknown,
  filenameValue: unknown,
): string {
  if (!isResearchKind(kindValue)) {
    throw new RangeError('Invalid research kind')
  }
  if (!isDateKey(dateValue)) {
    throw new RangeError('Invalid research date')
  }
  if (!isResearchFilename(filenameValue)) {
    throw new RangeError('Invalid research filename')
  }

  const kind: ResearchKind = kindValue
  return `research/${kind}/${dateValue}/${filenameValue}`
}

export function attachmentDisposition(filename: string): string {
  if (!isResearchFilename(filename)) {
    throw new RangeError('Invalid research filename')
  }
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
}
