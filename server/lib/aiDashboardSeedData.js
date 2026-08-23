import { buildCapitalMetrics, normalizeCapitalEvent } from './aiCapitalData.js';
import { attachValuationMultiples, buildArrMetrics } from './aiDashboardMetrics.js';
import { normalizeGrowthRecords } from './aiGrowthData.js';
import {
  CURRENT_GENERATION_RULES,
  derivePriceEvents,
  mergeTokenPriceHistory,
  normalizeCodingPlan,
  normalizeTokenPrice,
  normalizeVideoPrice,
  selectLatestGeneration,
} from './aiPricingData.js';

const ARR_METRICS = new Set(['arr', 'arr_estimate', 'run_rate_revenue']);
const FINANCING_METRICS = new Set(['equity_financing_amount', 'committed_capital']);
const PRICING_METRICS = new Set(['token_api_price', 'video_api_price', 'coding_plan_price']);

function amountUnit(unit) {
  const normalized = String(unit || '').toLowerCase();
  if (normalized.startsWith('usd billion')) return 'USD billion';
  if (normalized.startsWith('usd million')) return 'USD million';
  throw new Error(`unsupported seed amount unit: ${unit}`);
}

function sourceLabel(record) {
  return record.sourceKind === 'estimate' ? 'Yipit' : record.entity;
}

function arrRecord(record) {
  return {
    sourceId: record.sourceId,
    company: record.entity,
    observedAt: record.asOf,
    originalValue: record.value,
    originalUnit: amountUnit(record.unit),
    currency: 'USD',
    kind: 'actual',
    sourceLabel: sourceLabel(record),
    sourceUrl: record.sourceUrl,
    methodology: record.methodology,
    commentary: record.metric === 'arr_estimate'
      ? '第三方估算；不与公司披露的 ARR / run-rate revenue 合并。'
      : record.unit.toLowerCase().includes('lower bound')
        ? '公司披露为大于该阈值；图中保存披露下限。'
        : '公司官网披露。',
  };
}

function valuationRecord(record) {
  return {
    sourceId: record.sourceId,
    company: record.entity,
    asOf: record.asOf,
    valuationLow: record.value,
    valuationHigh: record.value,
    originalUnit: amountUnit(record.unit),
    currency: 'USD',
    sourceKind: record.sourceKind,
    sourceLabel: sourceLabel(record),
    sourceUrl: record.sourceUrl,
    methodology: record.methodology,
    arrSeriesKind: 'official',
    commentary: '融资公告披露的 post-money valuation；仅匹配估值日之前的官方 ARR。',
  };
}

function capitalEvent(record) {
  return normalizeCapitalEvent({
    id: record.id,
    entity: record.entity,
    geography: ['OpenAI', 'Anthropic'].includes(record.entity) ? 'US' : 'Other',
    eventDate: record.asOf,
    instrumentCategory: 'equity',
    instrument: record.metric === 'committed_capital' ? 'Committed equity financing round' : 'Equity financing round',
    amount: record.value,
    amountUnit: amountUnit(record.unit).endsWith('billion') ? 'billion' : 'million',
    currency: 'USD',
    comparableUsdAmount: record.value,
    comparableUsdAmountUnit: amountUnit(record.unit).endsWith('billion') ? 'billion' : 'million',
    rateType: 'not_applicable',
    sourceLabel: `${record.entity} 官网`,
    sourceUrl: record.sourceUrl,
    sourceKind: record.sourceKind,
    asOf: record.asOf,
    retrievedAt: record.retrievedAt,
    methodology: record.methodology,
    note: record.metric === 'committed_capital' ? '公司口径为 committed capital。' : null,
  });
}

function pricingSourceFields(record) {
  return {
    sourceLabel: record.dimensions?.sourceLabel || `${record.entity} 官网`,
    sourceUrl: record.sourceUrl,
    sourceKind: record.sourceKind,
    asOf: record.asOf,
    retrievedAt: record.retrievedAt,
    commentary: record.methodology,
    note: record.dimensions?.note || record.verification?.note || null,
  };
}

function pricingRow(record) {
  const dimensions = record.dimensions || {};
  const source = pricingSourceFields(record);
  if (record.metric === 'token_api_price') {
    if (record.verification?.status === 'unavailable') return null;
    return normalizeTokenPrice({ ...dimensions, ...source });
  }
  if (record.metric === 'video_api_price') return normalizeVideoPrice({ ...dimensions, ...source });
  if (record.metric === 'coding_plan_price') return normalizeCodingPlan({ ...dimensions, ...source });
  return null;
}

function latestRows(history, fields) {
  const rows = new Map();
  for (const row of history) {
    const key = fields.map((field) => row?.[field] ?? '').join('|').toLowerCase();
    const previous = rows.get(key);
    if (!previous || row.asOf >= previous.asOf) rows.set(key, row);
  }
  return [...rows.values()];
}

function buildPricingSeed(records) {
  const pricingRecords = records.filter((record) => PRICING_METRICS.has(record.metric));
  const normalized = pricingRecords.map((record) => ({ record, row: pricingRow(record) }));
  const tokenHistory = mergeTokenPriceHistory([], normalized
    .filter(({ record, row }) => record.metric === 'token_api_price' && row)
    .map(({ row }) => row));
  const videoHistory = normalized
    .filter(({ record, row }) => record.metric === 'video_api_price' && row)
    .map(({ row }) => row);
  const codingPlanHistory = normalized
    .filter(({ record, row }) => record.metric === 'coding_plan_price' && row)
    .map(({ row }) => row);
  const grouped = new Map();
  for (const { record, row } of normalized) {
    if (!grouped.has(record.sourceId)) grouped.set(record.sourceId, []);
    grouped.get(record.sourceId).push({ record, row });
  }
  const sourceReports = [...grouped.entries()].map(([sourceId, rows]) => {
    const unavailable = rows.every(({ record }) => record.verification?.status === 'unavailable');
    const note = rows.find(({ record }) => record.verification?.note)?.record.verification.note || null;
    return {
      sourceId,
      entity: rows[0].record.dimensions?.vendor || rows[0].record.entity,
      url: rows[0].record.sourceUrl,
      status: unavailable ? 'unavailable' : 'ready',
      asOf: rows.map(({ record }) => record.asOf).sort().at(-1),
      rows: rows.filter(({ row }) => row).length,
      message: note,
    };
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return {
    token: selectLatestGeneration(tokenHistory, CURRENT_GENERATION_RULES),
    tokenHistory,
    priceEvents: derivePriceEvents(tokenHistory),
    video: latestRows(videoHistory, ['vendor', 'model', 'mode', 'resolution', 'durationTier', 'currency', 'priceUnit']),
    videoHistory,
    codingPlans: latestRows(codingPlanHistory, ['vendor', 'plan', 'region', 'currency']),
    codingPlanHistory,
    sourceReports,
  };
}

export function buildAiDashboardSeedPayload(ledger, {
  generatedAt = new Date().toISOString(),
  now = new Date(),
} = {}) {
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const growthRecords = records.filter((record) => ARR_METRICS.has(record.metric) && Number.isFinite(record.value));
  const normalized = normalizeGrowthRecords({
    yipitRecords: growthRecords.filter((record) => record.sourceKind === 'estimate').map(arrRecord),
    officialRecords: growthRecords.filter((record) => record.sourceKind === 'official').map(arrRecord),
    valuationRecords: records.filter((record) => record.metric === 'post_money_valuation'
      && record.sourceKind === 'official' && Number.isFinite(record.value)).map(valuationRecord),
    retrievedAt: generatedAt,
  });
  const companies = buildArrMetrics(normalized.arrRecords, { now });
  const valuations = attachValuationMultiples(
    normalized.valuationRecords.sort((left, right) => left.asOf.localeCompare(right.asOf) || left.company.localeCompare(right.company)),
    companies,
  );
  const capitalEvents = records.filter((record) => FINANCING_METRICS.has(record.metric)
    && record.sourceKind === 'official' && Number.isFinite(record.value))
    .map(capitalEvent)
    .sort((left, right) => right.eventDate.localeCompare(left.eventDate));
  return {
    arrAndValuation: { companies, valuations },
    modelPricing: buildPricingSeed(records),
    capitalEvents,
    capitalMetrics: buildCapitalMetrics(capitalEvents, { now }),
    debtFinancing: [],
  };
}
