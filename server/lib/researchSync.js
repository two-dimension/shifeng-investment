import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCninfoMarketDay } from './cninfoAnnouncements.js';
import { buildDirectCninfoSummary, buildPortfolioUniverse } from './announcementJudgement.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, '..');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_EXTENSIONS = new Set(['.xlsx', '.pdf']);
const CNINFO_QUERY_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
const CNINFO_PDF_PREFIX = 'http://static.cninfo.com.cn/';
const CNINFO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: 'http://www.cninfo.com.cn',
  Referer: 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
};

const RESEARCH_DIR = process.env.RESEARCH_DATA_DIR || path.join(SERVER_DIR, 'data/research');
const REPORTS_DIR = process.env.RESEARCH_REPORTS_DIR || path.join(SERVER_DIR, 'public/reports');
const RESEARCH_KINDS = ['cninfo', 'earnings', 'earnings-report', 'risk'];

function resolveEarningsReportRoot() {
  if (process.env.EARNINGS_REPORT_OUTPUT_DIR) return process.env.EARNINGS_REPORT_OUTPUT_DIR;
  const directRoot = '/Users/rayw/Documents/业绩报告';
  const hasDirectDateDirs = fs.existsSync(directRoot) && fs.readdirSync(directRoot, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name));
  if (hasDirectDateDirs) return directRoot;
  const nestedRoot = path.join(directRoot, '业绩报告');
  return fs.existsSync(nestedRoot) ? nestedRoot : directRoot;
}

const SOURCE_CONFIG = {
  cninfo: {
    root: process.env.CNINFO_OUTPUT_DIR || '/Users/rayw/Documents/巨潮资讯/output',
    reportDir: path.join(REPORTS_DIR, 'cninfo'),
  },
  earnings: {
    root: process.env.EARNINGS_OUTPUT_DIR || '/Users/rayw/Documents/业绩预告/业绩预告',
    reportDir: path.join(REPORTS_DIR, 'earnings'),
  },
  'earnings-report': {
    root: resolveEarningsReportRoot(),
    reportDir: path.join(REPORTS_DIR, 'earnings-report'),
  },
  risk: {
    root: process.env.RISK_OUTPUT_DIR || '/Users/rayw/Documents/风险提示/output',
    reportDir: path.join(REPORTS_DIR, 'risk'),
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function assertDate(date) {
  if (!DATE_RE.test(date || '')) {
    throw new Error('date must be YYYY-MM-DD');
  }
}

function assertKind(kind) {
  if (![...RESEARCH_KINDS, 'all'].includes(kind)) {
    throw new Error('kind must be cninfo, earnings, earnings-report, risk, or all');
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function sourceGeneratedAt(filePath) {
  return fs.statSync(filePath).mtime.toISOString();
}

function writeJsonAtomicIfChanged(filePath, data) {
  ensureDir(path.dirname(filePath));
  const next = JSON.stringify(data, null, 2);
  if (fs.existsSync(filePath)) {
    const prev = fs.readFileSync(filePath, 'utf-8');
    if (prev === next) return false;
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, next, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  return true;
}

function listDateDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DATE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function listProcessedFiles(dayDir) {
  const processedDir = path.join(dayDir, 'processed');
  if (!fs.existsSync(processedDir)) return [];
  return fs.readdirSync(processedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^processed_.*\.json$/.test(entry.name))
    .map((entry) => path.join(processedDir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function findCninfoProcessed(date) {
  const root = SOURCE_CONFIG.cninfo.root;
  const direct = listProcessedFiles(path.join(root, date))[0];
  if (direct) return direct;

  const matches = [];
  for (const dirDate of listDateDirs(root)) {
    for (const filePath of listProcessedFiles(path.join(root, dirDate))) {
      try {
        const data = readJson(filePath);
        const reportDate = data?.coverage?.report_date || data?.date;
        if (reportDate === date) {
          matches.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
        }
      } catch {
        // Ignore malformed historical files and report the selected file later.
      }
    }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.filePath || null;
}

function findRiskProcessed(date) {
  return listProcessedFiles(path.join(SOURCE_CONFIG.risk.root, date))[0] || null;
}

function isReportFile(entryName) {
  if (entryName.startsWith('~$')) return false;
  return REPORT_EXTENSIONS.has(path.extname(entryName).toLowerCase());
}

function hasReportFiles(kind, date) {
  const dayDir = path.join(SOURCE_CONFIG[kind].root, date);
  if (!fs.existsSync(dayDir)) return false;
  return fs.readdirSync(dayDir, { withFileTypes: true })
    .some((entry) => entry.isFile() && isReportFile(entry.name));
}

function isAutoSyncableDate(kind, date) {
  if (!hasReportFiles(kind, date)) return false;
  if (kind === 'cninfo') return Boolean(findCninfoProcessed(date));
  if (kind === 'risk') return Boolean(findRiskProcessed(date));
  return fs.existsSync(path.join(SOURCE_CONFIG[kind].root, date, 'input.json'));
}

function copyReports(kind, date, dayDir, force = false) {
  const targetDir = path.join(SOURCE_CONFIG[kind].reportDir, date);
  ensureDir(targetDir);

  const files = [];
  let copied = 0;
  let skipped = 0;

  if (!fs.existsSync(dayDir)) {
    return { files, copied, skipped };
  }

  const entries = fs.readdirSync(dayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isReportFile(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  for (const entry of entries) {
    const src = path.join(dayDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    const srcStat = fs.statSync(src);
    const dstStat = fs.existsSync(dst) ? fs.statSync(dst) : null;
    const sameFile = dstStat
      && dstStat.size === srcStat.size
      && Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1500;

    if (force || !sameFile) {
      fs.copyFileSync(src, dst);
      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
      copied += 1;
    } else {
      skipped += 1;
    }

    files.push({
      filename: entry.name,
      type: path.extname(entry.name).toLowerCase() === '.xlsx' ? 'xlsx' : 'pdf',
      size: srcStat.size,
      url: `/api/research/files/${kind}/${date}/${entry.name}`,
    });
  }

  return { files, copied, skipped };
}

function mapCninfoEntry(item, idx) {
  const signals = Array.isArray(item?.best_signals) ? item.best_signals : [];
  const subset = getResearchSubsetLabel(item, '');
  const industry = getResearchIndustryLabel(item, '');
  return {
    rank: item?.rank ?? idx + 1,
    code: item?.code || '',
    name: item?.company || '',
    industry: industry || subset,
    subset,
    score: item?.best_score ?? 0,
    title: item?.event || item?.best_title || '',
    summary: item?.best_summary,
    logic: item?.logic || '',
    facts: Array.isArray(item?.best_facts) ? item.best_facts : [],
    signals: signals
      .filter((signal) => Array.isArray(signal) && signal.length >= 2)
      .map((signal) => ({ name: signal[0], score: signal[1] })),
    annCount: item?.ann_count ?? 1,
    conclusion: item?.conclusion || '',
    increaseScale: item?.increase_scale ?? 0,
    time: item?.best_time || '',
    url: item?.best_url || '',
  };
}

function buildImportedCninfoSummary(date, processed, files, processedPath) {
  const coverage = processed?.coverage || {};
  const sentiment = processed?.sentiment || {};
  const fetchMeta = processed?.fetch_meta || {};

  let totalCount = sentiment.total || fetchMeta.total_raw || fetchMeta.total || 0;
  const columns = fetchMeta.columns || {};
  let rawTotal = 0;
  for (const source of ['sse', 'szse']) {
    rawTotal = Math.max(rawTotal, columns[source]?.count || 0);
  }
  if (rawTotal) totalCount = rawTotal;

  const watchlistHits = fetchMeta.total || 0;
  const goodCount = sentiment.good_count || 0;
  const badCount = sentiment.bad_count || 0;
  const neutralCount = sentiment.neutral_count || 0;
  const sentimentScore = goodCount - badCount;
  const topGood = Array.isArray(processed?.top_good) ? processed.top_good : [];
  const topBad = Array.isArray(processed?.top_bad) ? processed.top_bad : [];

  return {
    reportDate: date.slice(2).replace(/-/g, ''),
    generatedAt: processed?.generated_at || sourceGeneratedAt(processedPath),
    files,
    coverage: coverage.range_label || date,
    totalCount,
    watchlistHits,
    topGood: topGood.slice(0, 5).map((entry, idx) => mapCninfoEntry(entry, idx)),
    topBad: topBad.slice(0, 5).map((entry, idx) => mapCninfoEntry(entry, idx)),
    stats: {
      goodCount,
      badCount,
      neutralFiltered: neutralCount,
      sentimentScore,
    },
    sentiment: {
      summary: sentiment.summary || '',
      goodSectors: sentiment.good_sectors || [],
      badSectors: sentiment.bad_sectors || [],
      netScore: sentimentScore,
    },
    allGood: topGood.map((entry, idx) => mapCninfoEntry(entry, idx)),
    allBad: topBad.map((entry, idx) => mapCninfoEntry(entry, idx)),
    kind: 'cninfo',
    date,
  };
}

function getNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const DEFAULT_SCOPE_LABEL = '其他';
const SUBSET_SCOPE_FIELDS = [
  '所属子集',
  'subset',
  'subsets',
  'subsetName',
  'subsetNames',
  'matchedSubset',
  'matchedSubsets',
  'watchlistName',
  'watchlistNames',
  'watchlist',
  'portfolio',
  'concepts',
  'concept',
  '概念',
];
const INDUSTRY_SCOPE_FIELDS = ['行业', 'industry', 'industries', 'sector', 'sectors', '板块'];

function splitScopeValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitScopeValue(item));
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/[;；,，、/|｜\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueScopeLabels(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function collectScopeLabels(item, fields) {
  const source = item || {};
  return uniqueScopeLabels(fields.flatMap((field) => splitScopeValue(source[field])));
}

function getResearchSubsetLabels(item) {
  return collectScopeLabels(item, SUBSET_SCOPE_FIELDS);
}

function getResearchIndustryLabels(item) {
  return collectScopeLabels(item, INDUSTRY_SCOPE_FIELDS);
}

function getResearchScopeLabels(item, fallback = DEFAULT_SCOPE_LABEL) {
  const ordered = uniqueScopeLabels([
    ...getResearchSubsetLabels(item),
    ...getResearchIndustryLabels(item),
  ]);
  const realLabels = ordered.filter((label) => label !== DEFAULT_SCOPE_LABEL);
  const labels = realLabels.length > 0 ? realLabels : ordered;
  if (labels.length > 0) return labels.slice(0, 3);
  return fallback ? [fallback] : [];
}

function getResearchSubsetLabel(item, fallback = '') {
  const labels = getResearchSubsetLabels(item).filter((label) => label !== DEFAULT_SCOPE_LABEL);
  return (labels.length ? labels : getResearchSubsetLabels(item)).slice(0, 3).join('；') || fallback;
}

function getResearchIndustryLabel(item, fallback = '') {
  const labels = getResearchIndustryLabels(item).filter((label) => label !== DEFAULT_SCOPE_LABEL);
  return (labels.length ? labels : getResearchIndustryLabels(item)).slice(0, 3).join('；') || fallback;
}

function getResearchScopeLabel(item, fallback = DEFAULT_SCOPE_LABEL) {
  return getResearchScopeLabels(item, fallback).join('；');
}

function formatCompactNumber(value, decimals = 1) {
  const fixed = Number(value).toFixed(decimals);
  if (decimals <= 0) return fixed;
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatWanValue(value) {
  const abs = Math.abs(value);
  if (abs >= 10000) {
    return `${formatCompactNumber(value / 10000, 2)}亿元`;
  }
  return `${formatCompactNumber(value, 0)}万元`;
}

function formatWanRange(low, high) {
  if (low === null && high === null) return '';
  if ((low ?? 0) === 0 && (high ?? 0) === 0) return '';
  if (low !== null && high !== null && low !== high) {
    return `${formatWanValue(low)}~${formatWanValue(high)}`;
  }
  return formatWanValue(high ?? low);
}

function formatPercentValue(value) {
  const label = formatCompactNumber(value, 0);
  if (Number(label) === 0) return '0%';
  return `${value >= 0 ? '+' : ''}${label}%`;
}

function hasExplicitZeroPercent(text) {
  return /(^|[^0-9])0(?:\.0+)?\s*%/.test(text || '');
}

function formatPercentRange(low, high, fallback, reason) {
  const hasExplicitZero = hasExplicitZeroPercent(reason);
  if (low !== null && high !== null) {
    if (low === 0 && high === 0 && !hasExplicitZero) return '';
    if (low !== high) return `${formatPercentValue(low)}~${formatPercentValue(high)}`;
    return formatPercentValue(high);
  }
  if (fallback === null || fallback === undefined) return '';
  if (fallback === 0 && !hasExplicitZero) return '';
  return formatPercentValue(fallback);
}

const EARNINGS_POSITIVE_TYPES = new Set(['预增', '续盈', '扭亏', '略增']);
const EARNINGS_NEGATIVE_TYPES = new Set(['预减', '首亏', '续亏', '略减', '增亏']);
const EARNINGS_STRICT_NEGATIVE_PERCENT_TYPES = new Set(['预减', '首亏', '略减', '增亏']);
const EARNINGS_TURNAROUND_TYPE = '扭亏';
const DEFAULT_EARNINGS_SUBSET = DEFAULT_SCOPE_LABEL;

function getEarningsType(item) {
  return String(item?.预告类型 || item?.forecastType || '');
}

function isEarningsNegativeType(item) {
  return EARNINGS_NEGATIVE_TYPES.has(getEarningsType(item));
}

function calculateEarningsPct(current, previous) {
  const currentNumber = getNumber(current);
  const previousNumber = getNumber(previous);
  if (currentNumber === null || previousNumber === null || previousNumber === 0) return null;
  return ((currentNumber - previousNumber) / Math.abs(previousNumber)) * 100;
}

function hasMissingZeroEarningsPct(item) {
  const low = getNumber(item?.['同比下限%'] ?? item?.lowPct);
  const high = getNumber(item?.['同比上限%'] ?? item?.highPct);
  if (low !== 0 || high !== 0) return false;
  return !hasExplicitZeroPercent(item?.原因摘要 || item?.reason || item?.summary || '');
}

function normalizeRawEarningsPct(item, value) {
  const number = getNumber(value);
  if (number === null) return null;
  if (number === 0) return hasMissingZeroEarningsPct(item) ? null : 0;
  return isEarningsNegativeType(item) && getEarningsType(item) !== '续亏' ? -Math.abs(number) : number;
}

function getEarningsPctLow(item) {
  const raw = normalizeRawEarningsPct(item, item?.['同比下限%'] ?? item?.lowPct);
  if (raw !== null) return raw;
  return calculateEarningsPct(item?.下限万元 ?? item?.lowWan, item?.上年同期万元 ?? item?.prevWan);
}

function getEarningsPctHigh(item) {
  const raw = normalizeRawEarningsPct(item, item?.['同比上限%'] ?? item?.highPct);
  if (raw !== null) return raw;
  return calculateEarningsPct(item?.上限万元 ?? item?.highWan, item?.上年同期万元 ?? item?.prevWan);
}

function getEarningsSignal(item) {
  const type = getEarningsType(item);
  const lowWan = getNumber(item?.下限万元 ?? item?.lowWan);
  const highWan = getNumber(item?.上限万元 ?? item?.highWan);
  const lowPct = getEarningsPctLow(item);
  const highPct = getEarningsPctHigh(item);

  if (isEarningsNegativeType(item)) return 'bad';
  if (highPct !== null && highPct < 0) return 'bad';
  if ((lowWan !== null && lowWan < 0) || (highWan !== null && highWan < 0)) return 'bad';
  if (EARNINGS_POSITIVE_TYPES.has(type)) return 'good';
  if (highPct !== null && highPct >= 0) return 'good';
  if ((lowPct !== null && lowPct > 0) || (highPct !== null && highPct > 0)) return 'good';
  if ((lowWan !== null && lowWan > 0) || (highWan !== null && highWan > 0)) return 'good';
  return 'neutral';
}

function getEarningsScore(item) {
  const highPct = getEarningsPctHigh(item);
  const lowPct = getEarningsPctLow(item);
  if (highPct !== null) return highPct;
  if (lowPct !== null) return lowPct;
  if (getEarningsSignal(item) === 'bad') return -1;
  if (getEarningsSignal(item) === 'good') return 1;
  return 0;
}

function getEarningsMagnitudeScore(item) {
  const lowPct = getEarningsPctLow(item);
  const highPct = getEarningsPctHigh(item);
  if ((lowPct !== null || highPct !== null) && !((lowPct ?? 0) === 0 && (highPct ?? 0) === 0)) {
    return Math.max(Math.abs(lowPct ?? 0), Math.abs(highPct ?? 0));
  }

  const highWan = getNumber(item?.上限万元);
  const lowWan = getNumber(item?.下限万元);
  return Math.max(Math.abs(lowWan ?? 0), Math.abs(highWan ?? 0));
}

function isEarningsTurnaround(item) {
  return getEarningsType(item) === EARNINGS_TURNAROUND_TYPE;
}

function isEarningsFocusHit(item) {
  return getResearchScopeLabels(item, '').some((label) => label && label !== DEFAULT_EARNINGS_SUBSET);
}

function isEarningsSubsetHit(item) {
  return getResearchSubsetLabels(item).some((label) => label && label !== DEFAULT_EARNINGS_SUBSET);
}

function getEarningsFocusPriority(item) {
  if (isEarningsSubsetHit(item)) return 0;
  if (isEarningsFocusHit(item)) return 1;
  return 2;
}

function compareEarningsFocusPriority(a, b) {
  return getEarningsFocusPriority(a) - getEarningsFocusPriority(b);
}

function compareEarningsPositive(a, b) {
  const focusDiff = compareEarningsFocusPriority(a, b);
  if (focusDiff !== 0) return focusDiff;

  const turnaroundDiff = Number(isEarningsTurnaround(a)) - Number(isEarningsTurnaround(b));
  if (turnaroundDiff !== 0) return turnaroundDiff;

  const scoreDiff = getEarningsMagnitudeScore(b) - getEarningsMagnitudeScore(a);
  if (scoreDiff !== 0) return scoreDiff;

  return String(a?.证券代码 || '').localeCompare(String(b?.证券代码 || ''), 'zh-Hans-CN');
}

function compareEarningsNegative(a, b) {
  const focusDiff = compareEarningsFocusPriority(a, b);
  if (focusDiff !== 0) return focusDiff;

  const scoreDiff = getEarningsMagnitudeScore(b) - getEarningsMagnitudeScore(a);
  if (scoreDiff !== 0) return scoreDiff;

  return String(a?.证券代码 || '').localeCompare(String(b?.证券代码 || ''), 'zh-Hans-CN');
}

function getEarningsListGroup(item) {
  const signal = getEarningsSignal(item);
  if (signal === 'good' && !isEarningsTurnaround(item)) return 0;
  if (signal === 'good' && isEarningsTurnaround(item)) return 1;
  if (signal === 'bad') return 2;
  return 3;
}

function compareEarningsList(a, b) {
  const focusDiff = compareEarningsFocusPriority(a, b);
  if (focusDiff !== 0) return focusDiff;

  const groupDiff = getEarningsListGroup(a) - getEarningsListGroup(b);
  if (groupDiff !== 0) return groupDiff;

  const scoreDiff = getEarningsMagnitudeScore(b) - getEarningsMagnitudeScore(a);
  if (scoreDiff !== 0) return scoreDiff;

  return String(a?.证券代码 || '').localeCompare(String(b?.证券代码 || ''), 'zh-Hans-CN');
}

function getEarningsScoreLabel(item) {
  const lowPct = getEarningsPctLow(item);
  const highPct = getEarningsPctHigh(item);
  if (lowPct !== null || highPct !== null) {
    const pctLabel = formatPercentRange(lowPct, highPct, highPct ?? lowPct, item?.原因摘要 || '');
    if (pctLabel) return pctLabel;
  }
  if ((getNumber(item?.下限万元) ?? 0) < 0 || (getNumber(item?.上限万元) ?? 0) < 0) {
    return item?.预告类型 || '亏损';
  }
  return item?.预告类型 || '';
}

function getMeaningfulEarningsReason(reason) {
  const text = compactText(reason);
  if (!text) return '';
  if (/公告未披露具体原因/.test(text)) return '';

  const markerMatch = text.match(/(?:业绩变动原因|变动原因说明|业绩预告原因|主要原因|原因说明)[:：]?(.+)/);
  let candidate = compactText(markerMatch?.[1] || text)
    .replace(/^[。；;：:\s]+/, '')
    .split(/(?:三、|四、|五、|其他相关说明|风险提示|备查文件)/)[0]
    .trim();

  if (!candidate) return '';
  const boilerplatePatterns = [
    /本公司及董事会全体成员保证/,
    /没有虚假记载/,
    /本期业绩预计情况/,
    /预计的业绩/,
    /业绩预告期间/,
    /证券代码[:：]/,
    /公告编号[:：]/,
    /项目 本报告期 上年同期/,
  ];
  if (boilerplatePatterns.some((pattern) => pattern.test(candidate))) return '';

  candidate = candidate
    .replace(/^报告期内[，,]\s*/, '')
    .replace(/^(?:经公司财务部门初步测算[，,]\s*)?(?:公司)?预计实现(?:归属于上市公司股东的)?(?:扣除非经常性损益后的)?(?:净利润|归母净利润|扣非净利润)[^，。；;]*(?:[，,。；;]\s*)?/, '')
    .replace(/^(?:净利润|归母净利润|扣非净利润)实现[^，。；;]*(?:[，,。；;]\s*)?/, '')
    .replace(/^业绩(?:大幅|显著|较快)?(?:增长|提升|改善|下降|下滑|增亏|亏损)?(?:主要)?(?:系|由于|源于)[:：]?/, '')
    .replace(/^核心驱动力源于[:：]?/, '')
    .replace(/^主要(?:系|由于)[:：]?/, '')
    .trim();

  if (!candidate || /^(?:较|同比|比上年同期|与上年同期相比)[，,。；;\s]*$/.test(candidate)) return '';

  const fullStop = candidate.search(/[。！？]/);
  if (fullStop >= 20 && fullStop <= 120) {
    return candidate.slice(0, fullStop + 1).replace(/[。；;，,\s]+$/, '');
  }

  const secondaryClause = candidate.search(/；同时|;同时/);
  if (secondaryClause >= 20) {
    return candidate.slice(0, secondaryClause).replace(/[。；;，,\s]+$/, '');
  }

  return candidate.slice(0, 120).replace(/[。；;，,\s]+$/, '');
}

function buildEarningsEntrySummary(item) {
  const type = item?.预告类型 || '?';
  const metric = item?.口径 || '归母净利润';
  const reason = item?.原因摘要 || '';
  const profitRange = formatWanRange(getNumber(item?.下限万元), getNumber(item?.上限万元));
  const pctRange = formatPercentRange(
    getEarningsPctLow(item),
    getEarningsPctHigh(item),
    getEarningsPctHigh(item),
    reason,
  );
  const meaningfulReason = getMeaningfulEarningsReason(reason);

  const core = [];
  if (profitRange && pctRange) {
    core.push(`${metric}预计 ${profitRange}，同比 ${pctRange}`);
  } else if (profitRange) {
    core.push(`${metric}预计 ${profitRange}`);
  } else if (pctRange) {
    core.push(`${metric}预计同比 ${pctRange}`);
  }
  if (meaningfulReason) core.push(`原因：${meaningfulReason}`);

  return `【${type}】${core.join('。') || '公告未提取到核心财务区间'}。`;
}

function cleanAnnouncementTitle(title) {
  return String(title || '').replace(/<\/?em>/g, '').trim();
}

function normalizeStockCode(code) {
  return String(code || '').split(',')[0].trim();
}

function normalizeAnnouncementUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${CNINFO_PDF_PREFIX}${value.replace(/^\/+/, '')}`;
}

function getRawEarningsAnnouncementUrl(item) {
  return normalizeAnnouncementUrl(
    item?.公告链接
      || item?.原公告链接
      || item?.原文链接
      || item?.公告URL
      || item?.pdf_url
      || item?.pdfUrl
      || item?.url
      || item?.adjunctUrl,
  );
}

async function fetchCninfoEarningsAnnouncements(date, column) {
  if (typeof fetch !== 'function') return [];

  const body = new URLSearchParams({
    pageNum: '1',
    pageSize: '80',
    column,
    tabName: 'fulltext',
    plate: '',
    stock: '',
    searchkey: '业绩',
    secid: '',
    category: '',
    trade: '',
    seDate: `${date}~${date}`,
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  });

  try {
    const res = await fetch(CNINFO_QUERY_URL, {
      method: 'POST',
      headers: CNINFO_HEADERS,
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.announcements) ? data.announcements : [];
  } catch (error) {
    console.warn(`[research-sync] cninfo earnings url lookup failed ${date}/${column}:`, error.message);
    return [];
  }
}

async function buildEarningsAnnouncementUrlMap(date, items) {
  const targetCodes = new Set(items.map((item) => normalizeStockCode(item?.证券代码)).filter(Boolean));
  if (targetCodes.size === 0) return new Map();

  const needsLookup = items.some((item) => !getRawEarningsAnnouncementUrl(item));
  if (!needsLookup) return new Map();

  const columns = new Set(
    [...targetCodes].map((code) => (code.startsWith('6') ? 'sse' : 'szse')),
  );
  const announcements = [];
  for (const column of columns) {
    announcements.push(...await fetchCninfoEarningsAnnouncements(date, column));
  }

  const urlMap = new Map();
  for (const announcement of announcements) {
    const code = normalizeStockCode(announcement?.secCode);
    if (!targetCodes.has(code) || urlMap.has(code)) continue;

    const title = cleanAnnouncementTitle(announcement?.announcementTitle);
    if (!title.includes('业绩')) continue;

    const url = normalizeAnnouncementUrl(announcement?.adjunctUrl);
    if (!url) continue;
    urlMap.set(code, {
      url,
      announcementId: announcement?.announcementId || '',
      announcementTitle: title,
    });
  }
  return urlMap;
}

function getEarningsAnnouncementMeta(item, urlMap) {
  const code = normalizeStockCode(item?.证券代码);
  const fromSource = getRawEarningsAnnouncementUrl(item);
  const fromLookup = urlMap.get(code) || {};
  return {
    url: fromSource || fromLookup.url || '',
    announcementId: item?.公告ID || item?.announcementId || fromLookup.announcementId || '',
    announcementTitle: item?.公告标题 || item?.announcementTitle || fromLookup.announcementTitle || '',
  };
}

function getEarningsIndustry(item) {
  return getResearchIndustryLabel(item, '');
}

function getEarningsSubset(item) {
  return getResearchSubsetLabel(item, '');
}

function getEarningsScope(item) {
  return getResearchScopeLabel(item, DEFAULT_EARNINGS_SUBSET);
}

function mapEarningsItem(item, urlMap = new Map()) {
  const announcement = getEarningsAnnouncementMeta(item, urlMap);
  const industry = getEarningsIndustry(item);
  const subset = getEarningsSubset(item);
  const scope = getEarningsScope(item);
  return {
    code: item?.证券代码 || '',
    name: item?.证券简称 || '',
    industry: industry || subset || scope,
    subset: subset || industry || scope,
    annDate: item?.公告日期 || '',
    url: announcement.url,
    announcementId: announcement.announcementId,
    announcementTitle: announcement.announcementTitle,
    forecastType: item?.预告类型 || '',
    forecastPeriod: item?.预告期间 || '',
    metric: item?.口径 || '',
    lowWan: getNumber(item?.下限万元),
    highWan: getNumber(item?.上限万元),
    prevWan: getNumber(item?.上年同期万元),
    lowPct: getEarningsPctLow(item),
    highPct: getEarningsPctHigh(item),
    reason: getMeaningfulEarningsReason(item?.原因摘要) || '',
    focusHit: isEarningsFocusHit(item),
    subsetHit: isEarningsSubsetHit(item),
  };
}

function getImpliedPreviousValues(lowWan, highWan, lowPct, highPct) {
  const values = [];
  for (const current of [lowWan, highWan]) {
    for (const pct of [lowPct, highPct]) {
      if (typeof current !== 'number' || typeof pct !== 'number') continue;
      const denom = 1 + (pct / 100);
      if (Math.abs(denom) < 1e-6) continue;
      const implied = current / denom;
      if (implied > 0) values.push(implied);
    }
  }
  return values;
}

function validateEarningsInputItems(items, date) {
  const issues = [];
  for (const item of items) {
    const code = item?.证券代码 || item?.code || '';
    const name = item?.证券简称 || item?.name || '';
    const label = `${date} ${code} ${name}`.trim();
    const forecastType = getEarningsType(item);
    const reason = item?.原因摘要 || item?.reason || '';
    const lowWan = getNumber(item?.下限万元 ?? item?.lowWan);
    const highWan = getNumber(item?.上限万元 ?? item?.highWan);
    const prevWan = getNumber(item?.上年同期万元 ?? item?.prevWan);
    const rawLowPct = getNumber(item?.['同比下限%'] ?? item?.lowPct);
    const rawHighPct = getNumber(item?.['同比上限%'] ?? item?.highPct);
    const lowPct = getEarningsPctLow(item);
    const highPct = getEarningsPctHigh(item);
    const hasProfit = lowWan !== null || highWan !== null;
    const hasYoy = (lowPct !== null && lowPct !== 0) || (highPct !== null && highPct !== 0);

    if (lowWan === null || highWan === null) {
      issues.push(`${label}: 净利润区间未抓取`);
      continue;
    }

    if (lowWan === 0 && highWan === 0 && hasYoy) {
      issues.push(`${label}: 净利润区间为 0/0 但已有同比`);
    }

    if (
      Math.max(Math.abs(lowWan), Math.abs(highWan)) <= 10
      && (Math.abs(lowPct ?? 0) >= 50 || Math.abs(highPct ?? 0) >= 50)
    ) {
      issues.push(`${label}: 净利润区间异常小 ${lowWan}~${highWan} 万元，疑似误抓日期或每股收益`);
    }

    if (
      rawLowPct === 0
      && rawHighPct === 0
      && hasProfit
      && (lowWan !== 0 || highWan !== 0)
      && lowPct === null
      && highPct === null
      && !hasExplicitZeroPercent(reason)
    ) {
      issues.push(`${label}: 同比区间为 0/0，疑似同比未抓取`);
    }

    if (prevWan === null && !hasYoy && (lowWan !== 0 || highWan !== 0)) {
      issues.push(`${label}: 缺少上年同期且缺少有效同比`);
    }

    if (EARNINGS_STRICT_NEGATIVE_PERCENT_TYPES.has(forecastType)) {
      if (rawLowPct !== null && rawLowPct > 0) {
        issues.push(`${label}: ${forecastType} 同比下限为正数 ${rawLowPct}%，应为负向`);
      }
      if (rawHighPct !== null && rawHighPct > 0) {
        issues.push(`${label}: ${forecastType} 同比上限为正数 ${rawHighPct}%，应为负向`);
      }
    }

    if (
      prevWan !== null
      && prevWan > 100
      && lowWan > 0
      && highWan > 0
      && hasYoy
    ) {
      const impliedValues = getImpliedPreviousValues(lowWan, highWan, lowPct, highPct);
      if (impliedValues.length > 0) {
        const bestError = Math.min(...impliedValues.map((value) => Math.abs(value - prevWan) / Math.max(Math.abs(prevWan), 1)));
        if (bestError > 0.30) {
          issues.push(`${label}: 上年同期 ${prevWan} 万元与当期净利润/同比不自洽`);
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`earnings validation failed: ${issues.slice(0, 8).join('; ')}`);
  }
}

async function buildEarningsSummary(date, data, files, inputPath) {
  const items = Array.isArray(data?.items) ? data.items : [];
  validateEarningsInputItems(items, date);
  const announcementUrlMap = await buildEarningsAnnouncementUrlMap(date, items);
  const positive = items
    .filter((item) => getEarningsSignal(item) === 'good')
    .sort(compareEarningsPositive);
  const negative = items
    .filter((item) => getEarningsSignal(item) === 'bad')
    .sort(compareEarningsNegative);
  const focusCount = items.filter(isEarningsFocusHit).length;

  const mapEntry = (item, idx) => {
    const pct = getEarningsScore(item);
    const announcement = getEarningsAnnouncementMeta(item, announcementUrlMap);
    const industry = getEarningsIndustry(item);
    const subset = getEarningsSubset(item);
    const scope = getEarningsScope(item);
    return {
      rank: idx + 1,
      code: item?.证券代码 || '',
      name: item?.证券简称 || '',
      industry: industry || subset || scope,
      subset: subset || industry || scope,
      score: pct ?? 0,
      scoreLabel: getEarningsScoreLabel(item),
      title: `${item?.预告期间 || ''} 业绩预告`.trim(),
      metric: item?.口径 || '净利润',
      lowWan: getNumber(item?.下限万元),
      highWan: getNumber(item?.上限万元),
      prevWan: getNumber(item?.上年同期万元),
      focusHit: isEarningsFocusHit(item),
      subsetHit: isEarningsSubsetHit(item),
      url: announcement.url,
      announcementId: announcement.announcementId,
      announcementTitle: announcement.announcementTitle,
      summary: buildEarningsEntrySummary(item),
    };
  };

  const allItems = [...items]
    .sort(compareEarningsList)
    .map((item) => mapEarningsItem(item, announcementUrlMap));

  const typeDistribution = {};
  for (const item of items) {
    const type = item?.预告类型 || '未知';
    typeDistribution[type] = (typeDistribution[type] || 0) + 1;
  }

  return {
    reportDate: date,
    generatedAt: data?.generated_at || sourceGeneratedAt(inputPath),
    files,
    coverage: date,
    totalCount: items.length,
    watchlistHits: focusCount,
    topGood: positive.slice(0, 5).map(mapEntry),
    topBad: negative.slice(0, 5).map(mapEntry),
    stats: {
      goodCount: positive.length,
      badCount: negative.length,
      neutralFiltered: 0,
      totalForecasts: items.length,
    },
    allItems,
    typeDistribution,
    kind: 'earnings',
    date,
  };
}

function getEarningsReportMetric(item, field) {
  return getNumber(item?.[field]);
}

function earningsReportProfitWan(item) {
  const valueYi = getEarningsReportMetric(item, '归母净利润亿元');
  return valueYi === null ? null : valueYi * 10000;
}

function earningsReportPreviousProfitWan(item) {
  const currentWan = earningsReportProfitWan(item);
  const yoy = getEarningsReportMetric(item, '归母净利润同比%');
  if (currentWan === null || yoy === null) return null;
  const denominator = 1 + (yoy / 100);
  if (Math.abs(denominator) < 1e-6) return null;
  return currentWan / denominator;
}

function formatEarningsReportMetric(value, unit, decimals = 2) {
  if (value === null) return '';
  const label = Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return `${label}${unit}`;
}

function buildEarningsReportEntrySummary(item) {
  const metrics = [
    ['营收', getEarningsReportMetric(item, '营业收入亿元'), '亿元'],
    ['营收同比', getEarningsReportMetric(item, '营业收入同比%'), '%'],
    ['扣非净利', getEarningsReportMetric(item, '扣非净利润亿元'), '亿元'],
    ['扣非同比', getEarningsReportMetric(item, '扣非净利润同比%'), '%'],
    ['经营现金流', getEarningsReportMetric(item, '经营现金流亿元'), '亿元'],
    ['现金流同比', getEarningsReportMetric(item, '经营现金流同比%'), '%'],
    ['EPS', getEarningsReportMetric(item, '基本每股收益元'), '元'],
    ['ROE', getEarningsReportMetric(item, '加权ROE%'), '%'],
  ];
  const parts = metrics
    .filter(([, value]) => value !== null)
    .map(([label, value, unit]) => `${label} ${formatEarningsReportMetric(value, unit)}`);
  return parts.join('；') || '核心财务指标未提取，详见原报告';
}

function normalizeEarningsReportDate(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));
  }
  return String(value || fallback);
}

function compareEarningsReportItems(a, b) {
  const focusDiff = compareEarningsFocusPriority(a, b);
  if (focusDiff !== 0) return focusDiff;
  const aScore = Math.abs(getEarningsReportMetric(a, '归母净利润同比%') ?? 0);
  const bScore = Math.abs(getEarningsReportMetric(b, '归母净利润同比%') ?? 0);
  if (aScore !== bScore) return bScore - aScore;
  return String(a?.证券代码 || '').localeCompare(String(b?.证券代码 || ''), 'zh-Hans-CN');
}

function mapEarningsReportItem(item, date) {
  const score = getEarningsReportMetric(item, '归母净利润同比%');
  const profitWan = earningsReportProfitWan(item);
  const subset = getResearchSubsetLabel(item, '');
  const industry = getResearchIndustryLabel(item, '');
  return {
    code: item?.证券代码 || '',
    name: item?.证券简称 || '',
    industry: industry || subset || DEFAULT_SCOPE_LABEL,
    subset: subset || industry || DEFAULT_SCOPE_LABEL,
    annDate: normalizeEarningsReportDate(item?.公告日期, date),
    url: normalizeAnnouncementUrl(item?.原文链接 || item?.公告链接 || ''),
    announcementId: item?.公告ID || '',
    announcementTitle: item?.公告标题 || '',
    forecastType: item?.报告类型 || '',
    forecastPeriod: item?.报告期 || '',
    metric: '归母净利润',
    lowWan: profitWan,
    highWan: profitWan,
    prevWan: earningsReportPreviousProfitWan(item),
    lowPct: score,
    highPct: score,
    reason: buildEarningsReportEntrySummary(item),
    focusHit: Boolean(item?.watchlist命中),
    subsetHit: Boolean(subset && subset !== DEFAULT_SCOPE_LABEL),
  };
}

function buildEarningsReportSummary(date, data, files, inputPath) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const positive = items
    .filter((item) => (getEarningsReportMetric(item, '归母净利润同比%') ?? 0) > 0)
    .sort(compareEarningsReportItems);
  const negative = items
    .filter((item) => (getEarningsReportMetric(item, '归母净利润同比%') ?? 0) < 0)
    .sort(compareEarningsReportItems);

  const mapEntry = (item, idx) => {
    const score = getEarningsReportMetric(item, '归母净利润同比%');
    const profitWan = earningsReportProfitWan(item);
    const subset = getResearchSubsetLabel(item, '');
    const industry = getResearchIndustryLabel(item, '');
    return {
      rank: idx + 1,
      code: item?.证券代码 || '',
      name: item?.证券简称 || '',
      industry: industry || subset || DEFAULT_SCOPE_LABEL,
      subset: subset || industry || DEFAULT_SCOPE_LABEL,
      score: score ?? 0,
      scoreLabel: score === null ? '同比缺失' : formatPercentValue(score),
      title: `${item?.报告期 || ''} ${item?.报告类型 || '业绩报告'}`.trim(),
      metric: '归母净利润',
      lowWan: profitWan,
      highWan: profitWan,
      prevWan: earningsReportPreviousProfitWan(item),
      focusHit: Boolean(item?.watchlist命中),
      subsetHit: Boolean(subset && subset !== DEFAULT_SCOPE_LABEL),
      url: normalizeAnnouncementUrl(item?.原文链接 || item?.公告链接 || ''),
      announcementId: item?.公告ID || '',
      announcementTitle: item?.公告标题 || '',
      summary: buildEarningsReportEntrySummary(item),
    };
  };

  const allItems = [...items]
    .sort(compareEarningsReportItems)
    .map((item) => mapEarningsReportItem(item, date));
  const typeDistribution = {};
  for (const item of items) {
    const type = item?.报告类型 || '未知';
    typeDistribution[type] = (typeDistribution[type] || 0) + 1;
  }

  const sourceSummary = data?.fetch_summary || {};
  return {
    reportDate: date,
    generatedAt: data?.generated_at || sourceGeneratedAt(inputPath),
    files,
    coverage: date,
    totalCount: sourceSummary.formal_report_rows ?? items.length,
    watchlistHits: sourceSummary.watchlist_report_rows ?? items.length,
    topGood: positive.slice(0, 5).map(mapEntry),
    topBad: negative.slice(0, 5).map(mapEntry),
    stats: {
      goodCount: positive.length,
      badCount: negative.length,
      neutralFiltered: Math.max(0, items.length - positive.length - negative.length),
      totalReports: items.length,
    },
    allItems,
    typeDistribution,
    kind: 'earnings-report',
    date,
  };
}

function mapRiskEntry(item, idx) {
  const signals = Array.isArray(item?.signals) ? item.signals : [];
  const signalLabels = signals.map((signal) => signal?.label).filter(Boolean);
  const judges = signals.map((signal) => signal?.judge).filter(Boolean);
  const subset = getResearchSubsetLabel(item, '');
  const industry = getResearchIndustryLabel(item, '');
  return {
    rank: item?.rank ?? idx + 1,
    code: item?.code || '',
    name: item?.company || '',
    industry: industry || subset,
    subset,
    score: item?.score ?? 0,
    scoreLabel: item?.risk_level ? `${item.risk_level} ${item?.score ?? ''}`.trim() : undefined,
    title: item?.title || '',
    summary: item?.summary || '',
    logic: judges.join('；'),
    facts: signalLabels.length ? [`风险信号：${signalLabels.join(' / ')}`] : [],
    signals: signals
      .filter((signal) => signal?.label)
      .map((signal) => ({ name: signal.label, score: signal.score ?? 0 })),
    annCount: 1,
    conclusion: item?.risk_level || '',
    time: item?.announcement_time ? new Date(item.announcement_time).toISOString() : '',
    url: item?.url || '',
  };
}

function buildRiskSummary(date, processed, files, processedPath) {
  const coverage = processed?.coverage || {};
  const sentiment = processed?.sentiment || {};
  const risks = Array.isArray(processed?.risks)
    ? processed.risks
    : [
        ...(Array.isArray(processed?.major_risks) ? processed.major_risks : []),
        ...(Array.isArray(processed?.observations) ? processed.observations : []),
      ];
  const sortedRisks = [...risks].sort((a, b) => {
    const aScore = Number.isFinite(a?.score) ? a.score : 0;
    const bScore = Number.isFinite(b?.score) ? b.score : 0;
    return aScore - bScore;
  });
  const allRisks = sortedRisks.map((entry, idx) => mapRiskEntry(entry, idx));
  const byConcept = sentiment?.by_concept && typeof sentiment.by_concept === 'object'
    ? Object.entries(sentiment.by_concept)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([name, count]) => `${name}(${count})`)
      .slice(0, 8)
    : [];
  const bySignal = sentiment?.by_signal && typeof sentiment.by_signal === 'object'
    ? Object.entries(sentiment.by_signal)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([name, count]) => `${name} ${count}`)
      .slice(0, 6)
    : [];

  return {
    reportDate: date.slice(2).replace(/-/g, ''),
    generatedAt: processed?.generated_at || sourceGeneratedAt(processedPath),
    files,
    coverage: coverage.range_label || `${coverage.start_date || date}~${coverage.end_date || date}`,
    totalCount: coverage.raw_total || 0,
    watchlistHits: coverage.watchlist_ann_count || risks.length,
    topGood: [],
    topBad: allRisks.slice(0, 5),
    stats: {
      goodCount: 0,
      badCount: sentiment.risk_count ?? risks.length,
      neutralFiltered: sentiment.observation_count || 0,
      majorRiskCount: sentiment.major_risk_count || 0,
      riskCompanyCount: sentiment.risk_company_count || risks.length,
    },
    sentiment: {
      summary: bySignal.length
        ? `风险信号：${bySignal.join('；')}`
        : `风险提示 ${sentiment.risk_count ?? risks.length} 条`,
      goodSectors: [],
      badSectors: byConcept,
      netScore: -(sentiment.risk_count ?? risks.length),
    },
    allGood: [],
    allBad: allRisks,
    kind: 'risk',
    date,
  };
}

function writeSummary(kind, date, summary) {
  return writeJsonAtomicIfChanged(path.join(RESEARCH_DIR, kind, `${date}.json`), summary);
}

function syncCninfoDate(date, force) {
  const dayDir = path.join(SOURCE_CONFIG.cninfo.root, date);
  const processedPath = findCninfoProcessed(date);
  if (!processedPath) {
    throw new Error(`no cninfo processed JSON for ${date}`);
  }
  const processed = readJson(processedPath);
  const reportSourceDir = fs.existsSync(dayDir) ? dayDir : path.dirname(path.dirname(processedPath));
  const { files, copied, skipped } = copyReports('cninfo', date, reportSourceDir, force);
  if (!files.length) {
    throw new Error(`no cninfo report files for ${date}`);
  }
  const summary = buildImportedCninfoSummary(date, processed, files, processedPath);
  const summaryWritten = writeSummary('cninfo', date, summary);
  return {
    kind: 'cninfo',
    date,
    success: true,
    summaryWritten,
    filesCopied: copied,
    filesSkipped: skipped,
    source: {
      summary: processedPath,
      reports: reportSourceDir,
    },
  };
}

async function syncDirectCninfoDate(date, dependencies = {}) {
  const fetchDay = dependencies.fetchCninfoMarketDayImpl || fetchCninfoMarketDay;
  const fundsFile = dependencies.fundsFile || path.join(SERVER_DIR, 'data/funds.json');
  const marketDay = await fetchDay({ date });
  if (marketDay.totalCount === 0) {
    return {
      kind: 'cninfo',
      date,
      success: false,
      skipped: true,
      error: `CNINFO has no announcements for ${date}`,
    };
  }
  const universe = buildPortfolioUniverse(readJson(fundsFile));
  const summary = buildDirectCninfoSummary({
    date,
    totalCount: marketDay.totalCount,
    announcements: marketDay.announcements,
    universe,
    generatedAt: new Date().toISOString(),
  });
  const summaryWritten = writeJsonAtomicIfChanged(
    path.join(RESEARCH_DIR, 'cninfo', `${date}.json`),
    summary,
  );
  return {
    kind: 'cninfo',
    date,
    success: true,
    summaryWritten,
    filesCopied: 0,
    filesSkipped: 0,
    source: 'cninfo-direct',
    fetched: marketDay.announcements.length,
    matched: summary.watchlistHits,
    totalCount: marketDay.totalCount,
  };
}

async function syncEarningsDate(kind, date, force) {
  const dayDir = path.join(SOURCE_CONFIG[kind].root, date);
  const inputPath = path.join(dayDir, 'input.json');
  if (!fs.existsSync(inputPath)) {
    throw new Error(`no ${kind} input.json for ${date}`);
  }
  const data = readJson(inputPath);
  const { files, copied, skipped } = copyReports(kind, date, dayDir, force);
  if (!files.length) {
    throw new Error(`no ${kind} report files for ${date}`);
  }
  const summary = kind === 'earnings-report'
    ? buildEarningsReportSummary(date, data, files, inputPath)
    : await buildEarningsSummary(date, data, files, inputPath);
  const summaryWritten = writeSummary(kind, date, summary);
  return {
    kind,
    date,
    success: true,
    summaryWritten,
    filesCopied: copied,
    filesSkipped: skipped,
    source: {
      summary: inputPath,
      reports: dayDir,
    },
  };
}

function syncRiskDate(date, force) {
  const dayDir = path.join(SOURCE_CONFIG.risk.root, date);
  const processedPath = findRiskProcessed(date);
  if (!processedPath) {
    throw new Error(`no risk processed JSON for ${date}`);
  }
  const processed = readJson(processedPath);
  const { files, copied, skipped } = copyReports('risk', date, dayDir, force);
  if (!files.length) {
    throw new Error(`no risk report files for ${date}`);
  }
  const summary = buildRiskSummary(date, processed, files, processedPath);
  const summaryWritten = writeSummary('risk', date, summary);
  return {
    kind: 'risk',
    date,
    success: true,
    summaryWritten,
    filesCopied: copied,
    filesSkipped: skipped,
    source: {
      summary: processedPath,
      reports: dayDir,
    },
  };
}

async function syncOne(kind, date, force, dependencies) {
  assertDate(date);
  try {
    if (kind === 'cninfo') {
      return isAutoSyncableDate('cninfo', date)
        ? syncCninfoDate(date, force)
        : await syncDirectCninfoDate(date, dependencies);
    }
    if (kind === 'risk') return syncRiskDate(date, force);
    return await syncEarningsDate(kind, date, force);
  } catch (error) {
    return {
      kind,
      date,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getShanghaiDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function recentShanghaiWeekdays(now, lookbackDays) {
  const limit = Math.max(1, Math.min(Number(lookbackDays) || 14, 120));
  const date = new Date(`${getShanghaiDateKey(now)}T00:00:00.000Z`);
  const weekdays = [];
  while (weekdays.length < limit) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) weekdays.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return weekdays;
}

function pickDates(kind, date, days, now) {
  if (date) return [date];
  const limit = Math.max(1, Math.min(Number(days) || 14, 120));
  if (kind === 'cninfo') return recentShanghaiWeekdays(now, limit);
  return listDateDirs(SOURCE_CONFIG[kind].root)
    .reverse()
    .filter((currentDate) => isAutoSyncableDate(kind, currentDate))
    .slice(0, limit);
}

export async function syncResearch(
  { kind = 'all', date = null, days = 14, force = false } = {},
  dependencies = {},
) {
  assertKind(kind);
  if (date) assertDate(date);

  ensureDir(RESEARCH_DIR);
  ensureDir(REPORTS_DIR);
  for (const k of RESEARCH_KINDS) {
    ensureDir(path.join(RESEARCH_DIR, k));
    ensureDir(SOURCE_CONFIG[k].reportDir);
  }

  const kinds = kind === 'all' ? RESEARCH_KINDS : [kind];
  const results = [];
  for (const currentKind of kinds) {
    const dates = pickDates(currentKind, date, days, dependencies.now);
    const isRecentCninfoSync = currentKind === 'cninfo' && !date;
    for (const currentDate of dates) {
      const result = await syncOne(currentKind, currentDate, force, dependencies);
      if (result.skipped) continue;
      results.push(result);
      if (isRecentCninfoSync) break;
    }
  }

  if (results.length === 0) {
    return {
      success: false,
      error: kind === 'all' ? '未找到可同步的数据源' : `未找到可同步的 ${kind} 数据源`,
      totals: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        changedDates: 0,
        filesCopied: 0,
        filesSkipped: 0,
      },
      results: [],
    };
  }

  const failures = results.filter((result) => !result.success).length;
  const changedDates = results.filter((result) =>
    result.success && (result.summaryWritten || result.filesCopied > 0)
  ).length;

  return {
    success: failures === 0,
    kind,
    date,
    days: date ? null : days,
    force: Boolean(force),
    generatedAt: new Date().toISOString(),
    totals: {
      attempted: results.length,
      succeeded: results.length - failures,
      failed: failures,
      changedDates,
      filesCopied: results.reduce((sum, result) => sum + (result.filesCopied || 0), 0),
      filesSkipped: results.reduce((sum, result) => sum + (result.filesSkipped || 0), 0),
    },
    results,
  };
}

export function getResearchSourceStatus() {
  return {
    cninfo: {
      root: SOURCE_CONFIG.cninfo.root,
      exists: fs.existsSync(SOURCE_CONFIG.cninfo.root),
      latestDates: listDateDirs(SOURCE_CONFIG.cninfo.root).reverse().slice(0, 5),
      direct: {
        enabled: true,
        endpoint: 'https://www.cninfo.com.cn/new/hisAnnouncement/query',
        markets: ['sse', 'szse'],
      },
    },
    earnings: {
      root: SOURCE_CONFIG.earnings.root,
      exists: fs.existsSync(SOURCE_CONFIG.earnings.root),
      latestDates: listDateDirs(SOURCE_CONFIG.earnings.root).reverse().slice(0, 5),
    },
    'earnings-report': {
      root: SOURCE_CONFIG['earnings-report'].root,
      exists: fs.existsSync(SOURCE_CONFIG['earnings-report'].root),
      latestDates: listDateDirs(SOURCE_CONFIG['earnings-report'].root).reverse().slice(0, 5),
    },
    risk: {
      root: SOURCE_CONFIG.risk.root,
      exists: fs.existsSync(SOURCE_CONFIG.risk.root),
      latestDates: listDateDirs(SOURCE_CONFIG.risk.root).reverse().slice(0, 5),
    },
  };
}
