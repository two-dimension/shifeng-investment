import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeishuClient, normalizeFeishuWorkbook } from './aiDashboardData.js';
import { normalizeOnlineBenchmarks } from './aiBenchmarkData.js';
import { normalizeCdsDataset } from './aiCdsData.js';
import {
  aggregateOpenRouterWeekly,
  attachValuationMultiples,
  buildArrMetrics,
  selectLatestBenchmarkModels,
} from './aiDashboardMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEISHU_SOURCE_URL = 'https://xcn0zaydz11m.feishu.cn/sheets/F9W3s5BBEhRRV8tdZvCchEAfnCf?sheet=0rbUAO&table=tblzvLEtWP2TaYtF&view=vew0i9u3MV';
const OPENROUTER_SOURCE_URL = 'https://openrouter.ai/rankings';
const OPENROUTER_DATA_API_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily';
const OPENROUTER_MODELS_API_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_BENCHMARKS_API_URL = 'https://openrouter.ai/api/v1/benchmarks';
const OPENROUTER_BENCHMARKS_URL = 'https://openrouter.ai/benchmarks';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BENCHMARK_FRESH_MS = 15 * 60 * 1000;

export const DEFAULT_AI_DASHBOARD_FILE = path.join(__dirname, '../data/ai-dashboard/snapshot.json');
export const DEFAULT_FEISHU_EXPORT_FILE = path.join(__dirname, '../data/ai-dashboard/feishu-export.json');
export const DEFAULT_OPENROUTER_PUBLIC_FILE = path.join(__dirname, '../data/ai-dashboard/openrouter-public.json');
export const DEFAULT_CDS_FILE = path.join(__dirname, '../data/ai-dashboard/cds-5y.json');
export const AI_DASHBOARD_SHEET_TITLES = Object.freeze([
  'ARR&估值',
  'API模型token价格&发布日期&优化方向',
  '模型基准测试',
  '海外算力租赁价格追踪',
  '债务融资',
  '视频模型价格',
  'Coding Plan价格',
]);

function isoNow(now) {
  return now().toISOString();
}

function utcDateOffset(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

export function createEmptyAiDashboardSnapshot(generatedAt = new Date().toISOString()) {
  const unavailable = (message = '尚未完成首次公开数据同步') => ({
    status: 'error',
    stale: true,
    asOf: null,
    syncedAt: null,
    message,
  });
  return {
    schemaVersion: 2,
    generatedAt,
    sources: {
      growth: unavailable(),
      openRouter: {
        status: 'authorization_required',
        stale: true,
        asOf: null,
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
      feishuFallbackModels: [],
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

async function readSnapshotFile(dataFile, now) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
    const empty = createEmptyAiDashboardSnapshot(isoNow(now));
    return {
      ...empty,
      ...parsed,
      sources: { ...empty.sources, ...(parsed.sources || {}) },
      benchmarks: { ...empty.benchmarks, ...(parsed.benchmarks || {}) },
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

function legacyBenchmarkSlice(models) {
  const selected = selectLatestBenchmarkModels(models);
  const metricNames = [...new Set(selected.models.flatMap((model) => Object.keys(model.scores || {})))];
  const asOf = selected.models.map((model) => model.releasedAt).filter(Boolean).sort().at(-1) || null;
  return {
    ...selected,
    models: selected.models.map((model) => ({ ...model, sourceMode: 'feishu' })),
    metrics: metricNames.map((key) => {
      const score = selected.models.find((model) => model.scores?.[key])?.scores?.[key];
      return {
        key,
        label: key,
        group: '飞书历史口径',
        unit: Number.isFinite(Number(score?.value)) && Math.abs(Number(score.value)) <= 1
          ? 'percent'
          : (score?.metric || 'number'),
        direction: score?.direction === 'lower' ? 'lower' : 'higher',
        source: 'feishu',
        sourceUrl: FEISHU_SOURCE_URL,
      };
    }),
    asOf,
    sourceMode: 'feishu',
    coverage: {
      vendors: selected.models.length,
      evaluatedVendors: selected.models.filter((model) => Object.keys(model.scores || {}).length > 0).length,
      metrics: metricNames.length,
    },
    attributions: [{ source: 'feishu', label: '飞书模型基准测试', url: FEISHU_SOURCE_URL }],
    feishuFallbackModels: models || [],
  };
}

async function writeSnapshotFile(dataFile, snapshot) {
  await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempFile, dataFile);
}

function enrichComputeRental(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = `${row.platform}\u0000${row.gpu}`;
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.values()].flatMap((group) => group
    .toSorted((left, right) => left.asOf.localeCompare(right.asOf))
    .map((row, index, sorted) => ({
      ...row,
      onDemandChange: index > 0 && row.onDemand !== null && sorted[index - 1].onDemand !== null
        ? row.onDemand - sorted[index - 1].onDemand
        : null,
      preemptibleChange: index > 0 && row.preemptible !== null && sorted[index - 1].preemptible !== null
        ? row.preemptible - sorted[index - 1].preemptible
        : null,
      latest: index === sorted.length - 1,
    })));
}

function feishuSlice(normalized, nowDate, previous) {
  const available = new Set(normalized.validSheets || []);
  const missingSheets = AI_DASHBOARD_SHEET_TITLES.filter((title) => !available.has(title));
  const slice = {};

  if (available.has('ARR&估值')) {
    const companies = buildArrMetrics(normalized.arrRecords, { now: nowDate });
    slice.arrAndValuation = {
      companies,
      valuations: attachValuationMultiples(normalized.valuationRecords, companies)
        .toSorted((left, right) => String(right.asOf).localeCompare(String(left.asOf))),
    };
  }

  const modelPricing = {
    token: previous.modelPricing?.token || [],
    video: previous.modelPricing?.video || [],
    codingPlans: previous.modelPricing?.codingPlans || [],
  };
  let pricingChanged = false;
  if (available.has('API模型token价格&发布日期&优化方向')) {
    modelPricing.token = normalized.modelPrices;
    pricingChanged = true;
  }
  if (available.has('视频模型价格')) {
    modelPricing.video = normalized.videoPrices;
    pricingChanged = true;
  }
  if (available.has('Coding Plan价格')) {
    modelPricing.codingPlans = normalized.codingPlans;
    pricingChanged = true;
  }
  if (pricingChanged) slice.modelPricing = modelPricing;
  if (available.has('模型基准测试') && available.has('API模型token价格&发布日期&优化方向')) {
    slice.benchmarks = previous.benchmarks?.sourceMode === 'openrouter'
      ? { ...previous.benchmarks, feishuFallbackModels: normalized.benchmarkModels }
      : legacyBenchmarkSlice(normalized.benchmarkModels);
  }
  if (available.has('海外算力租赁价格追踪')) slice.computeRental = enrichComputeRental(normalized.computeRental);
  if (available.has('债务融资')) {
    slice.debtFinancing = normalized.debtFinancing.toSorted((left, right) => String(right.asOf).localeCompare(String(left.asOf)));
  }
  return { slice, missingSheets };
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
  const fetchJson = async (url, label) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async fetchRankings({ startDate, endDate }) {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      const payload = await fetchJson(`${OPENROUTER_DATA_API_URL}?${params}`, 'OpenRouter Data API');
      if (!Array.isArray(payload.data) || !payload.meta) throw new Error('OpenRouter Data API returned an invalid payload');
      return payload;
    },
    async fetchModels() {
      const params = new URLSearchParams({ output_modalities: 'text' });
      const payload = await fetchJson(`${OPENROUTER_MODELS_API_URL}?${params}`, 'OpenRouter Models API');
      if (!Array.isArray(payload?.data)) throw new Error('OpenRouter Models API returned an invalid payload');
      return payload;
    },
    async fetchBenchmarks() {
      const payload = await fetchJson(OPENROUTER_BENCHMARKS_API_URL, 'OpenRouter Benchmarks API');
      if (!Array.isArray(payload?.data) || !payload.meta || Array.isArray(payload.meta) || typeof payload.meta !== 'object') {
        throw new Error('OpenRouter Benchmarks API returned an invalid payload');
      }
      return payload;
    },
  };
}

export function createAiDashboardService({
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
  cdsFile = DEFAULT_CDS_FILE,
  feishuClient,
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

  const performRefresh = async ({ sources = ['feishu', 'openRouter', 'benchmarks'] } = {}) => {
    const previous = await getSnapshot();
    const generatedAt = isoNow(now);
    const nowDate = now();
    const next = { ...previous, generatedAt, sources: { ...previous.sources } };
    const shouldRefreshFeishu = sources.includes('feishu');
    const shouldRefreshOpenRouter = sources.includes('openRouter');
    const shouldRefreshBenchmarks = sources.includes('benchmarks');

    const feishuPromise = shouldRefreshFeishu && feishuClient
      ? feishuClient.readWorkbook(AI_DASHBOARD_SHEET_TITLES).then((workbook) => normalizeFeishuWorkbook(workbook, { asOf: generatedAt }))
      : null;
    const endDate = utcDateOffset(nowDate, -1);
    const startDate = utcDateOffset(nowDate, -84);
    const openRouterPromise = shouldRefreshOpenRouter && openRouterClient
      ? openRouterClient.fetchRankings({ startDate, endDate })
      : null;
    const openRouterPublicPromise = shouldRefreshOpenRouter && !openRouterClient && openRouterPublicClient
      ? openRouterPublicClient.readRankings()
      : null;
    const hasBenchmarkClient = openRouterClient
      && typeof openRouterClient.fetchModels === 'function'
      && typeof openRouterClient.fetchBenchmarks === 'function';
    const benchmarkPromise = shouldRefreshBenchmarks && hasBenchmarkClient
      ? Promise.all([openRouterClient.fetchModels(), openRouterClient.fetchBenchmarks()])
      : null;
    const [feishuResult, openRouterResult, openRouterPublicResult, benchmarkResult] = await Promise.all([
      feishuPromise ? feishuPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
      openRouterPromise ? openRouterPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
      openRouterPublicPromise ? openRouterPublicPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
      benchmarkPromise ? benchmarkPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
    ]);

    if (shouldRefreshFeishu) {
      if (!feishuClient) {
        next.sources.feishu = createEmptyAiDashboardSnapshot(generatedAt).sources.feishu;
      } else if (feishuResult?.error) {
        next.sources.feishu = {
          ...previous.sources.feishu,
          status: 'error',
          stale: true,
          url: FEISHU_SOURCE_URL,
          message: feishuResult.error.message,
        };
      } else {
        const { slice, missingSheets } = feishuSlice(feishuResult.value, nowDate, previous);
        Object.assign(next, slice);
        next.sources.feishu = {
          status: 'ready',
          stale: missingSheets.length > 0,
          asOf: generatedAt,
          url: FEISHU_SOURCE_URL,
          message: missingSheets.length > 0
            ? `飞书部分工作表缺失或表头无效，已保留上一版：${missingSheets.join('、')}`
            : '飞书工作表同步成功',
        };
      }
    }

    if (shouldRefreshOpenRouter) {
      if (!openRouterClient) {
        if (openRouterPublicResult?.error) {
          next.sources.openRouter = {
            ...previous.sources.openRouter,
            status: 'error',
            stale: true,
            url: OPENROUTER_SOURCE_URL,
            message: openRouterPublicResult.error.message,
          };
        } else if (openRouterPublicResult?.value) {
          const payload = openRouterPublicResult.value;
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
            url: OPENROUTER_SOURCE_URL,
            message: '已读取公开榜单 Top 10；全平台周总量和 12 周趋势需配置 OpenRouter Data API 密钥',
          };
        } else {
          next.sources.openRouter = createEmptyAiDashboardSnapshot(generatedAt).sources.openRouter;
        }
      } else if (openRouterResult?.error) {
        next.sources.openRouter = {
          ...previous.sources.openRouter,
          status: 'error',
          stale: true,
          url: OPENROUTER_SOURCE_URL,
          message: openRouterResult.error.message,
        };
      } else {
        const payload = openRouterResult.value;
        const coverageError = openRouterCoverageError(payload, endDate);
        if (coverageError) {
          next.sources.openRouter = {
            ...previous.sources.openRouter,
            status: 'error',
            stale: true,
            url: OPENROUTER_SOURCE_URL,
            message: coverageError,
          };
        } else {
          next.openRouter = {
            ...aggregateOpenRouterWeekly(payload.data, { endDate: payload.meta.end_date || endDate, weeks: 12 }),
            attribution: `Source: OpenRouter (openrouter.ai/rankings), as of ${payload.meta.as_of}. Licensed under CC BY 4.0.`,
          };
          next.sources.openRouter = {
            status: 'ready',
            stale: false,
            asOf: payload.meta.as_of,
            url: OPENROUTER_SOURCE_URL,
            message: 'OpenRouter 公开排名同步成功',
          };
        }
      }
    }

    if (shouldRefreshBenchmarks) {
      if (!hasBenchmarkClient) {
        next.sources.benchmarks = createEmptyAiDashboardSnapshot(generatedAt).sources.benchmarks;
      } else if (benchmarkResult?.error) {
        next.sources.benchmarks = {
          ...previous.sources.benchmarks,
          status: 'error',
          stale: true,
          url: OPENROUTER_BENCHMARKS_URL,
          message: benchmarkResult.error.message,
        };
      } else {
        try {
          const [catalogPayload, benchmarkPayload] = benchmarkResult.value;
          if (catalogPayload.data.length === 0 || benchmarkPayload.data.length === 0) {
            throw new Error('OpenRouter Benchmark 返回空数据，已保留上一版');
          }
          const feishuModels = feishuResult?.value?.benchmarkModels
            || next.benchmarks?.feishuFallbackModels
            || (next.benchmarks?.sourceMode === 'feishu' ? next.benchmarks.models : []);
          const normalized = normalizeOnlineBenchmarks({
            catalog: catalogPayload.data,
            benchmarkPayload,
            feishuModels,
          });
          if (normalized.models.length === 0) throw new Error('OpenRouter Benchmark 无可匹配模型，已保留上一版');
          next.benchmarks = { ...normalized, feishuFallbackModels: feishuModels };
          next.sources.benchmarks = {
            status: 'ready',
            stale: false,
            asOf: normalized.asOf || generatedAt,
            syncedAt: generatedAt,
            url: OPENROUTER_BENCHMARKS_URL,
            message: `Benchmark 同步成功：${normalized.coverage.evaluatedVendors}/${normalized.coverage.vendors} 个厂商有评测数据`,
          };
        } catch (error) {
          next.benchmarks = previous.benchmarks?.sourceMode === 'openrouter' ? previous.benchmarks : next.benchmarks;
          next.sources.benchmarks = {
            ...previous.sources.benchmarks,
            status: 'error',
            stale: true,
            url: OPENROUTER_BENCHMARKS_URL,
            message: error.message,
          };
        }
      }
    }

    await writeSnapshotFile(dataFile, next);
    return next;
  };

  return {
    getSnapshot,
    refresh(options = {}) {
      const sources = options.sources || ['feishu', 'openRouter', 'benchmarks'];
      const benchmarkOnly = sources.length === 1 && sources[0] === 'benchmarks';
      if (benchmarkOnly && benchmarkRefreshInFlight) return benchmarkRefreshInFlight;

      const enqueue = async () => {
        if (benchmarkOnly && !options.force) {
          const snapshot = await getSnapshot();
          const syncedAt = Date.parse(snapshot.sources.benchmarks?.syncedAt || snapshot.sources.benchmarks?.asOf || '');
          if (snapshot.sources.benchmarks?.status === 'ready'
            && snapshot.benchmarks?.sourceMode === 'openrouter'
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
  feishuExportFile = DEFAULT_FEISHU_EXPORT_FILE,
  openRouterPublicFile = DEFAULT_OPENROUTER_PUBLIC_FILE,
  now = () => new Date(),
} = {}) {
  let feishuClient = process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET && process.env.FEISHU_AI_SHEET_TOKEN
    ? createFeishuClient({
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        spreadsheetToken: process.env.FEISHU_AI_SHEET_TOKEN,
        fetchImpl,
      })
    : undefined;
  if (!feishuClient && feishuExportFile && fs.existsSync(feishuExportFile)) {
    feishuClient = {
      async readWorkbook() {
        const payload = JSON.parse(await fs.promises.readFile(feishuExportFile, 'utf8'));
        if (!payload?.workbook || typeof payload.workbook !== 'object') {
          throw new Error('本地飞书导出文件格式无效');
        }
        return payload.workbook;
      },
    };
  }
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
  return createAiDashboardService({ dataFile, cdsFile, feishuClient, openRouterClient, openRouterPublicClient, now });
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
  const initial = setTimeoutImpl(() => run(['feishu', 'openRouter', 'benchmarks']), 5_000);
  const feishuInterval = setIntervalImpl(() => run(['feishu']), HOUR_MS);
  const openRouterInterval = setIntervalImpl(() => run(['openRouter']), DAY_MS);
  const benchmarkInterval = setIntervalImpl(() => run(['benchmarks']), DAY_MS);
  console.log('[ai-dashboard] scheduled Feishu hourly, OpenRouter rankings daily, and Benchmarks daily');
  return () => {
    clearTimeoutImpl(initial);
    clearIntervalImpl(feishuInterval);
    clearIntervalImpl(openRouterInterval);
    clearIntervalImpl(benchmarkInterval);
  };
}
