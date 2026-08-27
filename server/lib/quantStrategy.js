import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');

const TMT_DATA_DIR = path.join(ROOT, 'server', 'data', 'tmt-margin');
const QUANT_DATA_DIR = path.join(ROOT, 'server', 'data', 'quant');
const KLINE_CACHE_FILE = path.join(TMT_DATA_DIR, 'eastmoney-kline-cache.json');
const UNIVERSE_FILE = path.join(TMT_DATA_DIR, 'eastmoney-universe.json');
const BENCHMARK_FILE = path.join(QUANT_DATA_DIR, 'benchmark-000300.json');
const EXPERIMENTS_FILE = path.join(QUANT_DATA_DIR, 'macd-loop-experiments.json');
const DATA_STATUS_FILE = path.join(QUANT_DATA_DIR, 'data-status.json');
const KLINE_STORE_DIR = path.join(QUANT_DATA_DIR, 'kline', 'eastmoney');
const KLINE_MANIFEST_FILE = path.join(QUANT_DATA_DIR, 'kline-manifest.json');
const REPORT_SCRIPT = path.join(ROOT, 'scripts', 'generate_quant_report.py');
const REPORT_OUTPUT_DIR = path.join(ROOT, 'output', 'pdf', 'quant-loop');
const REPORT_TMP_DIR = path.join(ROOT, 'tmp', 'pdfs', 'quant-loop');
const BUNDLED_PYTHON = path.join(
  process.env.HOME || '',
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'python',
  'bin',
  'python3',
);

const BACKTEST_START = '20050408';
const BENCHMARK_SECID = '1.000300';
const BENCHMARK_NAME = '沪深300';
const BENCHMARK_TENCENT_SYMBOL = 'sh000300';
const MAX_POSITIONS = 30;
const TRADE_COST = 0.0015;
const REQUIRED_COVERAGE = 1;
const DATA_STATUS_SCHEMA_VERSION = 2;
const DATASET_MEMO_TTL_MS = 60 * 60 * 1000;
let datasetMemo = null;
let dataStatusMemo = null;
let quantBackfillInFlight = null;

export const LOOP_SEQUENCE = [
  { id: 'red_expansion', label: 'MACD红柱放大' },
  { id: 'green_decay', label: 'MACD绿柱衰减' },
  { id: 'trend_filter', label: '趋势项' },
  { id: 'fixed_filter', label: '固定项' },
  { id: 'volume_filter', label: '量价项' },
];

export const HARD_GATES = {
  sharpe: 1,
  calmar: 2,
  maxDrawdown: 0.2,
  rolling13WeekAvgOpenings: 8,
};

export const DEFAULT_PARAMS = {
  redWindow: 6,
  redFrontDown: 3,
  redBackUp: 3,
  greenDecayWindow: 3,
  redToGreenLookback: 5,
  trendMode: '5/10/20',
  volumeMa: 5,
  maxPositions: MAX_POSITIONS,
  tradeCost: TRADE_COST,
};

const readJson = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    console.error(`[quant] read failed ${file}:`, error.message);
    return fallback;
  }
};

const writeJson = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
};

const writeCompactJson = (file, payload) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  fs.renameSync(tmp, file);
};

const clearQuantMemo = () => {
  datasetMemo = null;
  dataStatusMemo = null;
};

const profileEnabled = () => process.env.QUANT_PROFILE === '1';
const profileLog = (message, startedAt = null) => {
  if (!profileEnabled()) return Date.now();
  const elapsed = startedAt == null ? '' : ` ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  console.error(`[quant-profile] ${message}${elapsed}`);
  return Date.now();
};

const normalizeCode = (code) => String(code || '')
  .trim()
  .replace(/^(sh|sz|bj)/i, '')
  .split('.')[0]
  .padStart(6, '0');

const parseDate = (date) => {
  const text = String(date || '').replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(text)) return null;
  return text;
};

const oneYearAfter = (date) => {
  const parsed = parseDate(date);
  if (!parsed) return null;
  return String(Number(parsed.slice(0, 4)) + 1) + parsed.slice(4);
};

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mapWithConcurrency(items, limit, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await iteratee(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const ymdToIso = (value) => {
  const date = parseDate(value);
  return date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null;
};
const isoToYmd = (value) => String(value || '').replace(/-/g, '').slice(0, 8);
const todayYmd = () => isoToYmd(new Date().toISOString().slice(0, 10));

const addMonthsIso = (isoDate, months) => {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

const previousDayIso = (isoDate) => {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const minIsoDate = (a, b) => (a <= b ? a : b);

function buildDateRanges(startYmd, endYmd, monthSpan = 24) {
  const startIso = ymdToIso(startYmd || BACKTEST_START);
  const endIso = ymdToIso(endYmd || todayYmd());
  if (!startIso || !endIso || startIso > endIso) return [];
  const ranges = [];
  let cursor = startIso;
  while (cursor <= endIso) {
    const nextCursor = addMonthsIso(cursor, monthSpan);
    const rangeEnd = minIsoDate(previousDayIso(nextCursor), endIso);
    ranges.push([cursor, rangeEnd]);
    cursor = nextCursor;
  }
  return ranges;
}

const stddev = (values) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
};

const pct = (value) => Number.isFinite(value) ? Number(value.toFixed(4)) : null;
const compactTimestamp = (date = new Date()) => date.toISOString().replace(/\D/g, '').slice(0, 14);
const safeFilePart = (value) => String(value || 'run')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 80) || 'run';

const isNorthExchangeCode = (code) => {
  const c = normalizeCode(code);
  return c.startsWith('4') || c.startsWith('8') || c.startsWith('9');
};

const isStName = (name) => (
  /(^|\s|\*)ST/i.test(String(name || ''))
  || /(^|\s|\*)PT/i.test(String(name || ''))
  || String(name || '').includes('退')
);

const getRawRowDates = (rows = []) => (rows || [])
  .map((row) => parseDate(row?.date))
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

const isKnownListedLessThanOneYear = (rows = []) => {
  const dates = getRawRowDates(rows);
  if (!dates.length) return false;
  const firstEligible = oneYearAfter(dates[0]);
  const latest = dates[dates.length - 1];
  return Boolean(firstEligible && latest && firstEligible > latest);
};

const hasUsableHistoryRows = (rows = []) => (
  Array.isArray(rows)
  && rows.length >= 120
  && !isKnownListedLessThanOneYear(rows)
);

const summarizeKlineRows = (rows = []) => {
  const dates = getRawRowDates(rows);
  const firstDate = dates[0] || null;
  const lastDate = dates[dates.length - 1] || null;
  const shortHistory = isKnownListedLessThanOneYear(rows);
  return {
    rowCount: Array.isArray(rows) ? rows.length : 0,
    firstDate,
    lastDate,
    shortHistory,
    usable: hasUsableHistoryRows(rows),
  };
};

const stockKlineFile = (code) => {
  const normalized = normalizeCode(code);
  return path.join(KLINE_STORE_DIR, normalized.slice(0, 2), `${normalized}.json`);
};

const loadKlineManifest = () => readJson(KLINE_MANIFEST_FILE, {
  source: 'quant-kline-manifest',
  stocks: {},
  failures: {},
  exclusions: {},
});

const writeKlineManifest = (manifest) => {
  writeJson(KLINE_MANIFEST_FILE, {
    source: 'quant-kline-manifest',
    updatedAt: new Date().toISOString(),
    stocks: manifest.stocks || {},
    failures: manifest.failures || {},
    exclusions: manifest.exclusions || {},
    legacyMigratedAt: manifest.legacyMigratedAt || null,
    sourceHealth: manifest.sourceHealth || {},
  });
};

const readStoredKline = (code) => readJson(stockKlineFile(code), null);

const writeStoredKline = (code, payload) => {
  writeCompactJson(stockKlineFile(code), payload);
};

const listFilesRecursive = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
};

const ema = (values, span) => {
  const alpha = 2 / (span + 1);
  const result = [];
  let last = null;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      result.push(last);
      continue;
    }
    last = last == null ? value : value * alpha + last * (1 - alpha);
    result.push(last);
  }
  return result;
};

const smaAt = (values, index, window) => {
  if (index < window - 1) return null;
  const slice = values.slice(index - window + 1, index + 1).filter(Number.isFinite);
  if (slice.length < window) return null;
  return mean(slice);
};

const smaSeries = (values, window) => {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  let validCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) {
      sum += value;
      validCount += 1;
    }
    if (index >= window) {
      const leaving = values[index - window];
      if (Number.isFinite(leaving)) {
        sum -= leaving;
        validCount -= 1;
      }
    }
    if (index >= window - 1 && validCount === window) {
      result[index] = sum / window;
    }
  }
  return result;
};

const enrichRows = (rows) => {
  const cleaned = (rows || [])
    .map((row) => ({
      date: parseDate(row.date),
      open: toNumber(row.open),
      close: toNumber(row.close),
      high: toNumber(row.high),
      low: toNumber(row.low),
      volume: toNumber(row.volume),
      amount: toNumber(row.amount),
    }))
    .filter((row) => row.date && row.open != null && row.close != null && row.open > 0 && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const closes = cleaned.map((row) => row.close);
  const volumes = cleaned.map((row) => row.volume);
  const emaFast = ema(closes, 12);
  const emaSlow = ema(closes, 26);
  const dif = emaFast.map((fast, index) => (fast == null || emaSlow[index] == null ? null : fast - emaSlow[index]));
  const dea = ema(dif.map((value) => value ?? 0), 9);
  const ma5 = smaSeries(closes, 5);
  const ma10 = smaSeries(closes, 10);
  const ma20 = smaSeries(closes, 20);
  const volMa5 = smaSeries(volumes, 5);
  const volMa10 = smaSeries(volumes, 10);

  return cleaned.map((row, index) => ({
    ...row,
    dif: dif[index],
    dea: dea[index],
    hist: dif[index] == null || dea[index] == null ? null : dif[index] - dea[index],
    ma5: ma5[index],
    ma10: ma10[index],
    ma20: ma20[index],
    volMa5: volMa5[index],
    volMa10: volMa10[index],
  }));
};

const buildIndex = (rows) => {
  const byDate = new Map();
  rows.forEach((row, index) => byDate.set(row.date, { row, index }));
  return byDate;
};

const increasing = (values) => values.every((value, index) => index === 0 || value > values[index - 1]);
const decreasing = (values) => values.every((value, index) => index === 0 || value < values[index - 1]);

const trendFilterByMode = (row, params = DEFAULT_PARAMS) => {
  const closeAbove20 = row.close != null && row.ma20 != null && row.close > row.ma20;
  if (params.trendMode === '5/20') {
    return closeAbove20 || (row.ma5 != null && row.ma20 != null && row.ma5 > row.ma20);
  }
  if (params.trendMode === '10/20') {
    return closeAbove20 || (row.ma10 != null && row.ma20 != null && row.ma10 > row.ma20);
  }
  return closeAbove20 || (row.ma5 != null && row.ma10 != null && row.ma5 > row.ma10);
};

export const indicatorChecks = {
  redExpansion(rows, index, params = DEFAULT_PARAMS) {
    const front = params.redFrontDown ?? 3;
    const back = params.redBackUp ?? 3;
    const window = front + back;
    if (index < window - 1) return false;
    const start = index - window + 1;
    for (let cursor = start; cursor <= index; cursor += 1) {
      if (rows[cursor].hist == null || rows[cursor].hist <= 0) return false;
    }
    for (let cursor = start + 1; cursor < start + front; cursor += 1) {
      if (!(rows[cursor].hist < rows[cursor - 1].hist)) return false;
    }
    for (let cursor = start + front + 1; cursor <= index; cursor += 1) {
      if (!(rows[cursor].hist > rows[cursor - 1].hist)) return false;
    }
    return true;
  },

  greenDecay(rows, index, params = DEFAULT_PARAMS) {
    const window = params.greenDecayWindow ?? 3;
    const lookback = params.redToGreenLookback ?? 5;
    if (index < Math.max(window, lookback) - 1) return false;
    const start = index - window + 1;
    for (let cursor = start; cursor <= index; cursor += 1) {
      if (rows[cursor].hist == null || rows[cursor].hist >= 0) return false;
      if (cursor > start && !(rows[cursor].hist > rows[cursor - 1].hist)) return false;
    }
    let hasRedToGreen = false;
    const lookbackStart = index - lookback + 1;
    for (let cursor = lookbackStart + 1; cursor <= index; cursor += 1) {
      if (rows[cursor - 1].hist > 0 && rows[cursor].hist < 0) {
        hasRedToGreen = true;
        break;
      }
    }
    return hasRedToGreen;
  },

  trendFilter(row, params = DEFAULT_PARAMS) {
    return trendFilterByMode(row, params);
  },

  fixedFilter(rows, index) {
    if (index < 1) return false;
    const row = rows[index];
    const prev = rows[index - 1];
    return (
      (row.dif != null && prev.dif != null && row.dif > prev.dif) ||
      (row.dea != null && prev.dea != null && row.dea > prev.dea) ||
      (row.hist != null && prev.hist != null && row.hist > prev.hist)
    );
  },

  volumeFilter(row, params = DEFAULT_PARAMS) {
    const ma = params.volumeMa === 10 ? row.volMa10 : row.volMa5;
    return row.volume != null && ma != null && row.volume > ma;
  },

  redDecay(rows, index) {
    if (index < 2) return false;
    const h0 = rows[index - 2].hist;
    const h1 = rows[index - 1].hist;
    const h2 = rows[index].hist;
    return h0 != null && h1 != null && h2 != null
      && h0 > 0 && h1 > 0 && h2 > 0
      && h1 < h0 && h2 < h1;
  },

  greenExpansion(rows, index) {
    if (index < 2) return false;
    const h0 = rows[index - 2].hist;
    const h1 = rows[index - 1].hist;
    const h2 = rows[index].hist;
    return h0 != null && h1 != null && h2 != null
      && h0 < 0 && h1 < 0 && h2 < 0
      && h1 < h0 && h2 < h1;
  },

  macdWeak(rows, index) {
    if (index < 1) return false;
    const row = rows[index];
    const prev = rows[index - 1];
    return (
      (row.hist != null && row.hist < 0) ||
      (row.dif != null && row.dea != null && row.dif < row.dea) ||
      (row.hist != null && prev.hist != null && row.hist < prev.hist)
    );
  },

  trendReverse(row) {
    return row.close != null && row.ma20 != null && row.ma5 != null && row.ma10 != null
      && row.close < row.ma20
      && row.ma5 < row.ma10;
  },
};

const activeIndicatorsForStage = (stageIndex) => LOOP_SEQUENCE.slice(0, stageIndex + 1).map((item) => item.id);

const scoreSignal = (rows, index, active, params) => {
  const row = rows[index];
  const red = active.includes('red_expansion') && indicatorChecks.redExpansion(rows, index, params);
  const green = active.includes('green_decay') && indicatorChecks.greenDecay(rows, index, params);
  if (!red && !green) return null;

  const trendPassed = indicatorChecks.trendFilter(row, params);
  const fixedPassed = indicatorChecks.fixedFilter(rows, index);
  const volumePassed = indicatorChecks.volumeFilter(row, params);
  if (active.includes('trend_filter') && !trendPassed) return null;
  if (active.includes('fixed_filter') && !fixedPassed) return null;
  if (active.includes('volume_filter') && !volumePassed) return null;

  const histStrength = row.close ? Math.max(-10, Math.min(10, (row.hist || 0) / row.close * 1000)) : 0;
  const score = 50
    + (red ? 18 : 0)
    + (green ? 14 : 0)
    + (trendPassed ? 8 : 0)
    + (fixedPassed ? 6 : 0)
    + (volumePassed ? 6 : 0)
    + histStrength;

  return {
    score: Number(Math.max(0, Math.min(100, score)).toFixed(1)),
    reasons: [
      red ? 'MACD红柱放大' : null,
      green ? 'MACD绿柱衰减' : null,
      trendPassed ? '趋势项' : null,
      fixedPassed ? '固定项' : null,
      volumePassed ? '量价项' : null,
    ].filter(Boolean),
  };
};

const shouldSell = (rows, index, active) => {
  const macdSell = indicatorChecks.redDecay(rows, index)
    || indicatorChecks.greenExpansion(rows, index)
    || indicatorChecks.macdWeak(rows, index);
  const trendSell = active.includes('trend_filter') && indicatorChecks.trendReverse(rows[index]);
  return {
    sell: macdSell || trendSell,
    reason: trendSell ? '趋势反向' : macdSell ? 'MACD核心反向' : '',
  };
};

const secidForCode = (code) => {
  const c = normalizeCode(code);
  return c.startsWith('6') ? `1.${c}` : `0.${c}`;
};

const resolvePythonBin = () => {
  const candidates = [
    process.env.QUANT_PYTHON_BIN,
    BUNDLED_PYTHON,
    'python3',
  ].filter(Boolean);
  return candidates.find((candidate) => !path.isAbsolute(candidate) || fs.existsSync(candidate)) || 'python3';
};

const runProcess = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: ROOT });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve({ stdout, stderr });
    } else {
      reject(new Error(stderr || stdout || `${command} exited with ${code}`));
    }
  });
});

async function generateQuantBacktestReport(result, context = {}) {
  const now = new Date();
  const stageId = context.stage?.id || result.strategy?.activeIndicators?.slice(-1)?.[0] || 'stage';
  const filename = `quant-loop-${safeFilePart(result.strategy?.version)}-${safeFilePart(stageId)}-${compactTimestamp(now)}-${safeFilePart(context.attemptId || now.getTime())}.pdf`;
  const outputPath = path.join(REPORT_OUTPUT_DIR, filename);
  const inputPath = path.join(REPORT_TMP_DIR, `${filename}.json`);
  const payload = {
    generatedAt: now.toISOString(),
    context,
    result,
  };

  writeJson(inputPath, payload);
  try {
    await runProcess(resolvePythonBin(), [REPORT_SCRIPT, inputPath, outputPath]);
  } finally {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // temp cleanup is best-effort
    }
  }

  return {
    path: outputPath,
    relativePath: path.relative(ROOT, outputPath),
    createdAt: now.toISOString(),
  };
}

const parseEastmoneyKline = (line) => {
  const parts = String(line || '').split(',');
  if (parts.length < 11) return null;
  return {
    date: parts[0].replace(/-/g, ''),
    open: toNumber(parts[1]),
    close: toNumber(parts[2]),
    high: toNumber(parts[3]),
    low: toNumber(parts[4]),
    volume: toNumber(parts[5]),
    amount: toNumber(parts[6]),
    amplitude: toNumber(parts[7]),
    pct_chg: toNumber(parts[8]),
    chg: toNumber(parts[9]),
    turnover_rate: toNumber(parts[10]),
  };
};

const parseTencentKline = (row) => {
  if (!Array.isArray(row) || row.length < 6) return null;
  return {
    date: isoToYmd(row[0]),
    open: toNumber(row[1]),
    close: toNumber(row[2]),
    high: toNumber(row[3]),
    low: toNumber(row[4]),
    volume: toNumber(row[5]),
    amount: null,
    amplitude: null,
    pct_chg: null,
    chg: null,
    turnover_rate: null,
  };
};

const tencentSymbolForCode = (code) => {
  const normalized = normalizeCode(code);
  if (normalized === '000300') return BENCHMARK_TENCENT_SYMBOL;
  return `${normalized.startsWith('6') ? 'sh' : 'sz'}${normalized}`;
};

async function fetchEastmoneyDaily(secid, beg = BACKTEST_START, end = '20500101', options = {}) {
  const timeoutMs = Math.max(5000, Math.min(Number(options.timeoutMs) || 30000, 120000));
  const params = new URLSearchParams({
    secid,
    klt: '101',
    fqt: '1',
    beg,
    end,
    ut: 'fa5fd1943c7b386f172d6893dbfba10b',
    lmt: '1000000',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
  });
  const hosts = [
    'https://push2his.eastmoney.com',
    'https://1.push2his.eastmoney.com',
    'https://2.push2his.eastmoney.com',
    'https://33.push2his.eastmoney.com',
    'https://53.push2his.eastmoney.com',
    'https://72.push2his.eastmoney.com',
    'https://84.push2his.eastmoney.com',
  ];
  let lastError = null;
  for (const host of hosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${host}/api/qt/stock/kline/get?${params.toString()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`${host} HTTP ${resp.status}`);
      }
      const payload = await resp.json();
      const data = payload?.data || {};
      const rows = (data.klines || []).map(parseEastmoneyKline).filter(Boolean);
      if (rows.length) return { name: data.name || '', rows };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError?.message || 'Eastmoney daily kline failed');
}

async function fetchTencentDaily(symbol, beg = BACKTEST_START, end = todayYmd(), options = {}) {
  const timeoutMs = Math.max(5000, Math.min(Number(options.timeoutMs) || 30000, 120000));
  const ranges = buildDateRanges(beg, end === '20500101' ? todayYmd() : end, 24);
  const byDate = new Map();
  let lastError = null;

  const rangeResults = await mapWithConcurrency(ranges, 4, async ([rangeStart, rangeEnd]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const param = `${symbol},day,${rangeStart},${rangeEnd},640,qfq`;
    try {
      const resp = await fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: 'https://gu.qq.com/',
        },
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`Tencent HTTP ${resp.status}`);
      }
      const payload = await resp.json();
      const data = payload?.data?.[symbol] || {};
      const rows = (data.qfqday || data.day || []).map(parseTencentKline).filter((row) => row?.date);
      if (payload?.msg && !rows.length) {
        throw new Error(`Tencent ${payload.msg}`);
      }
      return { rows };
    } catch (error) {
      lastError = error;
      return { rows: [], error };
    } finally {
      clearTimeout(timer);
    }
  });

  for (const result of rangeResults) {
    for (const row of result.rows || []) {
      byDate.set(row.date, row);
    }
  }

  const rows = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) {
    throw new Error(lastError?.message || 'Tencent daily kline failed');
  }
  return {
    source: 'tencent',
    name: '',
    rows,
  };
}

async function fetchDailyKline(code, beg = BACKTEST_START, end = '20500101', options = {}) {
  if (options.source === 'tencent') {
    return fetchTencentDaily(tencentSymbolForCode(code), beg, end, options);
  }
  if (options.source === 'eastmoney') {
    const eastmoney = await fetchEastmoneyDaily(secidForCode(code), beg, end, options);
    return {
      ...eastmoney,
      source: 'eastmoney',
    };
  }
  try {
    const eastmoney = await fetchEastmoneyDaily(secidForCode(code), beg, end, options);
    return {
      ...eastmoney,
      source: 'eastmoney',
    };
  } catch (eastmoneyError) {
    const tencent = await fetchTencentDaily(tencentSymbolForCode(code), beg, end, options);
    return {
      ...tencent,
      fallbackFrom: 'eastmoney',
      fallbackError: eastmoneyError.message,
    };
  }
}

async function loadBenchmarkRows() {
  const cached = readJson(BENCHMARK_FILE, null);
  if (cached?.rows?.length) return enrichRows(cached.rows);

  let fetched;
  try {
    fetched = {
      ...(await fetchEastmoneyDaily(BENCHMARK_SECID, BACKTEST_START)),
      source: 'eastmoney',
    };
  } catch {
    fetched = await fetchTencentDaily(BENCHMARK_TENCENT_SYMBOL, BACKTEST_START);
  }
  const payload = {
    source: fetched.source || 'eastmoney',
    code: '000300',
    name: fetched.name || BENCHMARK_NAME,
    secid: BENCHMARK_SECID,
    symbol: BENCHMARK_TENCENT_SYMBOL,
    updatedAt: new Date().toISOString(),
    rows: fetched.rows,
  };
  writeJson(BENCHMARK_FILE, payload);
  return enrichRows(payload.rows);
}

function loadUniverse() {
  const payload = readJson(UNIVERSE_FILE, { stocks: [] });
  return (payload.stocks || [])
    .map((stock) => ({ code: normalizeCode(stock.code), name: String(stock.name || '').trim() }))
    .filter((stock) => stock.code && !isNorthExchangeCode(stock.code) && !isStName(stock.name));
}

export function migrateLegacyKlineCache(options = {}) {
  const force = Boolean(options.force);
  const existing = loadKlineManifest();
  if (!force && Object.keys(existing.stocks || {}).length > 0) {
    return {
      skipped: true,
      reason: 'manifest_exists',
      stockCount: Object.keys(existing.stocks || {}).length,
      manifestPath: KLINE_MANIFEST_FILE,
    };
  }

  const legacy = readJson(KLINE_CACHE_FILE, { stocks: {}, failures: {} });
  const manifest = {
    source: 'quant-kline-manifest',
    stocks: {},
    failures: legacy.failures || {},
    legacyMigratedAt: new Date().toISOString(),
  };

  let migrated = 0;
  for (const [rawCode, item] of Object.entries(legacy.stocks || {})) {
    const code = normalizeCode(rawCode);
    const rows = Array.isArray(item?.rows) ? item.rows : [];
    const summary = summarizeKlineRows(rows);
    writeStoredKline(code, {
      source: 'eastmoney',
      code,
      name: item?.name || '',
      updatedAt: legacy.updatedAt || new Date().toISOString(),
      rows,
    });
    manifest.stocks[code] = {
      code,
      name: item?.name || '',
      source: 'eastmoney',
      updatedAt: legacy.updatedAt || new Date().toISOString(),
      ...summary,
    };
    migrated += 1;
  }

  writeKlineManifest(manifest);
  clearQuantMemo();
  return {
    skipped: false,
    migrated,
    failures: Object.keys(manifest.failures || {}).length,
    manifestPath: KLINE_MANIFEST_FILE,
    storeDir: KLINE_STORE_DIR,
  };
}

export function rebuildKlineManifestFromStore() {
  const existing = loadKlineManifest();
  const manifest = {
    source: 'quant-kline-manifest',
    stocks: {},
    failures: existing.failures || {},
    legacyMigratedAt: existing.legacyMigratedAt || null,
    sourceHealth: existing.sourceHealth || {},
  };

  let rebuilt = 0;
  for (const file of listFilesRecursive(KLINE_STORE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const payload = readJson(file, null);
    const code = normalizeCode(payload?.code || path.basename(file, '.json'));
    if (!payload?.rows?.length) continue;
    manifest.stocks[code] = {
      code,
      name: payload.name || '',
      source: payload.source || 'eastmoney',
      updatedAt: payload.updatedAt || new Date().toISOString(),
      ...summarizeKlineRows(payload.rows),
    };
    rebuilt += 1;
  }

  writeKlineManifest(manifest);
  clearQuantMemo();
  return {
    rebuilt,
    failures: Object.keys(manifest.failures || {}).length,
    manifestPath: KLINE_MANIFEST_FILE,
    storeDir: KLINE_STORE_DIR,
  };
}

function ensureKlineStore() {
  const manifest = loadKlineManifest();
  if (Object.keys(manifest.stocks || {}).length > 0) return manifest;
  if (fs.existsSync(KLINE_CACHE_FILE)) {
    migrateLegacyKlineCache();
    return loadKlineManifest();
  }
  return manifest;
}

function getKlineStoreSignature() {
  if (fs.existsSync(KLINE_MANIFEST_FILE)) {
    return `manifest:${fs.statSync(KLINE_MANIFEST_FILE).mtimeMs}`;
  }
  return `legacy:${fs.existsSync(KLINE_CACHE_FILE) ? fs.statSync(KLINE_CACHE_FILE).mtimeMs : 0}`;
}

function loadStoredStockEntries() {
  const manifest = ensureKlineStore();
  const entries = Object.entries(manifest.stocks || {});
  if (entries.length > 0) {
    return entries
      .map(([code, record]) => {
        const payload = readStoredKline(code);
        return payload?.rows?.length ? [code, { ...payload, ...record, rows: payload.rows }] : null;
      })
      .filter(Boolean);
  }

  const legacy = readJson(KLINE_CACHE_FILE, { stocks: {} });
  return Object.entries(legacy.stocks || {});
}

function buildStockDataset() {
  if (datasetMemo && Date.now() - datasetMemo.createdAt < DATASET_MEMO_TTL_MS) {
    return datasetMemo.value;
  }
  let prof = profileLog('buildStockDataset start');
  const universe = loadUniverse();
  const manifest = ensureKlineStore();
  const exclusions = manifest.exclusions || {};
  const universeByCode = new Map(universe.map((stock) => [stock.code, stock]));
  const stocks = [];
  const entries = Object.keys(manifest.stocks || {}).length > 0
    ? Object.entries(manifest.stocks || {})
    : loadStoredStockEntries();

  for (const [entryIndex, [rawCode, record]] of entries.entries()) {
    if (profileEnabled() && entryIndex > 0 && entryIndex % 500 === 0) {
      prof = profileLog(`buildStockDataset processed ${entryIndex}/${entries.length}`, prof);
    }
    const code = normalizeCode(rawCode);
    if (exclusions[code]) continue;
    const universeStock = universeByCode.get(code);
    const payload = record?.rows?.length ? record : readStoredKline(code);
    const name = payload?.name || record?.name || universeStock?.name || '';
    if (!universeStock || isNorthExchangeCode(code) || isStName(name)) continue;
    if (record?.shortHistory || record?.usable === false) continue;
    const rows = enrichRows(payload?.rows || []);
    const firstDate = rows[0]?.date;
    if (!firstDate) continue;
    const oneYearAfterListing = oneYearAfter(firstDate);
    stocks.push({
      code,
      name,
      rows,
      firstEligibleDate: oneYearAfterListing,
    });
  }

  const value = { universe, stocks };
  datasetMemo = { createdAt: Date.now(), value };
  profileLog(`buildStockDataset done stocks=${stocks.length}`, prof);
  return value;
}

function lookupStockRows(stock, signalDate, execDate) {
  const rows = stock.rows || [];
  let cursor = Number.isInteger(stock._cursor) ? stock._cursor : 0;
  while (cursor < rows.length && rows[cursor].date < signalDate) {
    cursor += 1;
  }
  stock._cursor = cursor;

  const signalIndex = rows[cursor]?.date === signalDate ? cursor : null;
  let execIndex = null;
  if (signalIndex != null && rows[signalIndex + 1]?.date === execDate) {
    execIndex = signalIndex + 1;
  } else if (rows[cursor]?.date === execDate) {
    execIndex = cursor;
  } else if (rows[cursor + 1]?.date === execDate) {
    execIndex = cursor + 1;
  }

  return {
    signalIndex,
    execRow: execIndex == null ? null : rows[execIndex],
  };
}

function buildBenchmarkNextDateMap(benchmarkDates) {
  const nextDate = new Map();
  for (let index = 1; index < benchmarkDates.length; index += 1) {
    nextDate.set(benchmarkDates[index - 1], benchmarkDates[index]);
  }
  return nextDate;
}

function buildBuyCandidatesBySignalDate(stocks, benchmarkNextDate, active, params) {
  const candidatesByDate = new Map();
  for (const stock of stocks) {
    const rows = stock.rows || [];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const signalDate = rows[index].date;
      if (signalDate < stock.firstEligibleDate) continue;
      const execDate = benchmarkNextDate.get(signalDate);
      if (!execDate) continue;
      const execRow = rows[index + 1];
      if (execRow?.date !== execDate || !execRow.open) continue;
      const signal = scoreSignal(rows, index, active, params);
      if (!signal) continue;
      if (!candidatesByDate.has(signalDate)) candidatesByDate.set(signalDate, []);
      candidatesByDate.get(signalDate).push({ stock, signal, execRow });
    }
  }
  return candidatesByDate;
}

function getDataStatus() {
  if (dataStatusMemo && Date.now() - dataStatusMemo.createdAt < DATASET_MEMO_TTL_MS) {
    return dataStatusMemo.value;
  }
  const storeSignature = getKlineStoreSignature();
  const cachedStatus = readJson(DATA_STATUS_FILE, null);
  if (
    cachedStatus?.klineStoreSignature === storeSignature
    && cachedStatus?.schemaVersion === DATA_STATUS_SCHEMA_VERSION
    && cachedStatus?.dataStatus
    && cachedStatus.dataStatus.requiredCoverage === REQUIRED_COVERAGE
  ) {
    dataStatusMemo = { createdAt: Date.now(), value: cachedStatus.dataStatus };
    return cachedStatus.dataStatus;
  }
  const universe = loadUniverse();
  const manifest = ensureKlineStore();
  const exclusions = manifest.exclusions || {};
  let shortHistoryStockCount = 0;
  let excludedStockCount = 0;
  let cachedEligible = 0;
  let unresolvedFailureCount = 0;

  for (const stock of universe) {
    const record = manifest.stocks?.[stock.code];
    if (exclusions[stock.code]) {
      excludedStockCount += 1;
      continue;
    }
    if (record?.shortHistory) {
      shortHistoryStockCount += 1;
      continue;
    }
    if (record?.usable) {
      cachedEligible += 1;
    }
    if (!record?.usable && !record?.shortHistory && manifest.failures?.[stock.code]) {
      unresolvedFailureCount += 1;
    }
  }

  const eligibleUniverseCount = Math.max(0, universe.length - shortHistoryStockCount - excludedStockCount);
  const coverage = eligibleUniverseCount ? cachedEligible / eligibleUniverseCount : 0;
  const missingStockCount = Math.max(0, eligibleUniverseCount - cachedEligible);
  const readyForFullMarketBacktest = eligibleUniverseCount > 0 && missingStockCount === 0;
  const value = {
    universeCount: universe.length,
    eligibleUniverseCount,
    shortHistoryStockCount,
    excludedStockCount,
    cachedStockCount: cachedEligible,
    missingStockCount,
    failureCount: unresolvedFailureCount,
    coverage: pct(coverage),
    requiredCoverage: REQUIRED_COVERAGE,
    readyForFullMarketBacktest,
    startDate: BACKTEST_START,
    benchmark: BENCHMARK_NAME,
  };
  writeJson(DATA_STATUS_FILE, {
    source: 'quant-data-status',
    schemaVersion: DATA_STATUS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    klineStoreSignature: storeSignature,
    dataStatus: value,
  });
  dataStatusMemo = { createdAt: Date.now(), value };
  return value;
}

function fullMarketCoverageMessage(dataStatus) {
  return [
    '正式量化选股回测必须使用全A可交易股票池。',
    `当前历史日线覆盖 ${dataStatus.cachedStockCount}/${dataStatus.eligibleUniverseCount}，缺口 ${dataStatus.missingStockCount} 只。`,
    '覆盖率达到 100% 前不运行回测，也不生成回测 PDF。',
  ].join(' ');
}

function buildCoverageBlockedBacktest({ stageIndex, active, params, stage, dataStatus }) {
  const activeIndicatorLabels = active.map((id) => LOOP_SEQUENCE.find((item) => item.id === id)?.label || id);
  return {
    generatedAt: new Date().toISOString(),
    blocked: true,
    blockReason: 'dataCoverage',
    message: fullMarketCoverageMessage(dataStatus),
    strategy: {
      version: `loop-v${stageIndex + 1}`,
      activeIndicators: active,
      activeIndicatorLabels,
      params,
      gates: HARD_GATES,
    },
    dataStatus,
    metrics: {
      passed: false,
      dataCoverage: dataStatus.coverage,
      gateResults: {
        sharpe: false,
        calmar: false,
        maxDrawdown: false,
        rolling13WeekAvgOpenings: false,
        dataCoverage: false,
      },
      failedReasons: ['dataCoverage'],
    },
    trades: [],
    latestSignals: [],
    equityCurve: [],
    benchmarkCurve: [],
    report: null,
    reportError: null,
    nextAction: '先回补全A历史日线到100%，再启动正式 loop 回测',
    stage,
  };
}

function isFullMarketExperiment(experiment) {
  const metrics = experiment?.metrics || {};
  return metrics.gateResults?.dataCoverage === true && Number(metrics.dataCoverage) >= REQUIRED_COVERAGE;
}

function getLatestFullMarketExperiment(experimentsPayload) {
  return (experimentsPayload.experiments || []).find(isFullMarketExperiment) || null;
}

const weekKey = (date) => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6)) - 1;
  const d = Number(date.slice(6, 8));
  const utc = Date.UTC(y, m, d);
  const first = Date.UTC(y, 0, 1);
  const day = Math.floor((utc - first) / 86400000) + 1;
  const week = Math.ceil(day / 7);
  return `${y}-${String(week).padStart(2, '0')}`;
};

function calculateRolling13WeekStats(weeklyCounts, allWeekKeys = []) {
  const weeks = Array.from(new Set([...allWeekKeys, ...weeklyCounts.keys()])).sort();
  if (weeks.length < 13) return { average: 0, min: 0, latest: 0 };
  const avgs = [];
  for (let i = 12; i < weeks.length; i += 1) {
    const slice = weeks.slice(i - 12, i + 1);
    avgs.push(mean(slice.map((week) => weeklyCounts.get(week) || 0)));
  }
  return {
    average: mean(avgs),
    min: Math.min(...avgs),
    latest: avgs[avgs.length - 1] || 0,
  };
}

function calculateRolling13WeekMin(weeklyCounts, allWeekKeys = []) {
  return calculateRolling13WeekStats(weeklyCounts, allWeekKeys).min;
}

function calculateMetrics(equityCurve, benchmarkCurve, trades, weeklyOpenings, dataStatus) {
  const returns = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1].equity;
    const current = equityCurve[i].equity;
    if (prev > 0) returns.push(current / prev - 1);
  }
  const tradingDays = Math.max(1, returns.length);
  const startEquity = equityCurve[0]?.equity || 1;
  const endEquity = equityCurve[equityCurve.length - 1]?.equity || startEquity;
  const annualReturn = endEquity > 0 ? (endEquity / startEquity) ** (252 / tradingDays) - 1 : 0;
  const volatility = stddev(returns) * Math.sqrt(252);
  const sharpe = volatility > 0 ? annualReturn / volatility : 0;

  let peak = startEquity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, 1 - point.equity / peak);
  }
  const calmar = maxDrawdown > 0 ? annualReturn / maxDrawdown : 0;

  const benchmarkStart = benchmarkCurve[0]?.equity || 1;
  const benchmarkEnd = benchmarkCurve[benchmarkCurve.length - 1]?.equity || benchmarkStart;
  const benchmarkAnnualReturn = benchmarkEnd > 0 ? (benchmarkEnd / benchmarkStart) ** (252 / tradingDays) - 1 : 0;
  const allWeekKeys = equityCurve.map((point) => weekKey(point.date));
  const rolling13WeekOpenings = calculateRolling13WeekStats(weeklyOpenings, allWeekKeys);

  const metrics = {
    annualReturn: pct(annualReturn),
    benchmarkAnnualReturn: pct(benchmarkAnnualReturn),
    excessAnnualReturn: pct(annualReturn - benchmarkAnnualReturn),
    volatility: pct(volatility),
    sharpe: pct(sharpe),
    calmar: pct(calmar),
    maxDrawdown: pct(maxDrawdown),
    tradeCount: trades.length,
    winRate: pct(trades.length ? trades.filter((trade) => trade.returnPct > 0).length / trades.length : 0),
    rolling13WeekAvgOpenings: pct(rolling13WeekOpenings.average),
    minRolling13WeekOpenings: pct(rolling13WeekOpenings.min),
    latestRolling13WeekOpenings: pct(rolling13WeekOpenings.latest),
    startDate: equityCurve[0]?.date || BACKTEST_START,
    endDate: equityCurve[equityCurve.length - 1]?.date || null,
    dataCoverage: dataStatus.coverage,
  };

  const gateResults = {
    sharpe: metrics.sharpe >= HARD_GATES.sharpe,
    calmar: metrics.calmar >= HARD_GATES.calmar,
    maxDrawdown: metrics.maxDrawdown <= HARD_GATES.maxDrawdown,
    rolling13WeekAvgOpenings: metrics.rolling13WeekAvgOpenings >= HARD_GATES.rolling13WeekAvgOpenings,
    dataCoverage: dataStatus.readyForFullMarketBacktest,
  };
  const passed = Object.values(gateResults).every(Boolean);

  return {
    ...metrics,
    gateResults,
    passed,
    failedReasons: Object.entries(gateResults)
      .filter(([, ok]) => !ok)
      .map(([key]) => key),
  };
}

export async function runQuantBacktest(options = {}) {
  let prof = profileLog(`runQuantBacktest start stage=${options.stageIndex ?? 0}`);
  const stageIndex = Number.isInteger(options.stageIndex) ? options.stageIndex : 0;
  const active = options.activeIndicators || activeIndicatorsForStage(stageIndex);
  const params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
  const stage = LOOP_SEQUENCE[stageIndex] || LOOP_SEQUENCE[0];
  const dataStatus = getDataStatus();
  if (!options.allowPartialBacktestForDebug && !dataStatus.readyForFullMarketBacktest) {
    return buildCoverageBlockedBacktest({ stageIndex, active, params, stage, dataStatus });
  }
  const { stocks } = buildStockDataset();
  prof = profileLog(`dataset ready stocks=${stocks.length}`, prof);
  for (const stock of stocks) {
    stock._cursor = 0;
  }
  const benchmarkRows = await loadBenchmarkRows();
  const benchmarkDates = benchmarkRows.map((row) => row.date).filter((date) => date >= BACKTEST_START);
  prof = profileLog(`benchmark ready dates=${benchmarkDates.length}`, prof);
  const benchmarkNextDate = buildBenchmarkNextDateMap(benchmarkDates);
  const buyCandidatesByDate = buildBuyCandidatesBySignalDate(stocks, benchmarkNextDate, active, params);
  const candidateCount = Array.from(buyCandidatesByDate.values()).reduce((sum, items) => sum + items.length, 0);
  prof = profileLog(`buy candidates ready dates=${buyCandidatesByDate.size} count=${candidateCount}`, prof);
  const benchmarkByDate = buildIndex(benchmarkRows);

  const cashFloor = 0.000001;
  let cash = 1;
  const positions = new Map();
  const trades = [];
  const equityCurve = [];
  const benchmarkCurve = [];
  const weeklyOpenings = new Map();
  let lastEquity = 1;

  for (let i = 1; i < benchmarkDates.length; i += 1) {
    const signalDate = benchmarkDates[i - 1];
    const execDate = benchmarkDates[i];

    for (const [code, position] of Array.from(positions.entries())) {
      const stock = position.stock;
      const { signalIndex, execRow } = lookupStockRows(stock, signalDate, execDate);
      if (signalIndex == null || !execRow?.open) continue;
      const sellSignal = shouldSell(stock.rows, signalIndex, active);
      if (!sellSignal.sell) continue;
      const exitValue = position.shares * execRow.open * (1 - params.tradeCost);
      cash += exitValue;
      const returnPct = exitValue / position.cost - 1;
      trades.push({
        code,
        name: stock.name,
        entryDate: position.entryDate,
        exitDate: execDate,
        entryPrice: position.entryPrice,
        exitPrice: execRow.open,
        returnPct,
        reason: sellSignal.reason,
      });
      positions.delete(code);
    }

    const availableSlots = Math.max(0, params.maxPositions - positions.size);
    if (availableSlots > 0 && cash > cashFloor) {
      const candidates = (buyCandidatesByDate.get(signalDate) || [])
        .filter((candidate) => !positions.has(candidate.stock.code));
      candidates.sort((a, b) => b.signal.score - a.signal.score);
      const buys = candidates.slice(0, availableSlots);
      const budgetPerBuy = buys.length ? cash / buys.length : 0;
      for (const candidate of buys) {
        if (budgetPerBuy <= cashFloor || cash < budgetPerBuy) continue;
        const gross = budgetPerBuy;
        const net = gross * (1 - params.tradeCost);
        const shares = net / candidate.execRow.open;
        cash -= gross;
        positions.set(candidate.stock.code, {
          stock: candidate.stock,
          shares,
          cost: gross,
          entryDate: execDate,
          entryPrice: candidate.execRow.open,
          reasons: candidate.signal.reasons,
          score: candidate.signal.score,
        });
        const key = weekKey(execDate);
        weeklyOpenings.set(key, (weeklyOpenings.get(key) || 0) + 1);
      }
    }

    let positionValue = 0;
    for (const position of positions.values()) {
      const mark = lookupStockRows(position.stock, signalDate, execDate).execRow?.close || position.entryPrice;
      positionValue += position.shares * mark;
    }
    const equity = cash + positionValue;
    lastEquity = equity || lastEquity;
    equityCurve.push({ date: execDate, equity: lastEquity, positions: positions.size });

    const benchmarkStart = benchmarkByDate.get(benchmarkDates[0])?.row?.close || 1;
    const benchmarkClose = benchmarkByDate.get(execDate)?.row?.close || benchmarkStart;
    benchmarkCurve.push({ date: execDate, equity: benchmarkClose / benchmarkStart });
  }
  prof = profileLog(`portfolio simulation done trades=${trades.length}`, prof);

  const metrics = calculateMetrics(equityCurve, benchmarkCurve, trades, weeklyOpenings, dataStatus);
  prof = profileLog(`metrics calculated passed=${metrics.passed}`, prof);
  const activeIndicatorLabels = active.map((id) => LOOP_SEQUENCE.find((item) => item.id === id)?.label || id);
  const reportContext = {
    round: stageIndex + 1,
    stage,
    change: options.loopContext?.change || `验证 ${stage?.label || '当前指标'}`,
    why: options.loopContext?.why || '按固定 Loop Sequence 运行当前阶段',
    addedIndicators: options.loopContext?.addedIndicators ?? [stage?.label].filter(Boolean),
    removedIndicators: options.loopContext?.removedIndicators ?? [],
    nextAction: metrics.passed
      ? (stageIndex < LOOP_SEQUENCE.length - 1 ? '进入下一指标' : '全部指标通过，形成候选策略')
      : '未通过硬约束，loop back 微调当前指标',
    attemptId: options.loopContext?.attemptId,
  };
  const result = {
    generatedAt: new Date().toISOString(),
    strategy: {
      version: `loop-v${stageIndex + 1}`,
      activeIndicators: active,
      activeIndicatorLabels,
      params,
      gates: HARD_GATES,
    },
    dataStatus,
    metrics,
    trades: trades.slice(-200),
    latestSignals: options.includeSignals ? getLatestSignals({ active, params }).slice(0, 50) : [],
    equityCurve: equityCurve.filter((_, index) => index % 20 === 0).slice(-240),
    benchmarkCurve: benchmarkCurve.filter((_, index) => index % 20 === 0).slice(-240),
  };

  if (options.writeReport !== false) {
    try {
      result.report = await generateQuantBacktestReport(result, reportContext);
      profileLog(`report generated ${result.report.relativePath}`, prof);
    } catch (error) {
      result.reportError = error.message;
    }
  }

  return result;
}

function currentStageCandidates(stageIndex, params) {
  const stageId = LOOP_SEQUENCE[stageIndex]?.id;
  if (stageId === 'red_expansion') {
    return [
      { label: '默认 3+3 / 6日', params },
      { label: '缩短为 2+3', params: { ...params, redFrontDown: 2, redBackUp: 3 } },
      { label: '缩短为 3+2', params: { ...params, redFrontDown: 3, redBackUp: 2 } },
      { label: '延长为 4+3', params: { ...params, redFrontDown: 4, redBackUp: 3 } },
    ];
  }
  if (stageId === 'green_decay') {
    return [
      { label: '绿柱衰减3日 / 红转绿5日', params },
      { label: '绿柱衰减4日', params: { ...params, greenDecayWindow: 4 } },
      { label: '红转绿8日', params: { ...params, redToGreenLookback: 8 } },
    ];
  }
  if (stageId === 'trend_filter') {
    return [
      { label: '趋势 5/10/20', params: { ...params, trendMode: '5/10/20' } },
      { label: '趋势 5/20', params: { ...params, trendMode: '5/20' } },
      { label: '趋势 10/20', params: { ...params, trendMode: '10/20' } },
    ];
  }
  if (stageId === 'volume_filter') {
    return [
      { label: '成交量5日', params: { ...params, volumeMa: 5 } },
      { label: '成交量10日', params: { ...params, volumeMa: 10 } },
    ];
  }
  return [{ label: '默认参数', params }];
}

export async function runQuantIteration() {
  const experiments = readJson(EXPERIMENTS_FILE, { source: 'quant-macd-loop', experiments: [] });
  const dataStatus = getDataStatus();
  if (!dataStatus.readyForFullMarketBacktest) {
    return {
      generatedAt: new Date().toISOString(),
      blocked: true,
      blockReason: 'dataCoverage',
      message: fullMarketCoverageMessage(dataStatus),
      attempts: [],
      lastPassed: null,
      blockedAt: {
        id: 'dataCoverage',
        label: '全A历史数据覆盖不足',
      },
      dataStatus,
      latestFullMarketExperiment: getLatestFullMarketExperiment(experiments),
      nextAction: '先运行全A历史日线回补，覆盖率达到100%后再重新启动 loop',
    };
  }
  const attempts = [];
  let params = { ...DEFAULT_PARAMS };
  let lastPassed = null;

  for (let stageIndex = 0; stageIndex < LOOP_SEQUENCE.length; stageIndex += 1) {
    const candidates = currentStageCandidates(stageIndex, params);
    let passed = null;
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const result = await runQuantBacktest({
        stageIndex,
        activeIndicators: activeIndicatorsForStage(stageIndex),
        params: candidate.params,
        loopContext: {
          round: stageIndex + 1,
          stage: LOOP_SEQUENCE[stageIndex],
          change: candidate.label,
          why: candidateIndex === 0
            ? `按顺序验证新指标 ${LOOP_SEQUENCE[stageIndex].label}`
            : '上一轮未通过硬约束，在限定范围内微调当前指标',
          addedIndicators: candidateIndex === 0 ? [LOOP_SEQUENCE[stageIndex].label] : [],
          removedIndicators: [],
          attemptId: `${stageIndex}-${candidateIndex}`,
        },
      });
      const attempt = {
        id: `${Date.now()}-${stageIndex}-${attempts.length}`,
        createdAt: new Date().toISOString(),
        stageIndex,
        stage: LOOP_SEQUENCE[stageIndex],
        change: candidate.label,
        params: candidate.params,
        metrics: result.metrics,
        passed: result.metrics.passed,
        report: result.report || null,
        reportError: result.reportError || null,
        nextAction: result.metrics.passed ? '进入下一指标' : 'loop back 微调当前指标',
      };
      attempts.push(attempt);
      if (result.metrics.passed) {
        passed = attempt;
        params = candidate.params;
        break;
      }
    }
    if (!passed) {
      lastPassed = null;
      break;
    }
    lastPassed = passed;
  }

  const payload = {
    source: 'quant-macd-loop',
    updatedAt: new Date().toISOString(),
    experiments: [...attempts.slice().reverse(), ...(experiments.experiments || [])].slice(0, 100),
  };
  writeJson(EXPERIMENTS_FILE, payload);

  return {
    generatedAt: payload.updatedAt,
    attempts,
    lastPassed,
    blockedAt: attempts.find((attempt) => !attempt.passed)?.stage || null,
    dataStatus: getDataStatus(),
  };
}

export function getQuantExperiments() {
  return readJson(EXPERIMENTS_FILE, { source: 'quant-macd-loop', experiments: [] });
}

export async function runQuantHistoryBackfill(options = {}) {
  if (quantBackfillInFlight) return quantBackfillInFlight;
  const maxCodes = Math.max(1, Math.min(Number(options.maxCodes) || 5, 1000));
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 12));
  const delay = Math.max(0, Math.min(Number(options.delay ?? 2), 10));
  const timeoutMs = Math.max(5000, Math.min(Number(options.timeoutMs) || 30000, 120000));
  const source = ['auto', 'eastmoney', 'tencent'].includes(options.source) ? options.source : 'tencent';
  const retryFailures = Boolean(options.retryFailures);
  const failureCooldownHours = Math.max(0, Math.min(Number(options.failureCooldownHours ?? 24), 168));
  const before = getDataStatus();

  quantBackfillInFlight = (async () => {
    const universe = loadUniverse();
    const manifest = ensureKlineStore();
    manifest.stocks = manifest.stocks || {};
    manifest.failures = manifest.failures || {};
    const nowSec = Date.now() / 1000;
    const cooldownSec = failureCooldownHours * 3600;
    const totalIncomplete = universe.filter((stock) => {
      const record = manifest.stocks?.[stock.code];
      return !record?.usable && !record?.shortHistory;
    }).length;

	    const pending = universe
	      .filter((stock) => {
	        if (manifest.exclusions?.[stock.code]) return false;
	        const record = manifest.stocks?.[stock.code];
        if (record?.usable || record?.shortHistory) return false;
        const failureAt = Number(manifest.failures?.[stock.code]?.at || 0);
        const isRecentFailure = failureAt > 0 && cooldownSec > 0 && nowSec - failureAt < cooldownSec;
        return retryFailures || !isRecentFailure;
      })
      .slice(0, maxCodes);

    const fetched = [];
    const failed = [];

    await mapWithConcurrency(pending, concurrency, async (stock, index) => {
      try {
        const result = await fetchDailyKline(stock.code, BACKTEST_START, '20500101', { timeoutMs, source });
        if (!result.rows?.length) {
          throw new Error('empty kline rows');
        }
        const name = result.name || stock.name;
        const storedPayload = {
          source: result.source || 'eastmoney',
          code: stock.code,
          name,
          updatedAt: new Date().toISOString(),
          fallbackFrom: result.fallbackFrom || null,
          fallbackError: result.fallbackError || null,
          rows: result.rows,
        };
        writeStoredKline(stock.code, storedPayload);
        manifest.stocks[stock.code] = {
          code: stock.code,
          name,
          source: storedPayload.source,
          updatedAt: storedPayload.updatedAt,
          fallbackFrom: storedPayload.fallbackFrom,
          ...summarizeKlineRows(result.rows),
        };
        delete manifest.failures[stock.code];
        fetched.push({
          code: stock.code,
          name: result.name || stock.name,
          rows: result.rows.length,
          usable: manifest.stocks[stock.code].usable,
          shortHistory: manifest.stocks[stock.code].shortHistory,
        });
        writeKlineManifest(manifest);
      } catch (error) {
        manifest.failures[stock.code] = {
          at: Date.now() / 1000,
          error: error.message,
          source: 'quant_history_backfill',
        };
        failed.push({ code: stock.code, name: stock.name, error: error.message });
        writeKlineManifest(manifest);
      }
      if (delay > 0 && index < pending.length - 1) {
        await sleep(delay * 1000);
      }
    });

    manifest.sourceHealth = {
      ...(manifest.sourceHealth || {}),
      quantHistoryBackfill: {
        ok: failed.length === 0,
        updatedAt: new Date().toISOString(),
        fetched: fetched.length,
        failed: failed.length,
        retryFailures,
        failureCooldownHours,
        source,
        concurrency,
      },
    };
    writeKlineManifest(manifest);
    clearQuantMemo();
    const after = getDataStatus();
    return {
      success: failed.length === 0,
      before,
      after,
      fetched,
      failed,
      pending: pending.length,
      skippedRecentFailures: Math.max(0, totalIncomplete - pending.length),
      totalIncomplete,
    };
  })().finally(() => {
    quantBackfillInFlight = null;
  });

  return quantBackfillInFlight;
}

export function getLatestSignals(options = {}) {
  const active = options.active || ['red_expansion'];
  const params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
  const { stocks } = buildStockDataset();
  const signals = [];
  for (const stock of stocks) {
    const rows = stock.rows;
    const index = rows.length - 1;
    if (index < 30) continue;
    const signal = scoreSignal(rows, index, active, params);
    if (!signal) continue;
    const row = rows[index];
    signals.push({
      code: stock.code,
      name: stock.name,
      date: row.date,
      close: row.close,
      score: signal.score,
      reasons: signal.reasons,
      dif: pct(row.dif),
      dea: pct(row.dea),
      hist: pct(row.hist),
      volume: row.volume,
    });
  }
  return signals.sort((a, b) => b.score - a.score);
}

export async function getQuantOverview(options = {}) {
  const experiments = getQuantExperiments();
  return {
    generatedAt: new Date().toISOString(),
    name: '量化选股',
    benchmark: BENCHMARK_NAME,
    startDate: BACKTEST_START,
    sequence: LOOP_SEQUENCE,
    gates: HARD_GATES,
    defaultParams: DEFAULT_PARAMS,
    dataStatus: getDataStatus(),
    latestSignals: options.includeSignals ? getLatestSignals().slice(0, 20) : [],
    latestExperiment: getLatestFullMarketExperiment(experiments),
  };
}

export const quantTestInternals = {
  calculateMetrics,
  calculateRolling13WeekStats,
  calculateRolling13WeekMin,
  scoreSignal,
  shouldSell,
  weekKey,
};
