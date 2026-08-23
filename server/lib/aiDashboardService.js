import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeishuClient, normalizeFeishuWorkbook } from './aiDashboardData.js';
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
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_AI_DASHBOARD_FILE = path.join(__dirname, '../data/ai-dashboard/snapshot.json');
export const DEFAULT_FEISHU_EXPORT_FILE = path.join(__dirname, '../data/ai-dashboard/feishu-export.json');
export const DEFAULT_OPENROUTER_PUBLIC_FILE = path.join(__dirname, '../data/ai-dashboard/openrouter-public.json');
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
  return {
    schemaVersion: 1,
    generatedAt,
    sources: {
      feishu: {
        status: 'authorization_required',
        stale: true,
        asOf: null,
        url: FEISHU_SOURCE_URL,
        message: '需配置飞书企业自建应用只读凭证',
      },
      openRouter: {
        status: 'authorization_required',
        stale: true,
        asOf: null,
        url: OPENROUTER_SOURCE_URL,
        message: '需配置 OPENROUTER_API_KEY',
      },
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
    benchmarks: { models: [], winners: {} },
    computeRental: [],
    debtFinancing: [],
  };
}

async function readSnapshotFile(dataFile, now) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
    return { ...createEmptyAiDashboardSnapshot(isoNow(now)), ...parsed };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[ai-dashboard] snapshot read failed: ${error.message}`);
    return createEmptyAiDashboardSnapshot(isoNow(now));
  }
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
    slice.benchmarks = selectLatestBenchmarkModels(normalized.benchmarkModels);
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

export function createOpenRouterClient({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('OpenRouter API key is required');
  return {
    async fetchRankings({ startDate, endDate }) {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      const response = await fetchImpl(`${OPENROUTER_DATA_API_URL}?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(`OpenRouter Data API failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.data) || !payload.meta) throw new Error('OpenRouter Data API returned an invalid payload');
      return payload;
    },
  };
}

export function createAiDashboardService({
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
  feishuClient,
  openRouterClient,
  openRouterPublicClient,
  now = () => new Date(),
} = {}) {
  let refreshQueue = Promise.resolve();

  const getSnapshot = () => readSnapshotFile(dataFile, now);

  const performRefresh = async ({ sources = ['feishu', 'openRouter'] } = {}) => {
    const previous = await getSnapshot();
    const generatedAt = isoNow(now);
    const nowDate = now();
    const next = { ...previous, generatedAt, sources: { ...previous.sources } };
    const shouldRefreshFeishu = sources.includes('feishu');
    const shouldRefreshOpenRouter = sources.includes('openRouter');

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
    const [feishuResult, openRouterResult, openRouterPublicResult] = await Promise.all([
      feishuPromise ? feishuPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
      openRouterPromise ? openRouterPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
      openRouterPublicPromise ? openRouterPublicPromise.then((value) => ({ value })).catch((error) => ({ error })) : null,
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

    await writeSnapshotFile(dataFile, next);
    return next;
  };

  return {
    getSnapshot,
    refresh(options) {
      const queuedRefresh = refreshQueue.then(() => performRefresh(options));
      refreshQueue = queuedRefresh.catch(() => undefined);
      return queuedRefresh;
    },
  };
}

export function createAiDashboardServiceFromEnv({
  fetchImpl = fetch,
  dataFile = DEFAULT_AI_DASHBOARD_FILE,
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
  return createAiDashboardService({ dataFile, feishuClient, openRouterClient, openRouterPublicClient, now });
}

export function startAiDashboardAutoRefresh(service) {
  const run = (sources) => service.refresh({ sources }).catch((error) => {
    console.error(`[ai-dashboard] automatic refresh failed: ${error.message}`);
  });
  const initial = setTimeout(() => run(['feishu', 'openRouter']), 5_000);
  const feishuInterval = setInterval(() => run(['feishu']), HOUR_MS);
  const openRouterInterval = setInterval(() => run(['openRouter']), DAY_MS);
  console.log('[ai-dashboard] scheduled Feishu hourly and OpenRouter daily');
  return () => {
    clearTimeout(initial);
    clearInterval(feishuInterval);
    clearInterval(openRouterInterval);
  };
}
