const AMOUNT_MULTIPLIERS = Object.freeze({
  base: 1,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  万: 10_000,
  亿: 100_000_000,
});

const INSTRUMENT_CATEGORIES = new Set(['equity', 'debt', 'convertible', 'credit_facility']);
const RATE_TYPES = new Set(['fixed', 'floating', 'unknown', 'not_applicable']);

function cleanText(value) {
  return String(value ?? '').trim() || null;
}

function requiredText(value, label) {
  const result = cleanText(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function nullableNumber(value, label, { allowNegative = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (!allowNegative && number < 0)) throw new Error(`${label} must be a finite number`);
  return number;
}

function dateOnly(value, label, { optional = false } = {}) {
  if (optional && !cleanText(value)) return null;
  const result = requiredText(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a valid date`);
  return result.slice(0, 10);
}

function amountMultiplier(unit) {
  const key = cleanText(unit) || 'base';
  const multiplier = AMOUNT_MULTIPLIERS[key];
  if (!multiplier) throw new Error(`unsupported amountUnit: ${key}`);
  return multiplier;
}

function capitalProvenance(record) {
  const sourceKind = cleanText(record.sourceKind) || 'official';
  if (!['official', 'filing'].includes(sourceKind)) throw new Error('capital sourceKind must be official or filing');
  const retrievedAt = requiredText(record.retrievedAt, 'retrievedAt');
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('retrievedAt must be a valid date-time');
  return {
    sourceLabel: requiredText(record.sourceLabel, 'sourceLabel'),
    sourceUrl: requiredText(record.sourceUrl, 'sourceUrl'),
    sourceKind,
    asOf: dateOnly(record.asOf || record.eventDate, 'asOf'),
    retrievedAt,
    methodology: cleanText(record.methodology) || '公司官网、投资者关系页面或监管申报披露的融资事件',
    commentary: cleanText(record.commentary || record.note),
    stale: Boolean(record.stale),
  };
}

export function normalizeCapitalEvent(record) {
  const entity = requiredText(record?.entity, 'entity');
  const eventDate = dateOnly(record?.eventDate, 'eventDate');
  const instrumentCategory = requiredText(record?.instrumentCategory, 'instrumentCategory');
  if (!INSTRUMENT_CATEGORIES.has(instrumentCategory)) throw new Error(`unsupported instrumentCategory: ${instrumentCategory}`);
  let rateType = cleanText(record.rateType) || 'unknown';
  if (instrumentCategory === 'equity') rateType = 'not_applicable';
  if (!RATE_TYPES.has(rateType)) throw new Error(`unsupported rateType: ${rateType}`);
  const amount = nullableNumber(record.amount, 'amount');
  if (amount === null) throw new Error('amount is required');
  const multiplier = amountMultiplier(record.amountUnit);
  const comparableUsdRaw = nullableNumber(record.comparableUsdAmount, 'comparableUsdAmount');
  let couponPercent = rateType === 'fixed' ? nullableNumber(record.couponPercent, 'couponPercent') : null;
  if (instrumentCategory === 'equity') couponPercent = null;
  const provenance = capitalProvenance(record);
  const amountOriginal = amount * multiplier;
  const comparableUsdAmount = comparableUsdRaw === null
    ? (String(record.currency).toUpperCase() === 'USD' ? amountOriginal : null)
    : comparableUsdRaw * amountMultiplier(record.comparableUsdAmountUnit || record.amountUnit);
  return {
    id: cleanText(record.id) || [entity, eventDate, instrumentCategory, amountOriginal, record.currency].join('|').toLowerCase(),
    entity,
    geography: requiredText(record.geography, 'geography'),
    eventDate,
    closeDate: dateOnly(record.closeDate, 'closeDate', { optional: true }),
    maturityDate: dateOnly(record.maturityDate, 'maturityDate', { optional: true }),
    instrumentCategory,
    instrument: requiredText(record.instrument, 'instrument'),
    amountOriginal,
    currency: requiredText(record.currency, 'currency').toUpperCase(),
    comparableUsdAmount,
    rateType,
    couponPercent,
    benchmark: rateType === 'floating' ? cleanText(record.benchmark) : null,
    spreadBps: rateType === 'floating' ? nullableNumber(record.spreadBps, 'spreadBps') : null,
    tenorYears: nullableNumber(record.tenorYears, 'tenorYears'),
    counterparties: Array.isArray(record.counterparties) ? record.counterparties.map(cleanText).filter(Boolean) : [],
    useOfProceeds: cleanText(record.useOfProceeds),
    sourceLabel: provenance.sourceLabel,
    sourceUrl: provenance.sourceUrl,
    sourceKind: provenance.sourceKind,
    asOf: provenance.asOf,
    retrievedAt: provenance.retrievedAt,
    note: cleanText(record.note),
    provenance,
  };
}

function daysBetween(left, right) {
  return Math.round((Date.parse(right) - Date.parse(left)) / 86_400_000);
}

function summarizeEvents(entity, events, now) {
  const sorted = [...events].sort((left, right) => left.eventDate.localeCompare(right.eventDate));
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const trailing = sorted.filter((event) => event.eventDate >= cutoffDate && event.eventDate <= now.toISOString().slice(0, 10));
  const comparable = sorted.filter((event) => Number.isFinite(event.comparableUsdAmount));
  const fixedCoupon = sorted.filter((event) => (
    ['debt', 'convertible', 'credit_facility'].includes(event.instrumentCategory)
    && event.rateType === 'fixed'
    && Number.isFinite(event.couponPercent)
    && Number.isFinite(event.comparableUsdAmount)
    && event.comparableUsdAmount > 0
  ));
  const fixedCouponWeight = fixedCoupon.reduce((total, event) => total + event.comparableUsdAmount, 0);
  const gaps = sorted.slice(1).map((event, index) => daysBetween(sorted[index].eventDate, event.eventDate));
  const averageDaysBetweenEvents = gaps.length === 0 ? null : Math.round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length);
  return {
    entity,
    eventCount: sorted.length,
    trailing12MonthCount: trailing.length,
    trailing12MonthComparableUsd: trailing.reduce((total, event) => total + (event.comparableUsdAmount || 0), 0),
    cumulativeComparableUsd: comparable.reduce((total, event) => total + event.comparableUsdAmount, 0),
    averageDaysBetweenEvents,
    annualizedEventFrequency: averageDaysBetweenEvents ? 365 / averageDaysBetweenEvents : null,
    fixedCouponEventCount: fixedCoupon.length,
    weightedAverageFixedCoupon: fixedCouponWeight === 0
      ? null
      : fixedCoupon.reduce((total, event) => total + event.couponPercent * event.comparableUsdAmount, 0) / fixedCouponWeight,
    latestEventDate: sorted.at(-1)?.eventDate || null,
  };
}

export function buildCapitalMetrics(events, { now = new Date() } = {}) {
  const validNow = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(validNow.getTime())) throw new Error('now must be a valid date');
  const grouped = new Map();
  for (const event of events || []) {
    if (!grouped.has(event.entity)) grouped.set(event.entity, []);
    grouped.get(event.entity).push(event);
  }
  return {
    industry: summarizeEvents('全行业', events || [], validNow),
    byEntity: [...grouped.entries()].map(([entity, entityEvents]) => summarizeEvents(entity, entityEvents, validNow))
      .sort((left, right) => right.trailing12MonthComparableUsd - left.trailing12MonthComparableUsd || left.entity.localeCompare(right.entity, 'zh-CN')),
  };
}
