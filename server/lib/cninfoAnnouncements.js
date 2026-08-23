const CNINFO_QUERY_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';

export class CninfoUpstreamError extends Error {
  constructor(message, { code = 'CNINFO_UPSTREAM_ERROR', column = '', page = 0, cause } = {}) {
    super(message, { cause });
    this.name = 'CninfoUpstreamError';
    this.code = code;
    this.column = column;
    this.page = page;
  }
}

export async function fetchCninfoMarketDay({
  date,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 10_000,
  attempts = 3,
  pageSize = 30,
  columns = ['sse', 'szse'],
} = {}) {
  assertDate(date);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');

  const marketResults = [];
  for (const column of columns) {
    marketResults.push(await fetchColumn({ date, column, fetchImpl, sleepImpl, timeoutMs, attempts, pageSize }));
  }
  const unique = new Map();
  for (const item of marketResults.flatMap((result) => result.announcements)) {
    unique.set(item.announcementId || `${item.secCode}:${item.announcementTime}:${item.announcementTitle}`, item);
  }
  return {
    date,
    totalCount: marketResults.reduce((sum, result) => sum + result.totalCount, 0),
    announcements: [...unique.values()],
    columns: marketResults.map(({ column, totalCount, pages }) => ({ column, totalCount, pages })),
  };
}

async function fetchColumn({ date, column, fetchImpl, sleepImpl, timeoutMs, attempts, pageSize }) {
  let firstTotal = null;
  const announcements = [];
  let pages = 0;

  while (firstTotal === null || pages < Math.ceil(firstTotal / pageSize)) {
    const page = pages + 1;
    const payload = await requestPage({ date, column, page, pageSize, fetchImpl, sleepImpl, timeoutMs, attempts });
    const total = readTotal(payload, column, page);
    if (firstTotal === null) firstTotal = total;
    announcements.push(...payload.announcements.map(normalizeAnnouncement));
    pages = page;
  }

  if (announcements.length < firstTotal) {
    throw new CninfoUpstreamError('incomplete CNINFO response', {
      code: 'CNINFO_INCOMPLETE_RESPONSE', column, page: pages,
    });
  }
  return { column, totalCount: firstTotal, announcements, pages };
}

async function requestPage({ date, column, page, pageSize, fetchImpl, sleepImpl, timeoutMs, attempts }) {
  const body = new URLSearchParams({
    pageNum: String(page), pageSize: String(pageSize), column, tabName: 'fulltext',
    plate: column === 'sse' ? 'sh' : column === 'szse' ? 'sz' : '',
    stock: '', searchkey: '', secid: '', category: '', trade: '',
    seDate: `${date}~${date}`, sortName: '', sortType: '', isHLtitle: 'true',
  });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(CNINFO_QUERY_URL, { method: 'POST', body, signal: controller.signal });
      if (!response || typeof response.status !== 'number') throw new Error('invalid CNINFO response');
      if (response.status < 200 || response.status >= 300) {
        const error = new CninfoUpstreamError(`CNINFO request failed with HTTP ${response.status}`, {
          code: `CNINFO_HTTP_${response.status}`, column, page,
        });
        if (!(response.status === 429 || response.status >= 500)) throw error;
        lastError = error;
      } else {
        try {
          return await response.json();
        } catch (error) {
          throw new CninfoUpstreamError('CNINFO returned invalid JSON', {
            code: 'CNINFO_INVALID_JSON', column, page, cause: error,
          });
        }
      }
    } catch (error) {
      if (error instanceof CninfoUpstreamError && !/^CNINFO_HTTP_(429|5\d\d)$/.test(error.code)) throw error;
      lastError = error instanceof CninfoUpstreamError ? error : new CninfoUpstreamError('CNINFO request failed', {
        code: 'CNINFO_NETWORK_ERROR', column, page, cause: error,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (attempt < attempts) await sleepImpl(attempt * 250);
  }
  throw new CninfoUpstreamError('CNINFO request failed after retries', {
    code: lastError?.code || 'CNINFO_UPSTREAM_ERROR', column, page, cause: lastError,
  });
}

function readTotal(payload, column, page) {
  if (!payload || !Array.isArray(payload.announcements)) {
    throw new CninfoUpstreamError('malformed CNINFO response', { code: 'CNINFO_MALFORMED_RESPONSE', column, page });
  }
  const total = Number(payload.totalRecordNum);
  if (!Number.isFinite(total) || total < 0) {
    throw new CninfoUpstreamError('malformed CNINFO response total', { code: 'CNINFO_MALFORMED_TOTAL', column, page });
  }
  return total;
}

function normalizeAnnouncement(raw = {}) {
  return {
    announcementId: String(raw.announcementId || ''),
    secCode: String(raw.secCode || '').split(',')[0].trim(),
    secName: stripHtml(raw.secName || raw.tileSecName || ''),
    announcementTitle: stripHtml(raw.announcementTitle || raw.shortTitle || ''),
    announcementTime: Number(raw.announcementTime) || 0,
    adjunctUrl: normalizePdfUrl(raw.adjunctUrl),
    adjunctType: String(raw.adjunctType || ''),
  };
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

function normalizePdfUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `http://static.cninfo.com.cn/${url.replace(/^\/+/, '')}`;
}

function assertDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new TypeError('date must be YYYY-MM-DD');
}
