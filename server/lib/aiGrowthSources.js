import { attachValuationMultiples, buildArrMetrics } from './aiDashboardMetrics.js';
import {
  normalizeGrowthRecords,
  parseOfficialArrHistoryHtml,
  parseOfficialRunRateRevenueHtml,
  parseOfficialValuationHtml,
} from './aiGrowthData.js';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const SOURCE_ORDER = Object.freeze([
  'anthropic-series-g',
  'anthropic-run-rate',
  'openai-arr-history',
  'openai-valuation',
]);

const REGISTERED_GROWTH = new Map(
  PUBLIC_SOURCE_REGISTRY.filter((source) => source.slice === 'growth').map((source) => [source.id, source]),
);

export const AI_GROWTH_SOURCE_REGISTRY = Object.freeze(SOURCE_ORDER.map((id) => {
  const source = REGISTERED_GROWTH.get(id);
  if (!source || source.sourceKind !== 'official') throw new Error(`${id} is not a registered official growth source`);
  return source;
}));

const SOURCE_OPTIONS = Object.freeze({
  'anthropic-series-g': Object.freeze({ company: 'Anthropic', publishedAt: '2026-02-12', kinds: ['arr', 'valuation'] }),
  'anthropic-run-rate': Object.freeze({ company: 'Anthropic', publishedAt: '2026-05-28', kinds: ['arr', 'valuation'] }),
  'openai-arr-history': Object.freeze({ company: 'OpenAI', kinds: ['arr-history'] }),
  'openai-valuation': Object.freeze({ company: 'OpenAI', publishedAt: '2026-03-31', kinds: ['valuation'] }),
});

function validateDefinition(definition) {
  const registered = REGISTERED_GROWTH.get(definition?.id);
  if (!registered || !SOURCE_ORDER.includes(registered.id) || registered.entryUrl !== definition.entryUrl) {
    throw new Error(`${definition?.id || 'unknown'} is not a registered official growth source`);
  }
  return registered;
}

function parseSource(definition, document) {
  const options = SOURCE_OPTIONS[definition.id];
  const sourceUrl = new URL(document.finalUrl || definition.entryUrl).toString();
  const common = {
    company: options.company,
    sourceLabel: options.company,
    sourceUrl,
  };
  const officialRecords = [];
  const valuationRecords = [];
  if (options.kinds.includes('arr')) {
    officialRecords.push(parseOfficialRunRateRevenueHtml(document.text, {
      ...common,
      observedAt: options.publishedAt,
      commentary: '公司融资公告同步披露的 run-rate revenue；与第三方 ARR 估算分开展示。',
    }));
  }
  if (options.kinds.includes('arr-history')) {
    officialRecords.push(...parseOfficialArrHistoryHtml(document.text, common));
  }
  if (options.kinds.includes('valuation')) {
    valuationRecords.push(parseOfficialValuationHtml(document.text, {
      ...common,
      asOf: options.publishedAt,
      arrSeriesKind: 'official',
      commentary: '公司融资公告披露的 post-money valuation。',
    }));
  }
  return { officialRecords, valuationRecords };
}

function priorArrRecords(previous) {
  return (previous?.arrAndValuation?.companies || []).flatMap((series) => [
    ...(series.actualPoints || []),
    ...(series.forecastPoints || []),
  ]).filter((record) => record?.company && record?.observedAt && record?.sourceLabel);
}

function mergeArrRecords(previous, incoming) {
  const records = new Map();
  for (const record of [...priorArrRecords(previous), ...(incoming || [])]) {
    const seriesKind = record.seriesKind === 'official' ? 'official' : 'estimate';
    const key = [record.company, seriesKind, record.sourceLabel, record.observedAt, record.kind || 'actual'].join('|');
    records.set(key, { ...record, seriesKind });
  }
  return [...records.values()];
}

function mergeValuationRecords(previous, incoming) {
  const records = new Map();
  for (const record of [...(previous?.arrAndValuation?.valuations || []), ...(incoming || [])]) {
    if (!record?.company || !record?.asOf || !record?.sourceLabel) continue;
    records.set([record.company, record.asOf, record.sourceLabel].join('|'), record);
  }
  return [...records.values()].sort((left, right) => left.asOf.localeCompare(right.asOf) || left.company.localeCompare(right.company));
}

export function createAiGrowthCollector({ documentClient, registry = AI_GROWTH_SOURCE_REGISTRY } = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') {
    throw new Error('growth collector requires an official document client');
  }
  const sources = registry.map(validateDefinition);
  if (sources.length === 0) throw new Error('growth collector requires official sources');

  return async function collectGrowth({ previous = {}, now = new Date(), generatedAt = new Date().toISOString() } = {}) {
    const results = await Promise.all(sources.map(async (definition) => {
      try {
        const document = await documentClient.fetchDocument(definition);
        return { definition, ...parseSource(definition, document), status: 'ready' };
      } catch (error) {
        return { definition, officialRecords: [], valuationRecords: [], status: 'error', error };
      }
    }));
    const succeeded = results.filter((result) => result.status === 'ready');
    if (succeeded.length === 0) throw new Error(`all ${sources.length} official growth sources failed`);

    const normalized = normalizeGrowthRecords({
      officialRecords: succeeded.flatMap((result) => result.officialRecords),
      valuationRecords: succeeded.flatMap((result) => result.valuationRecords),
      retrievedAt: generatedAt,
    });
    const arrRecords = mergeArrRecords(previous, normalized.arrRecords);
    const companies = buildArrMetrics(arrRecords, { now });
    const valuations = attachValuationMultiples(
      mergeValuationRecords(previous, normalized.valuationRecords),
      companies,
    );
    const failed = results.length - succeeded.length;
    return {
      payload: { arrAndValuation: { companies, valuations } },
      source: {
        status: 'ready',
        stale: failed > 0,
        asOf: generatedAt.slice(0, 10),
        url: succeeded[0].definition.entryUrl,
        message: `${succeeded.length}/${results.length} 个公司官网增长源同步成功${failed ? `；${failed} 个保留上一版` : ''}；Yipit 始终作为独立估算序列`,
      },
    };
  };
}
