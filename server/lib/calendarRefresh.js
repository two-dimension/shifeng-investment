import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { CalendarDataError } from './calendarStore.js';

export const EARNINGS_HUB_CALENDAR_URL =
  'https://api.savvytrader.com/pricing/assets/earnings/calendar';
export const NASDAQ_EARNINGS_CALENDAR_URL =
  'https://api.nasdaq.com/api/calendar/earnings';
export const BLS_PUBLIC_DATA_URL =
  'https://api.bls.gov/publicAPI/v2/timeseries/data/';
export const NBS_DATA_RELEASES_URL =
  'https://www.stats.gov.cn/sj/zxfb/';
export const NBS_RELEASES_AGGREGATE_URL =
  'https://www.stats.gov.cn/sj/zxfbhjd/';

const BLS_MACRO_DEFINITIONS = Object.freeze([
  {
    key: 'cpi',
    label: 'CPI',
    pattern: /^美国(\d{1,2})月CPI$/,
    sourceUrl: 'https://www.bls.gov/news.release/cpi.nr0.htm',
    series: {
      headlineSa: 'CUSR0000SA0',
      headlineNsa: 'CUUR0000SA0',
      coreSa: 'CUSR0000SA0L1E',
      coreNsa: 'CUUR0000SA0L1E',
    },
  },
  {
    key: 'ppi',
    label: 'PPI',
    pattern: /^美国(\d{1,2})月PPI$/,
    sourceUrl: 'https://www.bls.gov/news.release/ppi.nr0.htm',
    series: {
      headlineSa: 'WPSFD4',
      headlineNsa: 'WPUFD4',
      coreSa: 'WPSFD49116',
      coreNsa: 'WPUFD49116',
    },
  },
]);

const isPlainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);

const EARNINGS_NAME_OVERRIDES = Object.freeze({
  BNY: 'BNY Mellon',
  CAG: 'Conagra Brands',
});

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalendarDataError(`Earnings calendar ${field} is missing`, {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
    });
  }
  return value.trim();
};

const optionalFiniteNumber = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const periodLabel = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || '待定报告期';
};

const sessionFromTime = (value) => {
  if (typeof value !== 'string') return 'unknown';
  const [hourText, minuteText = '0'] = value.split(':');
  const minutes = Number(hourText) * 60 + Number(minuteText);
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 9 * 60 + 30) return 'before_market';
  if (minutes >= 16 * 60) return 'after_market';
  return 'unknown';
};

const sessionFromNasdaq = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('pre-market')) return 'before_market';
  if (normalized.includes('after-hours') || normalized.includes('post-market')) return 'after_market';
  return 'unknown';
};

const parseNasdaqEstimate = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = value.trim();
  if (!text || /n\/a|not available/i.test(text)) return undefined;
  const negative = text.startsWith('(') && text.endsWith(')');
  const numeric = Number(text.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(numeric)) return undefined;
  return negative ? -Math.abs(numeric) : numeric;
};

const importanceFromRecord = (record) => {
  const explicit = Number(record?.importance);
  return Number.isFinite(explicit) ? Math.max(1, Math.min(5, Math.round(explicit))) : 3;
};

export function normalizeEarningsHubRecord(record, fetchedAt) {
  if (!isPlainObject(record)) {
    throw new CalendarDataError('EarningsHub returned a non-object event', {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
    });
  }

  const symbol = requiredText(record.symbol, 'symbol').toUpperCase();
  const date = requiredText(record.earningsDate, 'earningsDate');
  const period = periodLabel(record.period || String(record.sk || '').split('#').at(-1));
  const periodYear = Number.isInteger(record.periodYear)
    ? record.periodYear
    : Number(String(record.sk || '').split('#')[1]) || Number(date.slice(0, 4));
  const company = EARNINGS_NAME_OVERRIDES[symbol]
    || (typeof record.assetName === 'string' && record.assetName.trim()
      ? record.assetName.trim()
      : symbol);
  const startAt = typeof record.earningsDateTime === 'string'
    && Number.isFinite(Date.parse(record.earningsDateTime))
    ? record.earningsDateTime
    : undefined;
  const externalId = typeof record.externalId === 'string' && record.externalId.trim()
    ? record.externalId.trim()
    : `${symbol}-${periodYear}-${period}-${date}`;
  const earnings = {
    symbol,
    company,
    period: `${periodYear} ${period}`,
    session: sessionFromTime(record.earningsTime),
    currency: 'USD',
  };
  const epsEstimate = optionalFiniteNumber(record.epsEstimate);
  const revenueEstimate = optionalFiniteNumber(record.revenueEstimate);
  if (epsEstimate !== undefined) earnings.epsEstimate = epsEstimate;
  if (revenueEstimate !== undefined) earnings.revenueEstimate = revenueEstimate;

  return {
    id: `earningshub-${symbol.toLowerCase()}-${periodYear}-${period.toLowerCase()}-${date}`,
    kind: 'us_earnings',
    title: `${company} ${periodYear} ${period}财报`,
    region: 'US',
    date,
    ...(startAt ? { startAt } : {}),
    timezone: 'America/New_York',
    timePrecision: startAt ? 'exact' : 'session',
    importance: importanceFromRecord(record),
    status: record.isDateConfirmed === false ? 'estimated' : 'confirmed',
    symbols: [symbol],
    earnings,
    tags: ['财报'],
    source: {
      name: 'earningshub',
      sourceId: externalId,
      url: `https://earningshub.com/quote/${encodeURIComponent(symbol)}`,
      fetchedAt,
    },
  };
}

export function normalizeNasdaqRecord(record, date, fetchedAt, earningsHubRecord) {
  if (!isPlainObject(record)) {
    throw new CalendarDataError('Nasdaq returned a non-object event', {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
    });
  }
  const symbol = requiredText(record.symbol, 'symbol').toUpperCase();
  const company = EARNINGS_NAME_OVERRIDES[symbol]
    || requiredText(record.name || earningsHubRecord?.assetName || symbol, 'company name');
  const hubPeriod = earningsHubRecord
    ? `${earningsHubRecord.periodYear || date.slice(0, 4)} ${periodLabel(earningsHubRecord.period)}`
    : '';
  const period = hubPeriod || String(record.fiscalQuarterEnding || '').trim() || '待定报告期';
  const startAt = typeof earningsHubRecord?.earningsDateTime === 'string'
    && Number.isFinite(Date.parse(earningsHubRecord.earningsDateTime))
    ? earningsHubRecord.earningsDateTime
    : undefined;
  const earnings = {
    symbol,
    company,
    period,
    session: sessionFromNasdaq(record.time) === 'unknown'
      ? sessionFromTime(earningsHubRecord?.earningsTime)
      : sessionFromNasdaq(record.time),
    currency: 'USD',
  };
  const epsEstimate = parseNasdaqEstimate(record.epsForecast)
    ?? optionalFiniteNumber(earningsHubRecord?.epsEstimate);
  const revenueEstimate = optionalFiniteNumber(earningsHubRecord?.revenueEstimate);
  if (epsEstimate !== undefined) earnings.epsEstimate = epsEstimate;
  if (revenueEstimate !== undefined) earnings.revenueEstimate = revenueEstimate;

  return {
    id: `nasdaq-${symbol.toLowerCase()}-${date}`,
    kind: 'us_earnings',
    title: `${company} ${period}财报`,
    region: 'US',
    date,
    ...(startAt ? { startAt } : {}),
    timezone: 'America/New_York',
    timePrecision: startAt ? 'exact' : 'session',
    importance: importanceFromRecord(earningsHubRecord),
    status: earningsHubRecord?.isDateConfirmed === false ? 'estimated' : 'confirmed',
    symbols: [symbol],
    earnings,
    tags: ['财报'],
    summary: record.noOfEsts ? `Nasdaq EPS 一致预期样本数：${record.noOfEsts}` : undefined,
    source: {
      name: 'nasdaq',
      sourceId: `${date}-${symbol}`,
      url: 'https://www.nasdaq.com/market-activity/earnings',
      fetchedAt,
    },
  };
}

const readStoreFile = async (dataFile) => {
  try {
    const raw = await fs.promises.readFile(dataFile, 'utf8');
    const data = JSON.parse(raw);
    if (!isPlainObject(data) || !Array.isArray(data.events)) throw new Error('invalid store');
    return data;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { schemaVersion: 1, updatedAt: null, sources: {}, events: [] };
    }
    throw new CalendarDataError(`${path.basename(dataFile)} could not be refreshed`, {
      code: 'CALENDAR_STORE_UNAVAILABLE',
      status: 500,
      cause: error,
    });
  }
};

const writeStoreFile = async (dataFile, data) => {
  const tempFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(dataFile), { recursive: true });
    await fs.promises.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tempFile, dataFile);
  } catch (error) {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    throw new CalendarDataError(`${path.basename(dataFile)} could not be updated`, {
      code: 'CALENDAR_STORE_WRITE_FAILED',
      status: 500,
      cause: error,
    });
  }
};

const fetchWithNodeHttps = (url, options = {}) => new Promise((resolve, reject) => {
  const body = typeof options.body === 'string' ? options.body : undefined;
  const request = https.request(url, {
    family: 4,
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (compatible; ShifengInvestmentCalendar/1.0)',
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      ...options.headers,
    },
    timeout: 15_000,
  }, (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        request.destroy(new Error('Earnings calendar response is too large'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode || 502,
        json: async () => JSON.parse(body),
        text: async () => body,
      });
    });
  });
  request.on('timeout', () => request.destroy(new Error('Earnings calendar request timed out')));
  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

const requestJson = async (url, requestCalendar, options = {}) => {
  let response;
  let connectionError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await requestCalendar(url, {
        ...options,
        headers: { Accept: 'application/json', ...options.headers },
      });
      if (response?.ok || (response?.status && response.status < 500)) break;
    } catch (error) {
      connectionError = error;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!response?.ok) {
    throw new CalendarDataError(`日历数据源刷新失败（HTTP ${response?.status || 502}）`, {
      code: 'CALENDAR_REFRESH_SOURCE_UNAVAILABLE',
      status: 502,
      cause: connectionError,
    });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CalendarDataError('日历数据源返回了无效数据', {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
      cause: error,
    });
  }
};

const requestText = async (url, requestCalendar, options = {}) => {
  let response;
  let connectionError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await requestCalendar(url, {
        ...options,
        headers: { Accept: 'text/html, text/plain, */*', ...options.headers },
      });
      if (response?.ok || (response?.status && response.status < 500)) break;
    } catch (error) {
      connectionError = error;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!response?.ok) {
    throw new CalendarDataError(`日历数据源刷新失败（HTTP ${response?.status || 502}）`, {
      code: 'CALENDAR_REFRESH_SOURCE_UNAVAILABLE',
      status: 502,
      cause: connectionError,
    });
  }
  try {
    return await response.text();
  } catch (error) {
    throw new CalendarDataError('日历数据源返回了无效文本', {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
      cause: error,
    });
  }
};

const monthPeriod = (month) => `M${String(month).padStart(2, '0')}`;

const previousMonth = (year, month) => (
  month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
);

const referenceYearForEvent = (event, referenceMonth) => {
  const releaseYear = Number(String(event.date || '').slice(0, 4));
  const releaseMonth = Number(String(event.date || '').slice(5, 7));
  return referenceMonth > releaseMonth ? releaseYear - 1 : releaseYear;
};

const observation = (seriesIndex, seriesId, year, month) => {
  const rows = seriesIndex.get(seriesId) || [];
  const item = rows.find((row) => Number(row.year) === year && row.period === monthPeriod(month));
  const value = Number(item?.value);
  return Number.isFinite(value) ? value : undefined;
};

const percentChange = (current, comparison) => {
  if (!Number.isFinite(current) || !Number.isFinite(comparison) || comparison === 0) return undefined;
  const rounded = Math.round((((current / comparison) - 1) * 100) * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const signedPercent = (value) => {
  if (!Number.isFinite(value)) return '';
  if (value > 0) return `+${value.toFixed(1)}%`;
  return `${value.toFixed(1)}%`;
};

const normalizeBlsSeries = (payload) => {
  if (payload?.status !== 'REQUEST_SUCCEEDED' || !Array.isArray(payload?.Results?.series)) {
    throw new CalendarDataError('BLS 返回了无效数据', {
      code: 'CALENDAR_REFRESH_SOURCE_INVALID',
      status: 502,
    });
  }
  return new Map(payload.Results.series.map((series) => [
    String(series?.seriesID || '').toUpperCase(),
    Array.isArray(series?.data) ? series.data : [],
  ]));
};

const macroDefinitionForEvent = (event) => {
  for (const definition of BLS_MACRO_DEFINITIONS) {
    const match = String(event?.title || '').trim().match(definition.pattern);
    if (match) return { definition, referenceMonth: Number(match[1]) };
  }
  return undefined;
};

const buildBlsActual = (seriesIndex, definition, referenceYear, referenceMonth) => {
  const priorMonth = previousMonth(referenceYear, referenceMonth);
  const headlineCurrentSa = observation(
    seriesIndex,
    definition.series.headlineSa,
    referenceYear,
    referenceMonth,
  );
  const headlinePreviousSa = observation(
    seriesIndex,
    definition.series.headlineSa,
    priorMonth.year,
    priorMonth.month,
  );
  const headlineCurrentNsa = observation(
    seriesIndex,
    definition.series.headlineNsa,
    referenceYear,
    referenceMonth,
  );
  const headlineYearAgoNsa = observation(
    seriesIndex,
    definition.series.headlineNsa,
    referenceYear - 1,
    referenceMonth,
  );
  const coreCurrentSa = observation(
    seriesIndex,
    definition.series.coreSa,
    referenceYear,
    referenceMonth,
  );
  const corePreviousSa = observation(
    seriesIndex,
    definition.series.coreSa,
    priorMonth.year,
    priorMonth.month,
  );
  const coreCurrentNsa = observation(
    seriesIndex,
    definition.series.coreNsa,
    referenceYear,
    referenceMonth,
  );
  const coreYearAgoNsa = observation(
    seriesIndex,
    definition.series.coreNsa,
    referenceYear - 1,
    referenceMonth,
  );
  const headlineMom = percentChange(headlineCurrentSa, headlinePreviousSa);
  const headlineYoy = percentChange(headlineCurrentNsa, headlineYearAgoNsa);
  const coreMom = percentChange(coreCurrentSa, corePreviousSa);
  const coreYoy = percentChange(coreCurrentNsa, coreYearAgoNsa);
  if (![headlineMom, headlineYoy, coreMom, coreYoy].every(Number.isFinite)) return undefined;
  return {
    headlineMom,
    headlineYoy,
    coreMom,
    coreYoy,
    label: [
      `同比${signedPercent(headlineYoy)}`,
      `环比${signedPercent(headlineMom)}`,
      `核心同比${signedPercent(coreYoy)}`,
      `核心环比${signedPercent(coreMom)}`,
    ].join(' · '),
  };
};

const dateKeys = (start, end) => {
  const dates = [];
  let cursor = new Date(`${start}T12:00:00.000Z`);
  const last = new Date(`${end}T12:00:00.000Z`);
  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
};

const boundedDateRanges = (start, end, maximumDays = 7) => {
  const ranges = [];
  let cursor = new Date(`${start}T12:00:00.000Z`);
  const last = new Date(`${end}T12:00:00.000Z`);
  while (cursor <= last) {
    const rangeStart = cursor.toISOString().slice(0, 10);
    const rangeEndDate = new Date(Math.min(
      cursor.getTime() + ((maximumDays - 1) * 86_400_000),
      last.getTime(),
    ));
    ranges.push({ start: rangeStart, end: rangeEndDate.toISOString().slice(0, 10) });
    cursor = new Date(rangeEndDate.getTime() + 86_400_000);
  }
  return ranges;
};

const fetchEarningsHubRanges = async (start, end, requestCalendar) => {
  const results = await Promise.all(boundedDateRanges(start, end).map(async (range) => {
    try {
      const query = new URLSearchParams(range);
      const payload = await requestJson(
        `${EARNINGS_HUB_CALENDAR_URL}?${query.toString()}`,
        requestCalendar,
      );
      if (!Array.isArray(payload) || payload.length > 2_000) {
        throw new Error('invalid EarningsHub payload');
      }
      return { payload };
    } catch (error) {
      return { payload: [], error };
    }
  }));
  return {
    payload: results.flatMap((result) => result.payload),
    errors: results.filter((result) => result.error).map((result) => result.error),
  };
};

const fetchNasdaqDays = async (start, end, requestCalendar) => {
  const dates = dateKeys(start, end);
  const days = [];
  const errors = [];
  for (let offset = 0; offset < dates.length; offset += 5) {
    const batch = dates.slice(offset, offset + 5);
    const results = await Promise.all(batch.map(async (date) => {
      try {
        const payload = await requestJson(
          `${NASDAQ_EARNINGS_CALENDAR_URL}?date=${encodeURIComponent(date)}`,
          requestCalendar,
        );
        const rows = payload?.data?.rows;
        if (rows !== null && !Array.isArray(rows)) throw new Error('invalid Nasdaq rows');
        return { date, rows: rows || [] };
      } catch (error) {
        return { date, error };
      }
    }));
    for (const result of results) {
      if (result.error) errors.push(result);
      else days.push(result);
    }
  }
  return { days, errors };
};

export async function refreshEarningsHubCalendar({
  dataFile,
  start,
  end,
  fetchImpl,
  now = () => new Date(),
}) {
  const requestCalendar = fetchImpl || fetchWithNodeHttps;
  const hub = await fetchEarningsHubRanges(start, end, requestCalendar);
  const hubPayload = hub.payload;
  const hubError = hub.errors[0];

  const nasdaq = await fetchNasdaqDays(start, end, requestCalendar);
  if (hubError && nasdaq.days.length === 0) {
    throw new CalendarDataError('Nasdaq 与 EarningsHub 暂时均无法连接', {
      code: 'CALENDAR_REFRESH_SOURCE_UNAVAILABLE',
      status: 502,
      cause: hubError,
    });
  }

  const fetchedAt = now().toISOString();
  const hubIndex = new Map(hubPayload.map((record) => [
    `${record.earningsDate}|${String(record.symbol || '').toUpperCase()}`,
    record,
  ]));
  const refreshedEvents = [];
  const usedKeys = new Set();
  for (const day of nasdaq.days) {
    for (const record of day.rows) {
      const symbol = String(record?.symbol || '').toUpperCase();
      if (!symbol) continue;
      const key = `${day.date}|${symbol}`;
      refreshedEvents.push(normalizeNasdaqRecord(record, day.date, fetchedAt, hubIndex.get(key)));
      usedKeys.add(key);
    }
  }
  for (const record of hubPayload) {
    const key = `${record.earningsDate}|${String(record.symbol || '').toUpperCase()}`;
    if (!usedKeys.has(key)) refreshedEvents.push(normalizeEarningsHubRecord(record, fetchedAt));
  }

  const store = await readStoreFile(dataFile);
  const retainedEvents = store.events.filter((event) => !(
    event?.kind === 'us_earnings'
    && ['earningshub', 'nasdaq'].includes(event?.source?.name)
    && event.date <= end
    && (event.endDate || event.date) >= start
  ));
  const nextStore = {
    ...store,
    updatedAt: fetchedAt,
    sources: {
      ...(isPlainObject(store.sources) ? store.sources : {}),
      nasdaq: {
        status: nasdaq.errors.length > 0 ? 'stale' : 'ready',
        updatedAt: fetchedAt,
        message: nasdaq.errors.length > 0
          ? `Nasdaq 已更新，${nasdaq.errors.length}个交易日暂时失败；缺口由 EarningsHub 补充。`
          : '由用户点击刷新按钮后，从 Nasdaq 公开财报日历补全公司日程。',
      },
      earningshub: {
        status: hubError ? 'stale' : 'ready',
        updatedAt: hubError ? store.sources?.earningshub?.updatedAt || null : fetchedAt,
        message: hubError
          ? `EarningsHub 有${hub.errors.length}个日期区间未连接成功，当前保留 Nasdaq 日程与已取得的预期字段。`
          : '由用户点击刷新按钮后，从 EarningsHub 补充营收预期及精确发布时间。',
      },
    },
    meta: {
      ...(isPlainObject(store.meta) ? store.meta : {}),
      generatedAt: fetchedAt,
    },
    events: [...retainedEvents, ...refreshedEvents],
  };
  await writeStoreFile(dataFile, nextStore);

  return {
    updatedAt: fetchedAt,
    source: 'nasdaq+earningshub',
    range: { start, end },
    count: refreshedEvents.length,
    sourceCounts: {
      nasdaq: refreshedEvents.filter((event) => event.source.name === 'nasdaq').length,
      earningshub: refreshedEvents.filter((event) => event.source.name === 'earningshub').length,
    },
  };
}

export async function refreshBlsMacroCalendar({
  dataFile,
  start,
  end,
  fetchImpl,
  now = () => new Date(),
}) {
  const store = await readStoreFile(dataFile);
  const candidates = store.events
    .filter((event) => event?.kind === 'macro'
      && event.date <= end
      && (event.endDate || event.date) >= start)
    .map((event) => ({ event, match: macroDefinitionForEvent(event) }))
    .filter((item) => item.match);
  if (candidates.length === 0) {
    return {
      status: 'ready',
      source: 'bls',
      range: { start, end },
      checked: 0,
      updated: 0,
      message: '当前范围没有需要从BLS更新实际值的宏观指标。',
    };
  }

  const years = candidates.map(({ event, match }) => (
    referenceYearForEvent(event, match.referenceMonth)
  ));
  const seriesIds = [...new Set(candidates.flatMap(({ match }) => (
    Object.values(match.definition.series)
  )))];
  const requestCalendar = fetchImpl || fetchWithNodeHttps;
  const payload = await requestJson(BLS_PUBLIC_DATA_URL, requestCalendar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seriesid: seriesIds,
      startyear: String(Math.min(...years) - 1),
      endyear: String(Math.max(...years)),
    }),
  });
  const seriesIndex = normalizeBlsSeries(payload);
  const fetchedAt = now().toISOString();
  const updates = new Map();
  for (const { event, match } of candidates) {
    const referenceYear = referenceYearForEvent(event, match.referenceMonth);
    const actual = buildBlsActual(
      seriesIndex,
      match.definition,
      referenceYear,
      match.referenceMonth,
    );
    if (!actual) continue;
    updates.set(event.id, {
      ...event,
      status: 'released',
      metrics: {
        ...(isPlainObject(event.metrics) ? event.metrics : {}),
        actual: actual.label,
      },
      summary: `BLS官方发布：${actual.label}`,
      source: {
        name: 'official',
        sourceId: `bls-${match.definition.key}-${referenceYear}-${String(match.referenceMonth).padStart(2, '0')}`,
        url: match.definition.sourceUrl,
        fetchedAt,
      },
    });
  }

  const nextStore = {
    ...store,
    sources: {
      ...(isPlainObject(store.sources) ? store.sources : {}),
      official: {
        status: 'ready',
        updatedAt: fetchedAt,
        message: updates.size > 0
          ? `已通过BLS官方数据更新${updates.size}项美国宏观实际值。`
          : '已核验BLS官方数据，当前范围内没有新公布值。',
      },
    },
    events: store.events.map((event) => updates.get(event.id) || event),
  };
  await writeStoreFile(dataFile, nextStore);
  return {
    status: 'ready',
    source: 'bls',
    range: { start, end },
    checked: candidates.length,
    updated: updates.size,
    message: nextStore.sources.official.message,
  };
}

const decodeHtmlEntities = (value) => String(value || '')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&apos;|&#39;/gi, "'");

const htmlToText = (html) => decodeHtmlEntities(html)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[\s\u00a0\u2002\u2003\u3000]+/g, ' ')
  .trim();

const htmlAttribute = (tag, name) => {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtmlEntities(match[2]).trim() : '';
};

const nbsReleaseLinks = (html, baseUrl = NBS_DATA_RELEASES_URL) => {
  const links = [];
  for (const match of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = `<a${match[1]}>`;
    const href = htmlAttribute(tag, 'href');
    const title = htmlAttribute(tag, 'title') || htmlToText(match[2]);
    if (!href || !title || /解读|答记者问/.test(title)) continue;
    const releaseDateMatch = href.match(/t(\d{4})(\d{2})(\d{2})_/);
    if (!releaseDateMatch) continue;
    links.push({
      title,
      url: new URL(href, baseUrl).toString(),
      date: `${releaseDateMatch[1]}-${releaseDateMatch[2]}-${releaseDateMatch[3]}`,
    });
  }
  return [...new Map(links.map((item) => [item.url, item])).values()]
    .sort((a, b) => b.date.localeCompare(a.date));
};

const growthValue = (direction, rawValue) => {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric)) return undefined;
  return direction === '下降' ? -Math.abs(numeric) : Math.abs(numeric);
};

const firstGrowthMatch = (text, pattern, directionIndex, valueIndex) => {
  const match = text.match(pattern);
  return match ? growthValue(match[directionIndex], match[valueIndex]) : undefined;
};

const nbsReleaseMetrics = (html) => {
  const text = htmlToText(html);
  const halfYearGdpMatch = text.match(
    /上半年国内生产总值\s*([\d.]+)\s*亿元[^。]*?同比(增长|下降)\s*([\d.]+)%/,
  );
  const retailMatch = text.match(
    /6\s*月份，?\s*社会消费品零售总额\s*([\d.]+)\s*亿元，?\s*同比(增长|下降)\s*([\d.]+)%/,
  );
  const fixedInvestmentMatch = text.match(
    /上半年，?全国固定资产投资（不含农户）\s*([\d.]+)\s*亿元，?同比(增长|下降)\s*([\d.]+)%/,
  );
  return {
    halfYearGdpAmount: halfYearGdpMatch ? Number(halfYearGdpMatch[1]) : undefined,
    halfYearGdp: halfYearGdpMatch
      ? growthValue(halfYearGdpMatch[2], halfYearGdpMatch[3])
      : undefined,
    quarterGdp: firstGrowthMatch(
      text,
      /分季度看[^。]*?二季度(?:国内生产总值)?(?:同比)?(增长|下降)\s*([\d.]+)%/,
      1,
      2,
    ),
    quarterGdpQoq: firstGrowthMatch(
      text,
      /从环比看[^。]*?二季度国内生产总值(增长|下降)\s*([\d.]+)%/,
      1,
      2,
    ),
    industrial: firstGrowthMatch(
      text,
      /6\s*月份，?\s*规模以上工业增加值同比(增长|下降)\s*([\d.]+)%/,
      1,
      2,
    ),
    retailAmount: retailMatch ? Number(retailMatch[1]) : undefined,
    retail: retailMatch ? growthValue(retailMatch[2], retailMatch[3]) : undefined,
    fixedInvestmentAmount: fixedInvestmentMatch ? Number(fixedInvestmentMatch[1]) : undefined,
    fixedInvestment: fixedInvestmentMatch
      ? growthValue(fixedInvestmentMatch[2], fixedInvestmentMatch[3])
      : undefined,
    unemployment: firstGrowthMatch(
      text,
      /6\s*月份，?\s*全国城镇调查失业率为\s*([\d.]+)%/,
      0,
      1,
    ),
  };
};

const metricPercent = (value) => signedPercent(value);

const nbsSourceId = (url) => {
  const match = String(url).match(/t(\d{8})_(\d+)\.html/);
  return match ? `nbs-${match[1]}-${match[2]}` : `nbs-${Date.now()}`;
};

const nbsSource = (release, fetchedAt) => ({
  name: 'official',
  sourceId: nbsSourceId(release.url),
  url: release.url,
  fetchedAt,
});

const buildNbsHousingEvent = ({ release, fetchedAt }) => {
  const referenceMatch = release.title.match(/(?:(\d{4})年)?(\d{1,2})月份?70个大中城市/);
  const referenceYear = Number(referenceMatch?.[1]) || Number(release.date.slice(0, 4));
  const referenceMonth = Number(referenceMatch?.[2]) || Number(release.date.slice(5, 7));
  const monthText = String(referenceMonth).padStart(2, '0');
  return {
    id: `macro-cn-home-prices-70-cities-${referenceYear}-${monthText}`,
    kind: 'macro',
    title: `中国${referenceMonth}月70个大中城市商品住宅销售价格`,
    region: 'CN',
    date: release.date,
    startAt: `${release.date}T09:30:00+08:00`,
    timezone: 'Asia/Shanghai',
    timePrecision: 'exact',
    importance: 4,
    status: 'released',
    tags: ['房地产', '房价'],
    summary: '国家统计局已发布当月70个大中城市商品住宅销售价格数据。',
    source: nbsSource(release, fetchedAt),
  };
};

const buildNbsReleaseEvents = ({ release, metrics, fetchedAt }) => {
  const year = Number(release.date.slice(0, 4));
  const startAt = `${release.date}T10:00:00+08:00`;
  const source = nbsSource(release, fetchedAt);
  const base = {
    kind: 'macro',
    region: 'CN',
    date: release.date,
    startAt,
    timezone: 'Asia/Shanghai',
    timePrecision: 'exact',
    status: 'released',
    source,
  };
  const events = [];
  if (Number.isFinite(metrics.quarterGdp)) {
    const actual = [
      `同比${metricPercent(metrics.quarterGdp)}`,
      Number.isFinite(metrics.quarterGdpQoq) ? `环比${metricPercent(metrics.quarterGdpQoq)}` : '',
    ].filter(Boolean).join(' · ');
    events.push({
      ...base,
      id: `macro-cn-q2-gdp-${year}`,
      title: '中国二季度GDP',
      importance: 5,
      tags: ['GDP', '经济增长'],
      metrics: { actual },
      summary: `国家统计局初步核算：二季度GDP${actual}。`,
    });
  }
  if (Number.isFinite(metrics.halfYearGdp)) {
    const actual = `${metricPercent(metrics.halfYearGdp)}${Number.isFinite(metrics.halfYearGdpAmount) ? ` · ${metrics.halfYearGdpAmount}亿元` : ''}`;
    events.push({
      ...base,
      id: `macro-cn-h1-gdp-${year}`,
      title: '中国上半年GDP',
      importance: 5,
      tags: ['GDP', '经济增长'],
      metrics: { actual },
      summary: `国家统计局初步核算：上半年GDP同比${metricPercent(metrics.halfYearGdp)}。`,
    });
  }
  if (Number.isFinite(metrics.industrial)) {
    const actual = metricPercent(metrics.industrial);
    events.push({
      ...base,
      id: `macro-cn-industrial-production-${year}-06`,
      title: '中国6月规模以上工业增加值同比',
      importance: 4,
      tags: ['工业增加值', '工业生产'],
      metrics: { actual },
      summary: `国家统计局公布：6月规模以上工业增加值同比${actual}。`,
    });
  }
  if (Number.isFinite(metrics.retail)) {
    const actual = `${metricPercent(metrics.retail)}${Number.isFinite(metrics.retailAmount) ? ` · ${metrics.retailAmount}亿元` : ''}`;
    events.push({
      ...base,
      id: `macro-cn-retail-sales-${year}-06`,
      title: '中国6月社会消费品零售总额同比',
      importance: 5,
      tags: ['社会消费品零售', '消费'],
      metrics: { actual },
      summary: `国家统计局公布：6月社会消费品零售总额同比${metricPercent(metrics.retail)}。`,
    });
  }
  if (Number.isFinite(metrics.fixedInvestment)) {
    const actual = `${metricPercent(metrics.fixedInvestment)}${Number.isFinite(metrics.fixedInvestmentAmount) ? ` · ${metrics.fixedInvestmentAmount}亿元` : ''}`;
    events.push({
      ...base,
      id: `macro-cn-fixed-investment-${year}-h1`,
      title: '中国上半年固定资产投资同比',
      importance: 4,
      tags: ['固定资产投资', '投资'],
      metrics: { actual },
      summary: `国家统计局公布：上半年固定资产投资（不含农户）同比${metricPercent(metrics.fixedInvestment)}。`,
    });
  }
  if (Number.isFinite(metrics.unemployment)) {
    const actual = `${metrics.unemployment.toFixed(1)}%`;
    events.push({
      ...base,
      id: `macro-cn-surveyed-unemployment-${year}-06`,
      title: '中国6月全国城镇调查失业率',
      importance: 4,
      tags: ['就业', '失业率'],
      metrics: { actual },
      summary: `国家统计局公布：6月全国城镇调查失业率为${actual}。`,
    });
  }
  return events;
};

export async function refreshNbsMacroCalendar({
  dataFile,
  start,
  end,
  fetchImpl,
  now = () => new Date(),
}) {
  const requestCalendar = fetchImpl || fetchWithNodeHttps;
  const [indexHtml, aggregateHtml] = await Promise.all([
    requestText(NBS_DATA_RELEASES_URL, requestCalendar),
    requestText(NBS_RELEASES_AGGREGATE_URL, requestCalendar).catch(() => ''),
  ]);
  const releases = [
    ...nbsReleaseLinks(indexHtml, NBS_DATA_RELEASES_URL),
    ...nbsReleaseLinks(aggregateHtml, NBS_RELEASES_AGGREGATE_URL),
  ];
  const uniqueReleases = [...new Map(releases.map((item) => [item.url, item])).values()];
  const economicRelease = uniqueReleases.find((item) => (
    item.date >= start
    && item.date <= end
    && /经济运行/.test(item.title)
  ));
  const housingRelease = uniqueReleases.find((item) => (
    item.date >= start
    && item.date <= end
    && /70个大中城市.*商品住宅销售价格|商品住宅销售价格.*70个大中城市/.test(item.title)
  ));
  if (!economicRelease && !housingRelease) {
    return {
      status: 'ready',
      source: 'nbs',
      range: { start, end },
      checked: 0,
      updated: 0,
      message: '已核验国家统计局，当前范围没有新的经济运行或70城房价发布。',
    };
  }

  const fetchedAt = now().toISOString();
  let releasedEvents = [];
  if (economicRelease) {
    const articleHtml = await requestText(economicRelease.url, requestCalendar);
    const metrics = nbsReleaseMetrics(articleHtml);
    releasedEvents = buildNbsReleaseEvents({ release: economicRelease, metrics, fetchedAt });
    if (releasedEvents.length === 0) {
      throw new CalendarDataError('国家统计局已发布数据，但未能解析GDP、工业、社零或固投结果', {
        code: 'CALENDAR_REFRESH_SOURCE_INVALID',
        status: 502,
      });
    }
  }
  const housingEvent = housingRelease
    ? buildNbsHousingEvent({ release: housingRelease, fetchedAt })
    : undefined;
  const officialEvents = housingEvent ? [...releasedEvents, housingEvent] : releasedEvents;

  const store = await readStoreFile(dataFile);
  const replacements = new Map(officialEvents.map((event) => [event.id, event]));
  let aggregateUpdated = false;
  const retainedEvents = store.events.map((event) => {
    if (replacements.has(event.id)) {
      const replacement = replacements.get(event.id);
      replacements.delete(event.id);
      return replacement;
    }
    if (economicRelease
      && event?.kind === 'macro'
      && event.region === 'CN'
      && event.date === economicRelease.date
      && /国民经济运行情况发布会/.test(String(event.title || ''))) {
      aggregateUpdated = true;
      const metrics = isPlainObject(event.metrics) ? { ...event.metrics } : {};
      delete metrics.actual;
      return {
        ...event,
        status: 'released',
        metrics,
        summary: '发布会已结束；GDP、工业、社零、投资和就业数据已拆分为独立条目展示。',
        source: releasedEvents[0]?.source || nbsSource(economicRelease, fetchedAt),
      };
    }
    if (housingRelease
      && event?.kind === 'macro'
      && event.region === 'CN'
      && event.date === housingRelease.date
      && /70个大中城市.*商品住宅销售价格/.test(String(event.title || ''))) {
      replacements.delete(housingEvent.id);
      return {
        ...housingEvent,
        id: event.id,
      };
    }
    return event;
  });
  const insertedEvents = [...replacements.values()];
  const nextStore = {
    ...store,
    sources: {
      ...(isPlainObject(store.sources) ? store.sources : {}),
      official: {
        status: 'ready',
        updatedAt: fetchedAt,
        message: [
          releasedEvents.length > 0 ? `已更新${releasedEvents.length}项中国宏观实际值` : '',
          housingEvent ? '已同步70城房价发布' : '',
        ].filter(Boolean).join('；') + '。',
      },
    },
    events: [...retainedEvents, ...insertedEvents],
  };
  await writeStoreFile(dataFile, nextStore);
  return {
    status: 'ready',
    source: 'nbs',
    range: { start, end },
    checked: Number(Boolean(economicRelease)) + Number(Boolean(housingRelease)),
    updated: officialEvents.length + (aggregateUpdated ? 1 : 0),
    inserted: insertedEvents.length,
    message: nextStore.sources.official.message,
  };
}

const reloadAShareCalendarSnapshot = async ({ manualFile, start, end }) => {
  const store = await readStoreFile(manualFile);
  const count = store.events.filter((event) => event?.kind === 'a_share'
    && event.date <= end
    && (event.endDate || event.date) >= start).length;
  return {
    status: 'manual',
    source: 'a-share-snapshot',
    range: { start, end },
    checked: count,
    updated: 0,
    updatedAt: store.sources?.wechat?.updatedAt || null,
    message: 'A股事件已重新读取最近导入的《A股投资日历》PDF 快照。',
  };
};

const refreshFailure = (error) => ({
  status: 'failed',
  message: error instanceof Error ? error.message : '未知刷新错误',
});

export async function refreshCalendar({
  dataFile,
  manualFile,
  start,
  end,
  fetchImpl,
  now = () => new Date(),
}) {
  const resolvedManualFile = manualFile || path.join(path.dirname(dataFile), 'manual-events.json');
  const results = {};
  const macroSources = {};
  try {
    macroSources.bls = await refreshBlsMacroCalendar({
      dataFile,
      start,
      end,
      fetchImpl,
      now,
    });
  } catch (error) {
    macroSources.bls = refreshFailure(error);
  }
  try {
    macroSources.nbs = await refreshNbsMacroCalendar({
      dataFile,
      start,
      end,
      fetchImpl,
      now,
    });
  } catch (error) {
    macroSources.nbs = refreshFailure(error);
  }
  const scheduleStore = await readStoreFile(resolvedManualFile);
  const scheduleCount = scheduleStore.events.filter((event) => event?.kind === 'macro'
    && event?.source?.name === 'jin10'
    && event.date <= end
    && (event.endDate || event.date) >= start).length;
  macroSources.schedule = {
    status: 'manual',
    source: 'jin10-snapshot',
    range: { start, end },
    checked: scheduleCount,
    updated: 0,
    updatedAt: scheduleStore.sources?.jin10?.updatedAt || null,
    message: '宏观日程已重新读取通过已登录金十网页人工核验的快照。',
  };
  const macroFailed = Object.values(macroSources).some((result) => result.status === 'failed');
  results.macro = {
    status: macroFailed ? 'failed' : 'partial',
    source: 'official',
    range: { start, end },
    checked: Object.values(macroSources)
      .reduce((total, result) => total + (Number(result.checked) || 0), 0),
    updated: Object.values(macroSources)
      .reduce((total, result) => total + (Number(result.updated) || 0), 0),
    sources: macroSources,
    message: Object.values(macroSources).map((result) => result.message).filter(Boolean).join('；'),
  };
  try {
    results.earnings = {
      status: 'ready',
      ...await refreshEarningsHubCalendar({
        dataFile,
        start,
        end,
        fetchImpl,
        now,
      }),
    };
  } catch (error) {
    results.earnings = refreshFailure(error);
  }
  try {
    results.aShare = await reloadAShareCalendarSnapshot({
      manualFile: resolvedManualFile,
      start,
      end,
    });
  } catch (error) {
    results.aShare = refreshFailure(error);
  }

  const allFailed = Object.values(results).every((result) => result.status === 'failed');
  if (allFailed) {
    throw new CalendarDataError('所有日历数据源本次均刷新失败', {
      code: 'CALENDAR_REFRESH_ALL_SOURCES_FAILED',
      status: 502,
    });
  }
  const completedAt = now().toISOString();
  const store = await readStoreFile(dataFile);
  await writeStoreFile(dataFile, {
    ...store,
    updatedAt: completedAt,
    meta: {
      ...(isPlainObject(store.meta) ? store.meta : {}),
      generatedAt: completedAt,
    },
  });
  return {
    updatedAt: completedAt,
    range: { start, end },
    allSucceeded: Object.values(results).every((result) => result.status !== 'failed'),
    coverageComplete: Object.values(results).every((result) => result.status === 'ready'),
    results,
  };
}
