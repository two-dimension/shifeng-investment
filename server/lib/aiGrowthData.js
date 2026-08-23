const DISPLAY_UNIT_SCALE = 100_000_000;

function cleanText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function requiredText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function finitePositive(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error(`${label} must be positive`);
  return normalized;
}

function normalizeDate(value, label) {
  const normalized = String(value || '').slice(0, 10);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function amountInDisplayUnits(record) {
  const currency = requiredText(record.currency || 'USD', 'currency').toUpperCase();
  if (currency !== 'USD') throw new Error(`unsupported currency: ${currency}`);
  const originalValue = finitePositive(record.originalValue, 'originalValue');
  const originalUnit = requiredText(record.originalUnit, 'originalUnit');
  const normalizedUnit = originalUnit.toLowerCase();
  let dollars;
  if (normalizedUnit === 'usd billion') dollars = originalValue * 1_000_000_000;
  else if (normalizedUnit === 'usd million') dollars = originalValue * 1_000_000;
  else if (normalizedUnit === 'usd 100 million') dollars = originalValue * DISPLAY_UNIT_SCALE;
  else throw new Error(`unsupported amount unit: ${originalUnit}`);
  const annualizeFactor = record.annualizeFactor === undefined ? 1 : finitePositive(record.annualizeFactor, 'annualizeFactor');
  return {
    currency,
    originalValue,
    originalUnit,
    unitScale: DISPLAY_UNIT_SCALE,
    value: dollars * annualizeFactor / DISPLAY_UNIT_SCALE,
  };
}

function provenance(record, { sourceKind, asOf, retrievedAt }) {
  const sourceUrl = requiredText(record.sourceUrl, 'sourceUrl');
  if (new URL(sourceUrl).protocol !== 'https:') throw new Error('sourceUrl must use HTTPS');
  return {
    sourceLabel: requiredText(record.sourceLabel, 'sourceLabel'),
    sourceUrl,
    sourceKind,
    asOf,
    retrievedAt,
    methodology: requiredText(record.methodology, 'methodology'),
    ...(record.commentary ? { commentary: String(record.commentary) } : {}),
    stale: false,
  };
}

function normalizeArrRecord(record, { sourceKind, seriesKind, retrievedAt }) {
  const observedAt = normalizeDate(record.observedAt, 'observedAt');
  const amount = amountInDisplayUnits(record);
  const metricProvenance = provenance(record, { sourceKind, asOf: observedAt, retrievedAt });
  return {
    ...record,
    company: requiredText(record.company, 'company'),
    observedAt,
    kind: record.kind === 'forecast' ? 'forecast' : 'actual',
    seriesKind,
    sourceKind,
    ...amount,
    sourceLabel: metricProvenance.sourceLabel,
    sourceUrl: metricProvenance.sourceUrl,
    methodology: metricProvenance.methodology,
    provenance: metricProvenance,
  };
}

function normalizeValuationRecord(record, retrievedAt) {
  const asOf = normalizeDate(record.asOf, 'valuation asOf');
  const low = amountInDisplayUnits({
    ...record,
    originalValue: record.valuationLow,
  });
  const high = amountInDisplayUnits({
    ...record,
    originalValue: record.valuationHigh ?? record.valuationLow,
  });
  const sourceKind = record.sourceKind || 'official';
  const metricProvenance = provenance(record, { sourceKind, asOf, retrievedAt });
  return {
    ...record,
    company: requiredText(record.company, 'company'),
    asOf,
    valuationLow: low.value,
    valuationHigh: high.value,
    currency: low.currency,
    unitScale: DISPLAY_UNIT_SCALE,
    sourceLabel: metricProvenance.sourceLabel,
    provenance: metricProvenance,
  };
}

export function parseOfficialRunRateRevenueHtml(html, options) {
  const text = cleanText(html);
  const match = text.match(/run[- ]rate revenue[^$.]{0,120}?(?:crossed|reached|is|of|to)\s+(?:over\s+|approximately\s+)?\$([\d.]+)\s*(billion|million)/i);
  if (!match) throw new Error('official run-rate revenue disclosure not found');
  return {
    company: requiredText(options?.company, 'company'),
    observedAt: normalizeDate(options?.observedAt, 'observedAt'),
    originalValue: Number(match[1]),
    originalUnit: `USD ${match[2].toLowerCase()}`,
    currency: 'USD',
    kind: 'actual',
    sourceLabel: requiredText(options?.sourceLabel, 'sourceLabel'),
    sourceUrl: requiredText(options?.sourceUrl, 'sourceUrl'),
    methodology: 'Company-disclosed run-rate revenue',
    ...(options?.commentary ? { commentary: options.commentary } : {}),
  };
}

export function parseOfficialArrHistoryHtml(html, options) {
  const text = cleanText(html);
  const records = [];
  const pattern = /\$([\d.]+)\s*B\+?(?:\s+ARR)?\s+in\s+(20\d{2})/gi;
  for (const match of text.matchAll(pattern)) {
    records.push({
      company: requiredText(options?.company, 'company'),
      observedAt: `${match[2]}-12-31`,
      originalValue: Number(match[1]),
      originalUnit: 'USD billion',
      currency: 'USD',
      kind: 'actual',
      sourceLabel: requiredText(options?.sourceLabel, 'sourceLabel'),
      sourceUrl: requiredText(options?.sourceUrl, 'sourceUrl'),
      methodology: 'Company-disclosed annual recurring revenue',
      commentary: match[0].includes('+') ? 'Company disclosed this value as greater than the stated threshold.' : undefined,
    });
  }
  if (records.length === 0) throw new Error('official ARR history disclosure not found');
  return records;
}

export function normalizeGrowthRecords({
  yipitRecords = [],
  officialRecords = [],
  valuationRecords = [],
  retrievedAt = new Date().toISOString(),
} = {}) {
  const retrieved = new Date(retrievedAt);
  if (!Number.isFinite(retrieved.getTime())) throw new Error('retrievedAt is invalid');
  const normalizedRetrievedAt = retrieved.toISOString();
  return {
    arrRecords: [
      ...yipitRecords.map((record) => normalizeArrRecord(record, {
        sourceKind: 'estimate', seriesKind: 'estimate', retrievedAt: normalizedRetrievedAt,
      })),
      ...officialRecords.map((record) => normalizeArrRecord(record, {
        sourceKind: 'official', seriesKind: 'official', retrievedAt: normalizedRetrievedAt,
      })),
    ],
    valuationRecords: valuationRecords.map((record) => normalizeValuationRecord(record, normalizedRetrievedAt)),
  };
}
