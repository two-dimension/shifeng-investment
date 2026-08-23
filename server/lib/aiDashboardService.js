import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCdsDataset } from './aiCdsData.js';
import { AI_CAPITAL_SOURCE_REGISTRY, createAiCapitalCollector } from './aiCapitalSources.js';
import { AI_COMPUTE_SOURCE_REGISTRY, createAiComputeCollector } from './aiComputeSources.js';
import { AI_GROWTH_SOURCE_REGISTRY, createAiGrowthCollector } from './aiGrowthSources.js';
import { aggregateOpenRouterWeekly } from './aiDashboardMetrics.js';
import { createAiPricingCollector } from './aiPricingSources.js';
import { createArtificialAnalysisCollector } from './artificialAnalysisSource.js';
import { normalizeOfficialBenchmarks } from './officialBenchmarkData.js';
import { createOfficialDocumentClient } from './officialDocumentClient.js';
import { createOfficialModelCardRegistry } from './officialModelCardRegistry.js';
import { DASHBOARD_SOURCE_KEYS, PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPENROUTER_SOURCE_URL = 'https://openrouter.ai/rankings';
const OPENROUTER_DATA_API_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily';
const DAY_MS = 24 * 60 * 60 * 1000;
const BENCHMARK_FRESH_MS = 15 * 60 * 1000;
const SOURCE_KEY_SET = new Set(DASHBOARD_SOURCE_KEYS);

const SLICE_PAYLOAD_FIELDS = Object.freeze({
  growth: Object.freeze(['arrAndValuation']),
  pricing: Object.freeze(['modelPricing']),
  capital: Object.freeze(['capitalEvents', 'capitalMetrics', 'capitalSourceReports', 'debtFinancing']),
  benchmarks: Object.freeze(['benchmarks']),
  artificialAnalysis: Object.freeze(['artificialAnalysis']),
  compute: Object.freeze(['computeRental', 'computeSourceReports']),
});

export const DEFAULT_AI_DASHBOARD_FILE = path.join(__dirname, '../data/ai-dashboard/snapshot.json');
export const DEFAULT_OPENROUTER_PUBLIC_FILE = path.join(__dirname, '../data/ai-dashboard/openrouter-public.json');
export const DEFAULT_CDS_FILE = path.join(__dirname, '../data/ai-dashboard/cds-5y.json');

function isoNow(now) {
  return now().toISOString();
}

function utcDateOffset(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

function unavailable(message = '尚未完成首次公开数据同步') {
  return {
    status: 'error',
    stale: true,
    asOf: null,
    syncedAt: null,
    message,
  };
}

export function createEmptyAiDashboardSnapshot(generatedAt = new Date().toISOString()) {
  return {
    schemaVersion: 2,
    generatedAt,
    sources: {
      growth: unavailable(),
      openRouter: {
        status: 'authorization_required',
        stale: true,
        asOf: null,
        syncedAt: null,
        url: OPENROUTER_SOURCE_URL,
        message: '需配置 OPENROUTER_API_KEY',
      },
      pricing: unavailable(),
      capital: unavailable(),
      benchmarks: unavailable('尚未完成首次厂商官网模型卡同步'),
      artificialAnalysis: unavailable(),
      compute: unavailable(),
    },
    arrAndValuation: { companies: [], valuations: [] },
    openRouter: {
      startDate: null,
      endDate: null,
      weekTotalTokens: null,
      priorWeekTotalTokens: null,
      weekOverWeekAbsolute: null,
      weekOverWeekPercent: null,
      topModels: [],
      history: [],
      attribution: 'Source: OpenRouter (openrouter.ai/rankings). Licensed under CC BY 4.0.',
    },
    modelPricing: {
      token: [],
      tokenHistory: [],
      priceEvents: [],
      video: [],
      videoHistory: [],
      codingPlans: [],
      codingPlanHistory: [],
      sourceReports: [],
    },
    benchmarks: {
      models: [],
      metrics: [],
      winners: {},
      vendorSources: [],
      asOf: null,
      sourceMode: 'none',
      coverage: { vendors: 0, disclosedVendors: 0, metrics: 0, comparableMetrics: 0 },
      attributions: [],
    },
    artificialAnalysis: {
      intelligenceIndex: [],
      taskCosts: [],
      indexVersion: null,
    },
    computeRental: [],
    computeSourceReports: [],
    capitalEvents: [],
    capitalMetrics: {
      industry: null,
      byEntity: [],
    },
    capitalSourceReports: [],
    debtFinancing: [],
    creditRisk: {
      cds5y: {
        asOf: null,
        sourceLabel: '平台数据',
        sourceUrl: null,
        historyEstimated: false,
        note: '',
        companies: [],
      },
    },
  };
}

function migrateSources(parsedSources, emptySources) {
  return Object.fromEntries(DASHBOARD_SOURCE_KEYS.map((key) => [
    key,
    { ...emptySources[key], ...(parsedSources?.[key] || {}) },
  ]));
}

function migrateBenchmarks(parsedBenchmarks, emptyBenchmarks) {
  if (!parsedBenchmarks || typeof parsedBenchmarks !== 'object') return emptyBenchmarks;
  if (!['none', 'official-model-cards'].includes(parsedBenchmarks.sourceMode)) return emptyBenchmarks;
  return {
    ...emptyBenchmarks,
    models: parsedBenchmarks.models || emptyBenchmarks.models,
    metrics: parsedBenchmarks.metrics || emptyBenchmarks.metrics,
    winners: parsedBenchmarks.winners || emptyBenchmarks.winners,
    vendorSources: parsedBenchmarks.vendorSources || emptyBenchmarks.vendorSources,
    asOf: parsedBenchmarks.asOf || null,
    sourceMode: parsedBenchmarks.sourceMode,
    coverage: parsedBenchmarks.coverage || emptyBenchmarks.coverage,
    attributions: parsedBenchmarks.attributions || emptyBenchmarks.attributions,
  };
}

function priorOfficialVendorCards(benchmarks) {
  if (benchmarks?.sourceMode !== 'official-model-cards') return new Map();
  const metrics = new Map((benchmarks.metrics || []).map((metric) => [metric.key, metric]));
  const sources = new Map((benchmarks.vendorSources || []).map((source) => [source.vendor, source]));
  return new Map((benchmarks.models || []).map((model) => {
    const source = sources.get(model.vendor) || {};
    const scores = Object.entries(model.scores || {}).flatMap(([key, score]) => {
      const metric = metrics.get(key);
      if (!metric || !Number.isFinite(score?.value)) return [];
      return [{
        testName: metric.testName || metric.testFamily || metric.label,
        testVersion: metric.testVersion || null,
        split: metric.split || null,
        scoreName: metric.scoreName || score.metric || 'Score',
        value: score.value,
        unit: metric.unit || score.unit || 'number',
        direction: metric.direction || score.direction || 'higher',
        agent: metric.agent || null,
        harness: metric.harness || null,
        effort: metric.effort || null,
        shots: metric.shots ?? null,
        passK: metric.passK ?? null,
        tools: metric.tools || null,
        configurationComplete: metric.comparable === true,
        comparisonNote: metric.comparisonNote || score.comparisonNote || null,
        sourceUrl: score.sourceUrl || metric.sourceUrl || source.sourceUrl || null,
        publishedAt: score.publishedAt || model.releasedAt || null,
        retrievedAt: score.retrievedAt || source.retrievedAt || null,
        sourceOrder: metric.sourceOrder ?? 0,
      }];
    });
    return [model.vendor, {
      vendor: model.vendor,
      model: model.model,
      releasedAt: model.releasedAt || source.releasedAt || null,
      status: model.status || source.status || 'ready',
      stale: Boolean(model.stale || source.stale),
      sourceUrl: model.sourceUrl || source.sourceUrl || null,
      sourceLabel: model.sourceLabel || `${model.vendor} 官网模型卡`,
      discoveryMode: model.discoveryMode || source.discoveryMode || null,
      retrievedAt: source.retrievedAt || null,
      scores,
    }];
  }));
}

export function createOfficialBenchmarkCollector({ officialBenchmarkClient } = {}) {
  if (!officialBenchmarkClient || typeof officialBenchmarkClient.readAll !== 'function') {
    throw new Error('officialBenchmarkClient.readAll is required');
  }
  return async ({ previous, generatedAt }) => {
    const incoming = await officialBenchmarkClient.readAll();
    if (!Array.isArray(incoming) || incoming.length === 0) throw new Error('官网模型卡读取未返回厂商记录');
    const prior = priorOfficialVendorCards(previous.benchmarks);
    const cards = incoming.map((card) => {
      if (card.status === 'ready') return card;
      const lastGood = prior.get(card.vendor);
      if (!lastGood || lastGood.scores.length === 0) return card;
      return {
        ...lastGood,
        status: card.status || 'error',
        stale: true,
        discoveryMode: card.discoveryMode || lastGood.discoveryMode,
        retrievedAt: card.retrievedAt || generatedAt,
        error: card.error || '本次官网读取失败，保留该厂商上次官网模型卡结果',
      };
    });
    const benchmarks = normalizeOfficialBenchmarks({ vendorCards: cards, asOf: generatedAt });
    const successful = cards.filter((card) => card.status === 'ready').length;
    const disclosed = benchmarks.coverage.disclosedVendors;
    const stale = cards.some((card) => card.stale || card.status !== 'ready' || card.discoveryMode === 'manual-registry');
    return {
      payload: { benchmarks },
      source: {
        status: successful > 0 ? 'ready' : 'error',
        stale,
        asOf: generatedAt.slice(0, 10),
        url: benchmarks.attributions[0]?.url || null,
        message: `官网模型卡同步：${successful}/${cards.length} 家成功 · ${disclosed} 家披露评分`,
      },
    };
  };
}

async function readSnapshotFile(dataFile, now) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
    const empty = createEmptyAiDashboardSnapshot(isoNow(now));
    return {
      ...empty,
      ...parsed,
      schemaVersion: 2,
      sources: migrateSources(parsed.sources, empty.sources),
      modelPricing: {
        ...empty.modelPricing,
        ...(parsed.modelPricing || {}),
      },
      benchmarks: migrateBenchmarks(parsed.benchmarks, empty.benchmarks),
      artificialAnalysis: {
        ...empty.artificialAnalysis,
        ...(parsed.artificialAnalysis || {}),
      },
      creditRisk: {
        ...empty.creditRisk,
        ...(parsed.creditRisk || {}),
        cds5y: { ...empty.creditRisk.cds5y, ...(parsed.creditRisk?.cds5y || {}) },
      },
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[ai-dashboard] snapshot read failed: ${error.message}`);
    return createEmptyAiDashboardSnapshot(isoNow(now));
  }
}

async function readCdsFile(cdsFile) {
  if (!cdsFile) return null;
  try {
    const dataset = JSON.parse(await fs.promises.readFile(cdsFile, 'utf8'));
    return normalizeCdsDataset(dataset);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[ai-dashboard] CDS data read failed: ${error.message}`);
    return null;
  }
}

async function writeSnapshotFile(dataFile, snapshot) {
  await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempFile, dataFile);
}

function openRouterCoverageError(payload, expectedEndDate) {
  if (payload.meta?.end_date !== expectedEndDate) {
    return `OpenRouter 返回的结束日 ${payload.meta?.end_date || '缺失'} 与请求日 ${expectedEndDate} 不一致`;
  }
  const dates = new Set((payload.data || [])
    .filter((row) => row.model_permaslug && /^\d+$/.test(String(row.total_tokens || '')))
    .map((row) => row.date));
  const missingDates = Array.from({ length: 14 }, (_, offset) => utcDateOffset(new Date(`${expectedEndDate}T00:00:00.000Z`), -offset))
    .filter((date) => !dates.has(date));
  return missingDates.length > 0 ? `OpenRouter 缺少完整 UTC 日：${missingDates.join('、')}` : null;
}

export function createOpenRouterClient({ apiKey, fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!apiKey) throw new Error('OpenRouter API key is required');
  return {
    async fetchRankings({ startDate, endDate }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      try {
        const response = await fetchImpl(`${OPENROUTER_DATA_API_URL}?${params}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`OpenRouter Data API failed with HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.data) || !payload.meta) {
          throw new Error('OpenRouter Data API returned an invalid payload');
        }
        return payload;
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`OpenRouter Data API timed out after ${timeoutMs}ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function validateCollectorResult(sourceKey, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${sourceKey} collector returned an invalid result`);
  }
  const payload = result.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${sourceKey} collector returned an invalid payload`);
  }
  const allowedFields = new Set(SLICE_PAYLOAD_FIELDS[sourceKey] || []);
  for (const field of Object.keys(payload)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${sourceKey} collector returned unsupported payload field: ${field}`);
    }
  }
  if (Object.keys(payload).length === 0) throw new Error(`${sourceKey} collector returned an empty payload`);
  if (!result.source || typeof result.source !== 'object' || Array.isArray(result.source)) {
    throw new Error(`${sourceKey} collector returned invalid source metadata`);
  }
  if (!['ready', 'error', 'authorization_required'].includes(result.source.status)) {
    throw new Error(`${sourceKey} collector returned invalid source status`);
  }
  return { payload, source: result.source };
}

function failedSource(previousSource, error, generatedAt) {
  return {
    ...previousSource,
    status: 'error',
    stale: true,
    syncedAt: generatedAt,
    message: error instanceof Error ? error.message : String(error),
  };
}

function validateRefreshSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => !SOURCE_KEY_SET.has(source))) {
    throw new Error(`Unsupported AI dashboard refresh sources: ${JSON.stringify(sources)}`);
  }
  return [...new Set(sources)];
}

export function createAiDashboardService({
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
  cdsFile = DEFAULT_CDS_FILE,
  collectors = {},
  openRouterClient,
  openRouterPublicClient,
  officialBenchmarkClient,
  now = () => new Date(),
} = {}) {
  const activeCollectors = { ...collectors };
  if (typeof activeCollectors.benchmarks !== 'function' && officialBenchmarkClient) {
    activeCollectors.benchmarks = createOfficialBenchmarkCollector({ officialBenchmarkClient });
  }
  let refreshQueue = Promise.resolve();
  let benchmarkRefreshInFlight = null;

  const getSnapshot = async () => {
    const snapshot = await readSnapshotFile(dataFile, now);
    const cds5y = await readCdsFile(cdsFile);
    if (!cds5y) return snapshot;
    return {
      ...snapshot,
      creditRisk: {
        ...(snapshot.creditRisk || {}),
        cds5y,
      },
    };
  };

  const performRefresh = async ({ sources, force = false }) => {
    const previous = await getSnapshot();
    const generatedAt = isoNow(now);
    const nowDate = now();
    const next = {
      ...previous,
      schemaVersion: 2,
      generatedAt,
      sources: { ...previous.sources },
    };

    const genericSources = sources.filter((source) => source !== 'openRouter');
    const genericResults = await Promise.all(genericSources.map(async (sourceKey) => {
      const collector = activeCollectors[sourceKey];
      if (typeof collector !== 'function') return { sourceKey, skipped: true };
      try {
        const result = await collector({ previous, now: nowDate, generatedAt, force });
        return { sourceKey, value: validateCollectorResult(sourceKey, result) };
      } catch (error) {
        return { sourceKey, error };
      }
    }));

    for (const result of genericResults) {
      if (result.skipped) continue;
      if (result.error) {
        next.sources[result.sourceKey] = failedSource(previous.sources[result.sourceKey], result.error, generatedAt);
        continue;
      }
      Object.assign(next, result.value.payload);
      next.sources[result.sourceKey] = {
        ...result.value.source,
        syncedAt: generatedAt,
      };
    }

    if (sources.includes('openRouter')) {
      const endDate = utcDateOffset(nowDate, -1);
      const startDate = utcDateOffset(nowDate, -84);
      try {
        if (openRouterClient) {
          const payload = await openRouterClient.fetchRankings({ startDate, endDate });
          const coverageError = openRouterCoverageError(payload, endDate);
          if (coverageError) throw new Error(coverageError);
          next.openRouter = {
            ...aggregateOpenRouterWeekly(payload.data, { endDate: payload.meta.end_date || endDate, weeks: 12 }),
            attribution: `Source: OpenRouter (openrouter.ai/rankings), as of ${payload.meta.as_of}. Licensed under CC BY 4.0.`,
          };
          next.sources.openRouter = {
            status: 'ready',
            stale: false,
            asOf: payload.meta.as_of,
            syncedAt: generatedAt,
            url: OPENROUTER_SOURCE_URL,
            message: 'OpenRouter 公开排名同步成功',
          };
        } else if (openRouterPublicClient) {
          const payload = await openRouterPublicClient.readRankings();
          next.openRouter = {
            startDate: payload.startDate,
            endDate: payload.endDate,
            weekTotalTokens: null,
            priorWeekTotalTokens: null,
            weekOverWeekAbsolute: null,
            weekOverWeekPercent: null,
            topModels: payload.topModels,
            history: [],
            attribution: `Source: OpenRouter public leaderboard (openrouter.ai/rankings), as of ${payload.asOf}. Rounded display values. Licensed under CC BY 4.0.`,
          };
          next.sources.openRouter = {
            status: 'ready',
            stale: true,
            asOf: payload.asOf,
            syncedAt: generatedAt,
            url: OPENROUTER_SOURCE_URL,
            message: '已读取公开榜单 Top 10；全平台周总量和 12 周趋势需配置 OpenRouter Data API 密钥',
          };
        }
      } catch (error) {
        next.sources.openRouter = failedSource(previous.sources.openRouter, error, generatedAt);
      }
    }

    await writeSnapshotFile(dataFile, next);
    return next;
  };

  return {
    getSnapshot,
    refresh(options = {}) {
      const sources = validateRefreshSources(options.sources || DASHBOARD_SOURCE_KEYS);
      const benchmarkOnly = sources.length === 1 && sources[0] === 'benchmarks';
      if (benchmarkOnly && benchmarkRefreshInFlight) return benchmarkRefreshInFlight;

      const enqueue = async () => {
        if (benchmarkOnly && !options.force) {
          const snapshot = await getSnapshot();
          const syncedAt = Date.parse(snapshot.sources.benchmarks?.syncedAt || '');
          if (snapshot.sources.benchmarks?.status === 'ready'
            && Number.isFinite(syncedAt)
            && now().getTime() - syncedAt < BENCHMARK_FRESH_MS) return snapshot;
        }
        const queuedRefresh = refreshQueue.then(() => performRefresh({ ...options, sources }));
        refreshQueue = queuedRefresh.catch(() => undefined);
        return queuedRefresh;
      };

      if (!benchmarkOnly) return enqueue();
      const trackedRefresh = enqueue().finally(() => {
        if (benchmarkRefreshInFlight === trackedRefresh) benchmarkRefreshInFlight = null;
      });
      benchmarkRefreshInFlight = trackedRefresh;
      return trackedRefresh;
    },
  };
}

export function createAiDashboardServiceFromEnv({
  fetchImpl = fetch,
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
  cdsFile = DEFAULT_CDS_FILE,
  openRouterPublicFile = DEFAULT_OPENROUTER_PUBLIC_FILE,
  collectors = {},
  pricingSourceIds,
  growthSourceIds,
  capitalSourceIds,
  computeSourceIds,
  officialBenchmarkClient,
  now = () => new Date(),
} = {}) {
  const openRouterClient = process.env.OPENROUTER_API_KEY
    ? createOpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY, fetchImpl })
    : undefined;
  const openRouterPublicClient = !openRouterClient && openRouterPublicFile && fs.existsSync(openRouterPublicFile)
    ? {
        async readRankings() {
          const payload = JSON.parse(await fs.promises.readFile(openRouterPublicFile, 'utf8'));
          const topModels = Array.isArray(payload?.topModels)
            ? payload.topModels.filter((row) => row?.model && /^\d+$/.test(String(row.totalTokens || '')))
            : [];
          if (!payload?.asOf || !payload?.startDate || !payload?.endDate || topModels.length === 0) {
            throw new Error('本地 OpenRouter 公开榜单文件格式无效');
          }
          return { ...payload, topModels };
        },
      }
    : undefined;
  const mergedCollectors = { ...collectors };
  const officialDocumentClient = createOfficialDocumentClient({ fetchImpl, now });
  if (typeof mergedCollectors.growth !== 'function') {
    const growthRegistry = AI_GROWTH_SOURCE_REGISTRY.filter((source) => (
      !growthSourceIds || growthSourceIds.includes(source.id)
    ));
    mergedCollectors.growth = createAiGrowthCollector({
      documentClient: officialDocumentClient,
      registry: growthRegistry,
    });
  }
  if (typeof mergedCollectors.pricing !== 'function') {
    const pricingRegistry = PUBLIC_SOURCE_REGISTRY.filter((source) => (
      source.slice === 'pricing' && (!pricingSourceIds || pricingSourceIds.includes(source.id))
    ));
    mergedCollectors.pricing = createAiPricingCollector({
      documentClient: officialDocumentClient,
      registry: pricingRegistry,
    });
  }
  if (typeof mergedCollectors.capital !== 'function') {
    const capitalRegistry = AI_CAPITAL_SOURCE_REGISTRY.filter((source) => (
      !capitalSourceIds || capitalSourceIds.includes(source.id)
    ));
    mergedCollectors.capital = createAiCapitalCollector({
      documentClient: officialDocumentClient,
      registry: capitalRegistry,
    });
  }
  if (typeof mergedCollectors.compute !== 'function') {
    const computeRegistry = AI_COMPUTE_SOURCE_REGISTRY.filter((source) => (
      !computeSourceIds || computeSourceIds.includes(source.id)
    ));
    mergedCollectors.compute = createAiComputeCollector({
      documentClient: officialDocumentClient,
      registry: computeRegistry,
    });
  }
  if (typeof mergedCollectors.artificialAnalysis !== 'function') {
    mergedCollectors.artificialAnalysis = createArtificialAnalysisCollector({
      documentClient: officialDocumentClient,
    });
  }
  if (typeof mergedCollectors.benchmarks !== 'function') {
    const benchmarkDocumentClient = createOfficialDocumentClient({
      fetchImpl, now, maxBytes: 24 * 1024 * 1024, timeoutMs: 45_000,
    });
    const benchmarkClient = officialBenchmarkClient || createOfficialModelCardRegistry({
      documentClient: benchmarkDocumentClient,
      now,
    });
    mergedCollectors.benchmarks = createOfficialBenchmarkCollector({ officialBenchmarkClient: benchmarkClient });
  }
  return createAiDashboardService({
    dataFile,
    cdsFile,
    collectors: mergedCollectors,
    openRouterClient,
    openRouterPublicClient,
    officialBenchmarkClient,
    now,
  });
}

export function startAiDashboardAutoRefresh(service, {
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
} = {}) {
  const run = (sources) => service.refresh({ sources }).catch((error) => {
    console.error(`[ai-dashboard] automatic refresh failed: ${error.message}`);
  });
  const researchSources = ['growth', 'pricing', 'capital', 'artificialAnalysis', 'compute'];
  const initial = setTimeoutImpl(() => run(DASHBOARD_SOURCE_KEYS), 5_000);
  const researchInterval = setIntervalImpl(() => run(researchSources), DAY_MS);
  const openRouterInterval = setIntervalImpl(() => run(['openRouter']), DAY_MS);
  const benchmarkInterval = setIntervalImpl(() => run(['benchmarks']), DAY_MS);
  console.log('[ai-dashboard] scheduled seven public-source slices for daily refresh');
  return () => {
    clearTimeoutImpl(initial);
    clearIntervalImpl(researchInterval);
    clearIntervalImpl(openRouterInterval);
    clearIntervalImpl(benchmarkInterval);
  };
}
