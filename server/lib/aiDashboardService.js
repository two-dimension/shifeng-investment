import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCdsDataset } from './aiCdsData.js';
import { aggregateOpenRouterWeekly } from './aiDashboardMetrics.js';
import { DASHBOARD_SOURCE_KEYS } from './publicSourceRegistry.js';

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
  capital: Object.freeze(['debtFinancing']),
  benchmarks: Object.freeze(['benchmarks']),
  artificialAnalysis: Object.freeze(['artificialAnalysis']),
  compute: Object.freeze(['computeRental']),
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
      topModels: [],
      history: [],
      attribution: 'Source: OpenRouter (openrouter.ai/rankings). Licensed under CC BY 4.0.',
    },
    modelPricing: { token: [], video: [], codingPlans: [] },
    benchmarks: {
      models: [],
      metrics: [],
      winners: {},
      asOf: null,
      sourceMode: 'none',
      coverage: { vendors: 0, evaluatedVendors: 0, metrics: 0 },
      attributions: [],
    },
    artificialAnalysis: {
      intelligenceIndex: [],
      taskCosts: [],
    },
    computeRental: [],
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
    asOf: parsedBenchmarks.asOf || null,
    sourceMode: parsedBenchmarks.sourceMode,
    coverage: parsedBenchmarks.coverage || emptyBenchmarks.coverage,
    attributions: parsedBenchmarks.attributions || emptyBenchmarks.attributions,
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
  const missingDates = Array.from({ length: 7 }, (_, offset) => utcDateOffset(new Date(`${expectedEndDate}T00:00:00.000Z`), -offset))
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
  now = () => new Date(),
} = {}) {
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
      const collector = collectors[sourceKey];
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
  return createAiDashboardService({
    dataFile,
    cdsFile,
    collectors,
    openRouterClient,
    openRouterPublicClient,
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
