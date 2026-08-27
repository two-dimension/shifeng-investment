function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChange(value) {
  const number = finiteNumber(value);
  return number === null ? null : number;
}

const QUALITY_STATUSES = new Set([
  'validated',
  'model-derived',
  'needs-review',
  'stale',
  'unavailable',
]);

function normalizeQualityStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  const status = String(value).trim();
  return QUALITY_STATUSES.has(status) ? status : undefined;
}

function optionalFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  return finiteNumber(value);
}

export function normalizeCdsDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new Error('CDS dataset must be an object');
  }
  if (!validDate(dataset.asOf)) throw new Error('CDS dataset asOf must be YYYY-MM-DD');

  const sourceKind = typeof dataset.sourceKind === 'string' ? dataset.sourceKind.trim() : '';
  const isIceDerived = sourceKind === 'ice_eod_isda';
  const datasetQualityStatus = normalizeQualityStatus(dataset.qualityStatus);

  const companies = (Array.isArray(dataset.companies) ? dataset.companies : []).flatMap((row) => {
    const company = String(row?.company || '').trim();
    const latestBp = finiteNumber(row?.latestBp);
    const latestEodPrice = optionalFiniteNumber(row?.latestEodPrice);
    const qualityStatus = normalizeQualityStatus(row?.qualityStatus);
    const latestInstrumentName = typeof row?.latestInstrumentName === 'string'
      ? row.latestInstrumentName.trim()
      : '';
    if (!company || latestBp === null || latestBp < 0) return [];
    if (row?.latestEodPrice !== undefined && latestEodPrice === null) return [];
    if (qualityStatus === undefined) return [];
    if (isIceDerived && (latestEodPrice === null || !latestInstrumentName || !qualityStatus)) return [];

    const historyByDate = new Map();
    for (const point of Array.isArray(row?.history) ? row.history : []) {
      const valueBp = finiteNumber(point?.valueBp);
      const eodPrice = optionalFiniteNumber(point?.eodPrice);
      const pointQualityStatus = normalizeQualityStatus(point?.qualityStatus);
      const pointSourceKind = typeof point?.sourceKind === 'string' ? point.sourceKind.trim() : '';
      const isScreenshotBackfill = pointSourceKind === 'screenshot_backfill';
      const instrumentName = typeof point?.instrumentName === 'string' ? point.instrumentName.trim() : '';
      if (!validDate(point?.date) || point.date > dataset.asOf || valueBp === null || valueBp < 0) continue;
      if (point?.eodPrice !== undefined && eodPrice === null) continue;
      if (pointQualityStatus === undefined) continue;
      if (isIceDerived && !isScreenshotBackfill && (eodPrice === null || !instrumentName || !pointQualityStatus)) continue;
      historyByDate.set(point.date, {
        date: point.date,
        valueBp,
        ...(eodPrice === null ? {} : { eodPrice }),
        ...(instrumentName ? { instrumentName } : {}),
        ...(pointQualityStatus ? { qualityStatus: pointQualityStatus } : {}),
        ...(isScreenshotBackfill ? { sourceKind: pointSourceKind } : {}),
      });
    }

    return [{
      company,
      latestBp,
      ...(latestEodPrice === null ? {} : { latestEodPrice }),
      ...(latestInstrumentName ? { latestInstrumentName } : {}),
      ...(qualityStatus ? { qualityStatus } : {}),
      changes: {
        oneDayBp: normalizeChange(row?.changes?.oneDayBp),
        sevenDayBp: normalizeChange(row?.changes?.sevenDayBp),
        oneMonthBp: normalizeChange(row?.changes?.oneMonthBp),
      },
      history: [...historyByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    }];
  });

  return {
    asOf: dataset.asOf,
    ...(sourceKind ? { sourceKind } : {}),
    sourceLabel: String(dataset.sourceLabel || '平台数据').trim() || '平台数据',
    sourceUrl: typeof dataset.sourceUrl === 'string' && dataset.sourceUrl.trim() ? dataset.sourceUrl.trim() : null,
    batchId: typeof dataset.batchId === 'string' && dataset.batchId.trim() ? dataset.batchId.trim() : null,
    qualityStatus: datasetQualityStatus || (datasetQualityStatus === undefined ? 'needs-review' : null),
    workbookAvailable: dataset.workbookAvailable === true,
    historyEstimated: dataset.historyEstimated === true,
    note: typeof dataset.note === 'string' ? dataset.note.trim() : '',
    companies,
  };
}
