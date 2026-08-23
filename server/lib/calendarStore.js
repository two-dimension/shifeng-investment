import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_CALENDAR_FILE = path.join(__dirname, '../data/calendar/events.json');
export const DEFAULT_MANUAL_CALENDAR_FILE = path.join(__dirname, '../data/calendar/manual-events.json');
export const DEFAULT_FUNDS_FILE = path.join(__dirname, '../data/funds.json');

export const CALENDAR_KINDS = Object.freeze(['macro', 'us_earnings', 'a_share']);
export const CALENDAR_STATUSES = Object.freeze([
  'scheduled',
  'estimated',
  'confirmed',
  'released',
  'cancelled',
]);
export const CALENDAR_TIME_PRECISIONS = Object.freeze(['exact', 'session', 'date']);
export const CALENDAR_SOURCE_NAMES = Object.freeze([
  'jin10',
  'nasdaq',
  'earningshub',
  'wechat',
  'company_ir',
  'official',
]);
export const CALENDAR_SOURCE_STATUSES = Object.freeze([
  'ready',
  'stale',
  'error',
  'authorization_required',
  'manual_import',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_PRECISION_ORDER = Object.freeze({ exact: 0, session: 1, date: 2 });
const CALENDAR_STORE_CACHE = new Map();

// These symbols are market instruments rather than operating companies and cannot report earnings.
export const NON_COMPANY_US_SYMBOLS = new Set([
  '^NDX', '^GSPC', '^DJI', '^VIX',
  'NQ=F', 'ES=F', 'YM=F', 'BZ=F',
  'DX-Y.NYB',
  'ARKX', 'BOTZ', 'COPX', 'CPER', 'GLD', 'GRID', 'ICLN', 'LIT',
  'SKYY', 'SLV', 'TAN', 'TLT', 'UNG', 'URA', 'XBI', 'XLE', 'XLF', 'XLY',
]);

const US_COMPANY_SYMBOL_ALIASES = new Map([
  ['GOOG', 'GOOGL'],
]);
const US_COMPANY_ALIAS_CANONICAL_SYMBOLS = new Set(US_COMPANY_SYMBOL_ALIASES.values());

const DEFAULT_SOURCE_STATUS = Object.freeze({
  jin10: {
    status: 'manual_import',
    updatedAt: null,
    message: '通过已登录金十网页人工核验并导入快照；未接入后台自动登录或授权 API',
  },
  earningshub: {
    status: 'authorization_required',
    updatedAt: null,
    message: '需取得 EarningsHub 数据授权后才能启用自动同步',
  },
  nasdaq: {
    status: 'ready',
    updatedAt: null,
    message: '美股财报日程来自 Nasdaq 公开财报日历',
  },
  wechat: {
    status: 'manual_import',
    updatedAt: null,
    message: 'A 股投资日历当前采用结构化文件人工导入',
  },
  company_ir: {
    status: 'manual_import',
    updatedAt: null,
    message: '公司投资者关系或公告页面仅用于人工核验，尚未接入自动同步',
  },
  official: {
    status: 'ready',
    updatedAt: null,
    message: '政府、央行、统计机构或会议主办方官网直接核验',
  },
});

/**
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {'macro'|'us_earnings'|'a_share'} kind
 * @property {string} title
 * @property {'CN'|'US'} region
 * @property {string=} country Source country or region label
 * @property {string} date YYYY-MM-DD in the source business timezone
 * @property {string=} endDate YYYY-MM-DD inclusive end date for multi-day events
 * @property {string=} startAt ISO 8601 timestamp when timePrecision is exact
 * @property {string} timezone IANA timezone, e.g. Asia/Shanghai or America/New_York
 * @property {'exact'|'session'|'date'} timePrecision
 * @property {1|2|3|4|5} importance
 * @property {'scheduled'|'estimated'|'confirmed'|'released'|'cancelled'} status
 * @property {string[]=} symbols
 * @property {{fundId:string,fundName:string,symbol:string}[]=} subsetHits
 * @property {{previous?:string|number|null,forecast?:string|number|null,actual?:string|number|null,unit?:string}=} metrics
 * @property {{symbol:string,company?:string,period?:string,session?:'before_market'|'after_market'|'unknown',currency?:string,epsEstimate?:number|null,revenueEstimate?:number|null,marketCap?:number|null}=} earnings
 * @property {string[]=} tags
 * @property {string=} summary
 * @property {{name:'jin10'|'nasdaq'|'earningshub'|'wechat'|'company_ir',sourceId?:string,url:string,fetchedAt:string}} source
 */

export class CalendarDataError extends Error {
  constructor(message, { code = 'CALENDAR_DATA_INVALID', status = 500, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CalendarDataError';
    this.code = code;
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalendarDataError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field);
}

function optionalFiniteNumber(value, field) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CalendarDataError(`${field} must be a finite number or null`);
  }
  return value;
}

function validateIsoTimestamp(value, field) {
  const normalized = requireString(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new CalendarDataError(`${field} must be a valid ISO 8601 timestamp`);
  }
  return normalized;
}

function validateTimezone(value, field) {
  const timezone = requireString(value, field);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new CalendarDataError(`${field} must be a valid IANA timezone`);
  }
  return timezone;
}

export function parseDateKey(value, field = 'date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new CalendarDataError(`${field} must be YYYY-MM-DD`, {
      code: 'CALENDAR_DATE_INVALID',
      status: 400,
    });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new CalendarDataError(`${field} is not a real calendar date`, {
      code: 'CALENDAR_DATE_INVALID',
      status: 400,
    });
  }
  return parsed;
}

export function validateCalendarRange(start, end, maxDays = MAX_RANGE_DAYS) {
  if (!start || !end) {
    throw new CalendarDataError('start and end query parameters are required', {
      code: 'CALENDAR_RANGE_REQUIRED',
      status: 400,
    });
  }
  const startDate = parseDateKey(start, 'start');
  const endDate = parseDateKey(end, 'end');
  if (startDate.getTime() > endDate.getTime()) {
    throw new CalendarDataError('start must be on or before end', {
      code: 'CALENDAR_RANGE_REVERSED',
      status: 400,
    });
  }
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1;
  if (days > maxDays) {
    throw new CalendarDataError(`date range cannot exceed ${maxDays} days`, {
      code: 'CALENDAR_RANGE_TOO_LARGE',
      status: 400,
    });
  }
  return { start, end, days };
}

export function normalizeUsSymbol(value) {
  let symbol = String(value || '').trim().toUpperCase();
  symbol = symbol.replace(/^\$/, '').replace(/^US:/, '');
  if (/^[A-Z0-9]+-[A-Z]$/.test(symbol)) {
    symbol = symbol.replace(/-([A-Z])$/, '.$1');
  }
  return symbol;
}

export function canonicalizeUsCompanySymbol(value) {
  const symbol = normalizeUsSymbol(value);
  return US_COMPANY_SYMBOL_ALIASES.get(symbol) || symbol;
}

export function isNonCompanyUsPosition(position) {
  const rawSymbol = String(position?.code || position?.symbol || '').trim().toUpperCase();
  const symbol = normalizeUsSymbol(rawSymbol);
  if (!symbol) return true;
  if (NON_COMPANY_US_SYMBOLS.has(rawSymbol) || NON_COMPANY_US_SYMBOLS.has(symbol)) return true;
  if (symbol.startsWith('^') || symbol.endsWith('=F')) return true;

  const type = String(position?.type || position?.assetType || '').toLowerCase();
  if (['etf', 'fund', 'index', 'future', 'futures'].includes(type)) return true;

  const name = String(position?.name || '');
  return /(?:\bETF\b|\bFutures?\b|指数|期货|交易所交易基金)/i.test(name);
}

export function buildUsSubsetIndex(fundsData) {
  if (!isPlainObject(fundsData) || !Array.isArray(fundsData.funds)) {
    throw new CalendarDataError('funds.json must contain a funds array', {
      code: 'CALENDAR_FUNDS_INVALID',
      status: 500,
    });
  }

  const index = new Map();
  for (const fund of fundsData.funds) {
    if (fund?.market !== 'us' || !Array.isArray(fund.positions)) continue;
    const fundId = String(fund.id || '').trim();
    const fundName = String(fund.name || '').trim();
    if (!fundId || !fundName) continue;

    for (const position of fund.positions) {
      if (isNonCompanyUsPosition(position)) continue;
      const symbol = canonicalizeUsCompanySymbol(position?.code || position?.symbol);
      if (!symbol) continue;
      const hits = index.get(symbol) || [];
      const key = `${fundId}\u0000${symbol}`;
      if (!hits.some((hit) => `${hit.fundId}\u0000${hit.symbol}` === key)) {
        hits.push({ fundId, fundName, symbol });
      }
      index.set(symbol, hits);
    }
  }

  for (const hits of index.values()) {
    hits.sort((a, b) => a.fundName.localeCompare(b.fundName, 'zh-Hans-CN'));
  }
  return index;
}

function normalizeStringList(value, field, transform = (item) => item) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new CalendarDataError(`${field} must be an array`);
  }
  return [...new Set(value.map((item, index) => transform(requireString(item, `${field}[${index}]`))))];
}

function normalizeMetrics(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new CalendarDataError(`${field} must be an object`);
  const metrics = {};
  for (const key of ['previous', 'forecast', 'actual']) {
    const metric = value[key];
    if (metric !== undefined && metric !== null && typeof metric !== 'string' && typeof metric !== 'number') {
      throw new CalendarDataError(`${field}.${key} must be a string, number, or null`);
    }
    if (metric !== undefined) metrics[key] = metric;
  }
  const unit = optionalString(value.unit, `${field}.unit`);
  if (unit !== undefined) metrics.unit = unit;
  return metrics;
}

function normalizeEarnings(value, field) {
  if (!isPlainObject(value)) throw new CalendarDataError(`${field} must be an object`);
  const symbol = normalizeUsSymbol(requireString(value.symbol, `${field}.symbol`));
  const session = value.session || 'unknown';
  if (!['before_market', 'after_market', 'unknown'].includes(session)) {
    throw new CalendarDataError(`${field}.session is invalid`);
  }
  return {
    symbol,
    ...(optionalString(value.company, `${field}.company`) ? { company: value.company.trim() } : {}),
    ...(optionalString(value.period, `${field}.period`) ? { period: value.period.trim() } : {}),
    session,
    ...(optionalString(value.currency, `${field}.currency`)
      ? { currency: value.currency.trim().toUpperCase() }
      : {}),
    ...(value.epsEstimate !== undefined
      ? { epsEstimate: optionalFiniteNumber(value.epsEstimate, `${field}.epsEstimate`) }
      : {}),
    ...(value.revenueEstimate !== undefined
      ? { revenueEstimate: optionalFiniteNumber(value.revenueEstimate, `${field}.revenueEstimate`) }
      : {}),
    ...(value.marketCap !== undefined
      ? { marketCap: optionalFiniteNumber(value.marketCap, `${field}.marketCap`) }
      : {}),
  };
}

function normalizeSource(value, field) {
  if (!isPlainObject(value)) throw new CalendarDataError(`${field} must be an object`);
  const name = requireString(value.name, `${field}.name`);
  if (!CALENDAR_SOURCE_NAMES.includes(name)) {
    throw new CalendarDataError(`${field}.name is invalid`);
  }
  const url = requireString(value.url, `${field}.url`);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new CalendarDataError(`${field}.url must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new CalendarDataError(`${field}.url must use http or https`);
  }
  const sourceId = optionalString(value.sourceId, `${field}.sourceId`);
  return {
    name,
    ...(sourceId ? { sourceId } : {}),
    url,
    fetchedAt: validateIsoTimestamp(value.fetchedAt, `${field}.fetchedAt`),
  };
}

export function normalizeCalendarEvent(value, index = 0) {
  const field = `events[${index}]`;
  if (!isPlainObject(value)) throw new CalendarDataError(`${field} must be an object`);

  const kind = requireString(value.kind, `${field}.kind`);
  if (!CALENDAR_KINDS.includes(kind)) throw new CalendarDataError(`${field}.kind is invalid`);
  const region = requireString(value.region, `${field}.region`);
  if (!['CN', 'US'].includes(region)) throw new CalendarDataError(`${field}.region is invalid`);
  parseDateKey(value.date, `${field}.date`);
  const endDate = optionalString(value.endDate, `${field}.endDate`);
  if (endDate) {
    parseDateKey(endDate, `${field}.endDate`);
    if (endDate < value.date) {
      throw new CalendarDataError(`${field}.endDate must be on or after date`);
    }
  }

  const timePrecision = requireString(value.timePrecision, `${field}.timePrecision`);
  if (!CALENDAR_TIME_PRECISIONS.includes(timePrecision)) {
    throw new CalendarDataError(`${field}.timePrecision is invalid`);
  }
  const startAt = optionalString(value.startAt, `${field}.startAt`);
  if (timePrecision === 'exact' && !startAt) {
    throw new CalendarDataError(`${field}.startAt is required when timePrecision is exact`);
  }
  if (startAt) validateIsoTimestamp(startAt, `${field}.startAt`);

  const importance = Number(value.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new CalendarDataError(`${field}.importance must be an integer from 1 to 5`);
  }
  const status = requireString(value.status, `${field}.status`);
  if (!CALENDAR_STATUSES.includes(status)) throw new CalendarDataError(`${field}.status is invalid`);

  const earnings = value.earnings === undefined ? undefined : normalizeEarnings(value.earnings, `${field}.earnings`);
  if (kind === 'us_earnings' && !earnings) {
    throw new CalendarDataError(`${field}.earnings is required for us_earnings`);
  }

  const symbols = normalizeStringList(value.symbols, `${field}.symbols`, (symbol) => (
    kind === 'us_earnings' ? normalizeUsSymbol(symbol) : symbol.trim().toUpperCase()
  ));
  const eventSymbols = kind === 'us_earnings'
    ? [...new Set([earnings.symbol, ...(symbols || [])])]
    : symbols;
  const metrics = normalizeMetrics(value.metrics, `${field}.metrics`);
  const tags = normalizeStringList(value.tags, `${field}.tags`);
  const summary = optionalString(value.summary, `${field}.summary`);
  const country = optionalString(value.country, `${field}.country`);

  return {
    id: requireString(value.id, `${field}.id`),
    kind,
    title: requireString(value.title, `${field}.title`),
    region,
    ...(country ? { country } : {}),
    date: value.date,
    ...(endDate ? { endDate } : {}),
    ...(startAt ? { startAt } : {}),
    timezone: validateTimezone(value.timezone, `${field}.timezone`),
    timePrecision,
    importance,
    status,
    ...(eventSymbols ? { symbols: eventSymbols } : {}),
    ...(metrics ? { metrics } : {}),
    ...(earnings ? { earnings } : {}),
    ...(tags ? { tags } : {}),
    ...(summary ? { summary } : {}),
    source: normalizeSource(value.source, `${field}.source`),
  };
}

function normalizeSourceStatuses(value) {
  const raw = isPlainObject(value) ? value : {};
  const result = {};
  for (const sourceName of CALENDAR_SOURCE_NAMES) {
    const fallback = DEFAULT_SOURCE_STATUS[sourceName];
    const current = isPlainObject(raw[sourceName]) ? raw[sourceName] : {};
    const forceManualStatus = sourceName === 'company_ir';
    const status = !forceManualStatus && CALENDAR_SOURCE_STATUSES.includes(current.status)
      ? current.status
      : fallback.status;
    const updatedAt = forceManualStatus || current.updatedAt === null || current.updatedAt === undefined
      ? fallback.updatedAt
      : validateIsoTimestamp(current.updatedAt, `sources.${sourceName}.updatedAt`);
    result[sourceName] = {
      status,
      updatedAt,
      message: !forceManualStatus && typeof current.message === 'string' && current.message.trim()
        ? current.message.trim()
        : fallback.message,
    };
  }
  return result;
}

async function readJsonFile(filePath, code) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new CalendarDataError(`${path.basename(filePath)} could not be read`, {
      code,
      status: 500,
      cause: error,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CalendarDataError(`${path.basename(filePath)} is not valid JSON`, {
      code,
      status: 500,
      cause: error,
    });
  }
}

export function enrichEventsWithSubsetHits(events, subsetIndex) {
  return events.map((event) => {
    if (event.kind !== 'us_earnings') return event;
    const symbol = normalizeUsSymbol(event.earnings?.symbol || event.symbols?.[0]);
    const subsetKey = canonicalizeUsCompanySymbol(symbol);
    const subsetHits = (subsetIndex.get(subsetKey) || []).map((hit) => ({ ...hit }));
    return {
      ...event,
      symbols: [...new Set([symbol, ...(event.symbols || []).map(normalizeUsSymbol)].filter(Boolean))],
      earnings: { ...event.earnings, symbol },
      subsetHits,
    };
  });
}

export async function readCalendarStore({
  dataFile = DEFAULT_CALENDAR_FILE,
  manualFile,
  fundsFile = DEFAULT_FUNDS_FILE,
} = {}) {
  const resolvedManualFile = manualFile || (dataFile === DEFAULT_CALENDAR_FILE
    ? DEFAULT_MANUAL_CALENDAR_FILE
    : path.join(path.dirname(dataFile), 'manual-events.json'));
  const [dataStat, manualStat, fundsStat] = await Promise.all([
    fs.promises.stat(dataFile).catch(() => null),
    fs.promises.stat(resolvedManualFile).catch(() => null),
    fs.promises.stat(fundsFile).catch(() => null),
  ]);
  const cacheKey = `${dataFile}\u0000${resolvedManualFile}\u0000${fundsFile}`;
  const cacheSignature = [
    dataStat?.mtimeMs || 0,
    dataStat?.size || 0,
    manualStat?.mtimeMs || 0,
    manualStat?.size || 0,
    fundsStat?.mtimeMs || 0,
    fundsStat?.size || 0,
  ].join(':');
  const cached = CALENDAR_STORE_CACHE.get(cacheKey);
  if (cached?.signature === cacheSignature) return cached.value;

  const [data, manualData, fundsData] = await Promise.all([
    dataStat
      ? readJsonFile(dataFile, 'CALENDAR_STORE_UNAVAILABLE')
      : Promise.resolve({ schemaVersion: 1, updatedAt: null, sources: {}, events: [] }),
    manualStat
      ? readJsonFile(resolvedManualFile, 'CALENDAR_MANUAL_STORE_UNAVAILABLE')
      : Promise.resolve({ schemaVersion: 1, updatedAt: null, sources: {}, events: [] }),
    readJsonFile(fundsFile, 'CALENDAR_FUNDS_UNAVAILABLE'),
  ]);
  if (!isPlainObject(data) || !Array.isArray(data.events)) {
    throw new CalendarDataError('events.json must contain an events array');
  }
  if (!isPlainObject(manualData) || !Array.isArray(manualData.events)) {
    throw new CalendarDataError('manual-events.json must contain an events array');
  }

  const normalizeStoredEvent = (event, index) => {
    try {
      return normalizeCalendarEvent(event, index);
    } catch (error) {
      if (error instanceof CalendarDataError) {
        error.status = 500;
        error.code = 'CALENDAR_EVENT_INVALID';
      }
      throw error;
    }
  };
  const normalizedManualEvents = manualData.events.map(normalizeStoredEvent);
  const normalizedRuntimeEvents = data.events.map((event, index) => (
    normalizeStoredEvent(event, normalizedManualEvents.length + index)
  ));
  const mergedEvents = new Map(normalizedManualEvents.map((event) => [event.id, event]));
  for (const event of normalizedRuntimeEvents) mergedEvents.set(event.id, event);
  const normalizedEvents = [...mergedEvents.values()];
  const subsetIndex = buildUsSubsetIndex(fundsData);
  const events = enrichEventsWithSubsetHits(normalizedEvents, subsetIndex);
  const runtimeUpdatedAt = data.updatedAt
    ? validateIsoTimestamp(data.updatedAt, 'updatedAt')
    : dataStat?.mtime?.toISOString() || null;
  const manualUpdatedAt = manualData.updatedAt
    ? validateIsoTimestamp(manualData.updatedAt, 'manualUpdatedAt')
    : manualStat?.mtime?.toISOString() || null;
  const updatedAt = [runtimeUpdatedAt, manualUpdatedAt]
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) || null;

  const value = {
    schemaVersion: Math.max(
      Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1,
      Number.isInteger(manualData.schemaVersion) ? manualData.schemaVersion : 1,
    ),
    updatedAt,
    sources: normalizeSourceStatuses({
      ...(isPlainObject(data.sources) ? data.sources : {}),
      ...(isPlainObject(manualData.sources) ? manualData.sources : {}),
    }),
    events,
  };
  CALENDAR_STORE_CACHE.set(cacheKey, { signature: cacheSignature, value });
  return value;
}

export function compareCalendarEvents(left, right) {
  const dateDiff = left.date.localeCompare(right.date);
  if (dateDiff !== 0) return dateDiff;

  const precisionDiff = TIME_PRECISION_ORDER[left.timePrecision] - TIME_PRECISION_ORDER[right.timePrecision];
  if (precisionDiff !== 0) return precisionDiff;

  if (left.startAt && right.startAt) {
    const timeDiff = Date.parse(left.startAt) - Date.parse(right.startAt);
    if (timeDiff !== 0) return timeDiff;
  }

  const importanceDiff = right.importance - left.importance;
  if (importanceDiff !== 0) return importanceDiff;
  const titleDiff = left.title.localeCompare(right.title, 'zh-Hans-CN');
  if (titleDiff !== 0) return titleDiff;
  return left.id.localeCompare(right.id);
}

export function selectCalendarEvents(events, start, end) {
  const selected = events.filter((event) => (
    event.date <= end
    && (event.endDate || event.date) >= start
    && (event.kind !== 'us_earnings' || (event.subsetHits?.length || 0) > 0)
  ));
  const deduped = [];
  const aliasEventIndexes = new Map();

  for (const event of selected) {
    if (event.kind !== 'us_earnings') {
      deduped.push(event);
      continue;
    }
    const symbol = normalizeUsSymbol(event.earnings?.symbol || event.symbols?.[0]);
    const canonicalSymbol = canonicalizeUsCompanySymbol(symbol);
    if (!US_COMPANY_ALIAS_CANONICAL_SYMBOLS.has(canonicalSymbol)) {
      deduped.push(event);
      continue;
    }
    const aliasKey = [
      canonicalSymbol,
      event.date,
      event.earnings?.period || '',
    ].join('\u0000');
    const existingIndex = aliasEventIndexes.get(aliasKey);
    if (existingIndex === undefined) {
      aliasEventIndexes.set(aliasKey, deduped.length);
      deduped.push(event);
      continue;
    }
    const existing = deduped[existingIndex];
    const existingSymbol = normalizeUsSymbol(existing.earnings?.symbol || existing.symbols?.[0]);
    const symbols = [...new Set([...(existing.symbols || []), ...(event.symbols || [])])];
    const subsetHits = [...new Map(
      [...(existing.subsetHits || []), ...(event.subsetHits || [])]
        .map((hit) => [`${hit.fundId}\u0000${hit.symbol}`, hit]),
    ).values()];
    if (symbol === canonicalSymbol && existingSymbol !== canonicalSymbol) {
      deduped[existingIndex] = { ...event, symbols, subsetHits };
    } else {
      deduped[existingIndex] = { ...existing, symbols, subsetHits };
    }
  }

  return deduped.sort(compareCalendarEvents);
}
