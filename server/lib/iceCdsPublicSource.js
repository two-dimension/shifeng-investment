import { selectTrackedFiveYearContracts } from './iceCdsImport.js';

export const ICE_CDS_PUBLIC_URL = 'https://www.ice.com/api/cds-settlement-prices/icc-single-names';
export const TREASURY_CURVE_SOURCE_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates';
const DAY_MS = 24 * 60 * 60 * 1000;
const CURVE_COLUMNS = Object.freeze([
  ['1 Mo', 1 / 12],
  ['1.5 Month', 0.125],
  ['2 Mo', 1 / 6],
  ['3 Mo', 0.25],
  ['4 Mo', 1 / 3],
  ['6 Mo', 0.5],
  ['1 Yr', 1],
  ['2 Yr', 2],
  ['3 Yr', 3],
  ['5 Yr', 5],
  ['7 Yr', 7],
  ['10 Yr', 10],
  ['20 Yr', 20],
  ['30 Yr', 30],
]);

export class IceCdsPublicSourceError extends Error {
  constructor(message, code = 'ice-public-source-error') {
    super(message);
    this.name = 'IceCdsPublicSourceError';
    this.code = code;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function treasuryCsvUrl(year) {
  const params = new URLSearchParams({
    type: 'daily_treasury_yield_curve',
    field_tdr_date_value: String(year),
    page: '',
    _format: 'csv',
  });
  return `${TREASURY_CURVE_SOURCE_URL}/daily-treasury-rates.csv/${year}/all?${params}`;
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"' && value.length === 0) quoted = true;
    else if (character === ',') {
      values.push(value.trim());
      value = '';
    } else value += character;
  }
  if (quoted) throw new IceCdsPublicSourceError('Treasury CSV contains an unterminated quote', 'invalid-treasury-csv');
  values.push(value.trim());
  return values;
}

function treasuryDate(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  return validDate(iso) ? iso : null;
}

function parseTreasuryCurve(csv, clearingDate) {
  const lines = String(csv || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new IceCdsPublicSourceError('Treasury curve CSV is empty', 'invalid-treasury-csv');
  const headers = parseCsvLine(lines[0]);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  if (!headerIndex.has('Date') || CURVE_COLUMNS.some(([column]) => !headerIndex.has(column))) {
    throw new IceCdsPublicSourceError('Treasury curve CSV is missing required maturities', 'invalid-treasury-csv');
  }
  const rows = lines.slice(1).flatMap((line) => {
    const values = parseCsvLine(line);
    const asOf = treasuryDate(values[headerIndex.get('Date')]);
    if (!asOf || asOf > clearingDate) return [];
    const nodes = CURVE_COLUMNS.map(([column, years]) => ({
      years,
      zeroRate: Number(values[headerIndex.get(column)]) / 100,
    }));
    if (nodes.some((node) => !Number.isFinite(node.zeroRate))) return [];
    return [{ asOf, nodes }];
  }).sort((left, right) => right.asOf.localeCompare(left.asOf));
  if (rows.length === 0) {
    throw new IceCdsPublicSourceError(`No Treasury curve is available on or before ${clearingDate}`, 'missing-treasury-curve');
  }
  const selected = rows[0];
  return {
    curveId: `ust-par-zero-proxy-${selected.asOf}`,
    asOf: selected.asOf,
    currency: 'USD',
    sourceLabel: 'U.S. Treasury par yields · continuous-zero proxy',
    sourceUrl: TREASURY_CURVE_SOURCE_URL,
    nodes: selected.nodes,
  };
}

function normalizeIceRows(payload) {
  if (!Array.isArray(payload)) throw new IceCdsPublicSourceError('ICE public feed did not return an array', 'invalid-ice-response');
  const rows = payload.flatMap((row, index) => {
    const clearingDate = String(row?.clearingDate || '').trim();
    const name = String(row?.name || '').trim();
    const instrumentName = String(row?.instrumentName || '').trim();
    const eodPrice = Number(row?.eodPrice);
    if (!validDate(clearingDate) || !name || !instrumentName || !Number.isFinite(eodPrice) || eodPrice < 0) return [];
    return [{ clearingDate, name, instrumentName, eodPrice, rowNumber: index + 2 }];
  });
  if (rows.length === 0) throw new IceCdsPublicSourceError('ICE public feed contains no valid rows', 'empty-ice-response');
  return rows;
}

async function fetchWithTimeout(fetchImpl, url, responseType, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: responseType === 'json' ? 'application/json' : 'text/csv' },
      signal: controller.signal,
    });
    if (!response.ok) throw new IceCdsPublicSourceError(`${url} returned HTTP ${response.status}`, 'source-http-error');
    return responseType === 'json' ? response.json() : response.text();
  } catch (error) {
    if (controller.signal.aborted) throw new IceCdsPublicSourceError(`${url} timed out`, 'source-timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createIceCdsPublicClient({ fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  return {
    async fetchLatestInput() {
      const payload = await fetchWithTimeout(fetchImpl, ICE_CDS_PUBLIC_URL, 'json', timeoutMs);
      const rows = normalizeIceRows(payload);
      const clearingDates = [...new Set(rows.map((row) => row.clearingDate))].sort().reverse();
      let completeBatch = null;
      let newestAttempt = null;
      for (const clearingDate of clearingDates) {
        const selection = selectTrackedFiveYearContracts(rows, clearingDate);
        newestAttempt ||= { clearingDate, selection };
        if (selection.errors.length === 0 && selection.selected.length === 7) {
          completeBatch = { clearingDate, selection };
          break;
        }
      }
      if (!completeBatch) {
        const { clearingDate, selection } = newestAttempt;
        const details = selection.errors.map((error) => `${error.company}: ${error.message}`).join('; ');
        throw new IceCdsPublicSourceError(`ICE free feed is incomplete for ${clearingDate}: ${details}`, 'incomplete-ice-batch');
      }
      const { clearingDate, selection } = completeBatch;
      const year = Number(clearingDate.slice(0, 4));
      const treasuryCsv = await fetchWithTimeout(fetchImpl, treasuryCsvUrl(year), 'text', timeoutMs);
      const discountCurve = parseTreasuryCurve(treasuryCsv, clearingDate);
      const lines = ['Clearing Date\tName\tInstrument Name\tEOD Price'];
      for (const row of selection.selected) {
        lines.push(`${row.clearingDate}\t${row.name}\t${row.instrumentName}\t${row.eodPrice}`);
      }
      return { iceText: lines.join('\n'), discountCurve };
    },
  };
}

export async function refreshIceCdsFromPublicSources({ client, pipeline }) {
  if (!client || typeof client.fetchLatestInput !== 'function') {
    throw new IceCdsPublicSourceError('ICE public client is required', 'invalid-client');
  }
  if (!pipeline || typeof pipeline.import !== 'function') {
    throw new IceCdsPublicSourceError('ICE CDS pipeline is required', 'invalid-pipeline');
  }
  return pipeline.import(await client.fetchLatestInput());
}

export function startIceCdsAutoRefresh(refresh, {
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  clearTimeoutImpl = clearTimeout,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof refresh !== 'function') throw new IceCdsPublicSourceError('ICE CDS refresh function is required', 'invalid-refresh');
  const run = () => Promise.resolve().then(refresh).catch((error) => {
    console.error(`[ai-dashboard] ICE CDS automatic refresh failed: ${error.message}`);
  });
  const initial = setTimeoutImpl(() => run(), 5_000);
  const daily = setIntervalImpl(() => run(), DAY_MS);
  console.log('[ai-dashboard] scheduled free ICE 5Y CDS refresh daily');
  return () => {
    clearTimeoutImpl(initial);
    clearIntervalImpl(daily);
  };
}
