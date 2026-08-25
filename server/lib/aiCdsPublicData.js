import { strFromU8, unzipSync } from 'fflate';

const DTCC_BUCKET_URL = 'https://pddata.dtcc.com/ppd/api/general/bucketname';
export const DTCC_PPD_URL = 'https://pddata.dtcc.com/ppd/index.html';
const QUARTER_YEARS = 0.25;
const RECOVERY_RATE = 0.4;
const RISK_FREE_RATE = 0.04;

const COMPANY_ALIASES = [
  { company: 'Oracle', aliases: ['ORACLE CORPORATION', 'ORACLE CORP', 'ORACLE COP'] },
  { company: 'CoreWeave', aliases: ['COREWEAVE'] },
  { company: 'NVIDIA', aliases: ['NVIDIA CORPORATION', 'NVIDIA CORP'] },
  { company: 'Amazon', aliases: ['AMAZON COM INC', 'AMAZON.COM INC', 'AMAZON'] },
  { company: 'Google', aliases: ['ALPHABET INC', 'GOOGLE'] },
  { company: 'Microsoft', aliases: ['MICROSOFT CORPORATION', 'MICROSOFT CORP'] },
  { company: 'Meta', aliases: ['META PLATFORMS INC', 'META PLATFORMS'] },
];

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

function numeric(value) {
  const normalized = String(value ?? '').replaceAll(',', '').trim();
  if (!normalized) return null;
  const number = Number(normalized.replace(/\+$/, ''));
  return Number.isFinite(number) ? number : null;
}

function canonicalCompany(...values) {
  const combined = values.join(' ').toUpperCase().replace(/[^A-Z0-9.]+/g, ' ').trim();
  return COMPANY_ALIASES.find(({ aliases }) => aliases.some((alias) => combined.includes(alias)))?.company || null;
}

function yearFraction(start, end) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return (endTime - startTime) / (365.25 * 24 * 60 * 60 * 1000);
}

export function parseDtccCdsCsv(text) {
  const rows = csvRows(String(text || '').replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const headers = rows[0];
  const records = rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  const invalidatedIds = new Set(records.flatMap((record) => {
    const action = record['Action type']?.toUpperCase();
    const originalId = record['Original Dissemination Identifier']?.trim();
    return originalId && ['EROR', 'TERM', 'CORR', 'MODI'].includes(action) ? [originalId] : [];
  }));

  return records.flatMap((record) => {
    const id = record['Dissemination Identifier']?.trim();
    const action = record['Action type']?.toUpperCase();
    const eventType = record['Event type']?.toUpperCase();
    const assetClass = record['Asset Class']?.toUpperCase();
    if (!id || invalidatedIds.has(id) || !['NEWT', 'CORR', 'MODI'].includes(action)) return [];
    if (eventType !== 'TRAD' || assetClass !== 'CR') return [];

    const currency = record['Notional currency-Leg 1']?.toUpperCase();
    const paymentCurrency = record['Other payment currency']?.toUpperCase();
    const fisn = record['UPI FISN'] || '';
    if (currency !== 'USD' || (paymentCurrency && paymentCurrency !== 'USD')) return [];
    if (!/CDS Corp SN/i.test(fisn) || /CDS Index/i.test(fisn)) return [];

    const company = canonicalCompany(record['Underlying Asset Name'], record['UPI Underlier Name']);
    const effectiveDate = record['Effective Date']?.slice(0, 10);
    const expirationDate = record['Expiration Date']?.slice(0, 10);
    const tenorYears = yearFraction(effectiveDate, expirationDate);
    const notionalRaw = record['Notional amount-Leg 1']?.trim();
    const notionalUsd = numeric(notionalRaw);
    const couponRate = numeric(record['Fixed rate-Leg 1']);
    const upfrontUsd = numeric(record['Other payment amount']);
    const executedAt = record['Execution Timestamp']?.trim();
    if (!company || tenorYears === null || tenorYears < 4.25 || tenorYears > 5.75) return [];
    if (!notionalUsd || notionalUsd <= 0 || couponRate === null || couponRate <= 0 || upfrontUsd === null || upfrontUsd < 0) return [];
    if (!Number.isFinite(Date.parse(executedAt))) return [];

    return [{
      id,
      originalId: record['Original Dissemination Identifier']?.trim() || null,
      company,
      executedAt,
      asOf: executedAt.slice(0, 10),
      effectiveDate,
      expirationDate,
      tenorYears,
      notionalUsd,
      notionalCapped: notionalRaw.endsWith('+'),
      couponBp: couponRate * 10_000,
      upfrontUsd,
    }];
  });
}

function priceAtHazard(hazard, couponRate, tenorYears, signedUpfront) {
  let riskyAnnuity = 0;
  let protection = 0;
  for (let previous = 0; previous < tenorYears; previous += QUARTER_YEARS) {
    const current = Math.min(previous + QUARTER_YEARS, tenorYears);
    const survivalBefore = Math.exp(-hazard * previous);
    const survivalCurrent = Math.exp(-hazard * current);
    const discount = Math.exp(-RISK_FREE_RATE * current);
    riskyAnnuity += (current - previous) * discount * survivalCurrent;
    protection += (survivalBefore - survivalCurrent) * discount * (1 - RECOVERY_RATE);
  }
  return {
    difference: protection - couponRate * riskyAnnuity - signedUpfront,
    parSpreadBp: riskyAnnuity > 0 ? (protection / riskyAnnuity) * 10_000 : null,
  };
}

function solveParSpread(couponBp, upfrontFraction, tenorYears, sign) {
  const couponRate = couponBp / 10_000;
  const signedUpfront = upfrontFraction * sign;
  let low = 0.000001;
  let high = 5;
  let lowValue = priceAtHazard(low, couponRate, tenorYears, signedUpfront).difference;
  const highValue = priceAtHazard(high, couponRate, tenorYears, signedUpfront).difference;
  if (Math.sign(lowValue) === Math.sign(highValue)) return null;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (low + high) / 2;
    const value = priceAtHazard(midpoint, couponRate, tenorYears, signedUpfront).difference;
    if (Math.sign(value) === Math.sign(lowValue)) {
      low = midpoint;
      lowValue = value;
    } else {
      high = midpoint;
    }
  }
  return priceAtHazard((low + high) / 2, couponRate, tenorYears, signedUpfront).parSpreadBp;
}

function impliedSpreadBp(trade, referenceBp) {
  const upfrontFraction = trade.upfrontUsd / trade.notionalUsd;
  const candidates = [-1, 1]
    .map((sign) => solveParSpread(trade.couponBp, upfrontFraction, trade.tenorYears, sign))
    .filter((value) => value !== null && Number.isFinite(value) && value >= 0);
  if (candidates.length === 0) return null;
  if (!Number.isFinite(referenceBp)) return candidates[0];
  return candidates.toSorted((left, right) => Math.abs(left - referenceBp) - Math.abs(right - referenceBp))[0];
}

function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
}

export function deriveCdsObservations(trades, referenceCompanies = []) {
  const references = new Map(referenceCompanies.map((row) => [row.company, Number(row.latestBp)]));
  return COMPANY_ALIASES.flatMap(({ company }) => {
    const companyTrades = trades.filter((trade) => trade.company === company);
    if (companyTrades.length === 0) return [];
    const latestDate = companyTrades.map((trade) => trade.asOf).toSorted().at(-1);
    const latestTrades = companyTrades.filter((trade) => trade.asOf === latestDate);
    const values = latestTrades
      .map((trade) => impliedSpreadBp(trade, references.get(company)))
      .filter((value) => value !== null && Number.isFinite(value));
    const valueBp = median(values);
    if (valueBp === null) return [];
    return [{
      company,
      asOf: latestDate,
      executedAt: latestTrades.map((trade) => trade.executedAt).toSorted().at(-1),
      valueBp,
      confidence: latestTrades.some((trade) => trade.notionalCapped) ? 'low' : 'medium',
      tradeCount: latestTrades.length,
      notionalCapped: latestTrades.some((trade) => trade.notionalCapped),
    }];
  });
}

function dateOffset(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function monthOffset(date, months) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

function changeFromHistory(history, asOf, targetDate, latestBp) {
  const reference = history.filter((point) => point.date <= targetDate).toSorted((left, right) => right.date.localeCompare(left.date))[0];
  if (!reference || reference.date >= asOf) return null;
  return latestBp - reference.valueBp;
}

export function mergePublicCdsObservations(previous, observations, { checkedAt = new Date().toISOString() } = {}) {
  const byCompany = new Map(observations.map((row) => [row.company, row]));
  const companies = (previous?.companies || []).map((company) => {
    const observation = byCompany.get(company.company);
    if (!observation) return company;
    const latestBp = Math.round(observation.valueBp);
    const historyByDate = new Map((company.history || []).map((point) => [point.date, { ...point }]));
    historyByDate.set(observation.asOf, { date: observation.asOf, valueBp: latestBp });
    const history = [...historyByDate.values()].toSorted((left, right) => left.date.localeCompare(right.date));
    return {
      ...company,
      latestBp,
      changes: {
        oneDayBp: changeFromHistory(history, observation.asOf, dateOffset(observation.asOf, -1), latestBp),
        sevenDayBp: changeFromHistory(history, observation.asOf, dateOffset(observation.asOf, -7), latestBp),
        oneMonthBp: changeFromHistory(history, observation.asOf, monthOffset(observation.asOf, -1), latestBp),
      },
      history,
      latestTradeAt: observation.executedAt,
      estimateConfidence: observation.confidence,
      tradeCount: observation.tradeCount,
    };
  });
  const latestObservationDate = observations.map((row) => row.asOf).toSorted().at(-1);
  return {
    ...previous,
    sourceKind: 'dtcc_public_trade_estimate',
    sourceLabel: 'DTCC SEC PPD · 成交隐含估算',
    sourceUrl: DTCC_PPD_URL,
    asOf: latestObservationDate || previous?.asOf || null,
    lastCheckedAt: checkedAt,
    historyEstimated: true,
    note: '基于 DTCC SEC Public Price Dissemination 的公开单一名称 CDS 成交票息、前端支付和名义本金反推 5Y 隐含利差；不是 ICE ICC 每日 EOD 结算价。带“+”的封顶名义本金会降低估算置信度，未出现新成交的公司保留上一版数据。',
    companies,
  };
}

async function requireOk(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return response;
}

export function createDtccCdsClient({ fetchImpl = fetch } = {}) {
  return {
    async fetchLatest({ referenceCompanies = [] } = {}) {
      const bucketResponse = await requireOk(await fetchImpl(DTCC_BUCKET_URL), 'DTCC bucket discovery');
      const bucketName = (await bucketResponse.text()).trim().replace(/^"|"$/g, '');
      if (!/^[a-zA-Z0-9.-]+$/.test(bucketName)) throw new Error('DTCC bucket discovery returned an invalid bucket name');
      const cumulativeUrl = `https://${bucketName}.s3.amazonaws.com/dashboard/Cumulative.json`;
      const cumulativeResponse = await requireOk(await fetchImpl(cumulativeUrl), 'DTCC cumulative metadata');
      const metadata = await cumulativeResponse.json();
      const latest = (Array.isArray(metadata.SEC_CR) ? metadata.SEC_CR : [])
        .filter((row) => row?.fullFilePath && row?.fileName)
        .toSorted((left, right) => String(right.dissemDTM || '').localeCompare(String(left.dissemDTM || '')))[0];
      if (!latest) throw new Error('DTCC cumulative metadata has no SEC credit file');
      const zipResponse = await requireOk(await fetchImpl(latest.fullFilePath), 'DTCC SEC credit download');
      const archive = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
      const csvName = Object.keys(archive).find((name) => name.toLowerCase().endsWith('.csv'));
      if (!csvName) throw new Error('DTCC SEC credit archive contains no CSV file');
      const trades = parseDtccCdsCsv(strFromU8(archive[csvName]));
      const observations = deriveCdsObservations(trades, referenceCompanies);
      if (observations.length === 0) throw new Error('DTCC SEC credit file contains no usable tracked-company 5Y trades');
      return {
        asOf: observations.map((row) => row.asOf).toSorted().at(-1),
        observations,
        sourceUrl: DTCC_PPD_URL,
        fileName: latest.fileName,
      };
    },
  };
}
