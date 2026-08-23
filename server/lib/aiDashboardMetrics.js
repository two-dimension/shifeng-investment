const DAY_MS = 24 * 60 * 60 * 1000;
const YIPIT_STALE_DAYS = 18;
const EXCLUDED_WINNER_RE = /fable|mythos/i;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateKey(value) {
  const raw = String(value || '').slice(0, 10);
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function monthKey(value) {
  return dateKey(value)?.slice(0, 7) || null;
}

function monthIndex(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return year * 12 + monthNumber - 1;
}

function regressionSlope(points) {
  if (points.length < 3) return null;
  const sample = points.slice(-3);
  const xs = sample.map((point) => monthIndex(point.month));
  const ys = sample.map((point) => point.value);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < sample.length; index += 1) {
    numerator += (xs[index] - xMean) * (ys[index] - yMean);
    denominator += (xs[index] - xMean) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}

function latestByMonth(records) {
  const latest = new Map();
  for (const record of records) {
    const month = monthKey(record.observedAt);
    const value = finiteNumber(record.value);
    if (!month || value === null) continue;
    const normalized = { ...record, month, value, observedAt: dateKey(record.observedAt) };
    const existing = latest.get(month);
    if (!existing || normalized.observedAt >= existing.observedAt) latest.set(month, normalized);
  }
  return [...latest.values()].sort((left, right) => left.month.localeCompare(right.month));
}

export function buildArrMetrics(records, { now = new Date() } = {}) {
  const byCompany = new Map();
  for (const record of records || []) {
    const company = String(record?.company || '').trim();
    if (!company) continue;
    const bucket = byCompany.get(company) || [];
    bucket.push(record);
    byCompany.set(company, bucket);
  }

  return [...byCompany.entries()]
    .map(([company, companyRecords]) => {
      const actualPoints = latestByMonth(companyRecords.filter((record) => record.kind !== 'forecast'))
        .map((point, index, points) => ({
          ...point,
          kind: 'actual',
          momAbsolute: index === 0 ? null : point.value - points[index - 1].value,
        }));
      const forecastPoints = latestByMonth(companyRecords.filter((record) => record.kind === 'forecast'))
        .map((point) => ({ ...point, kind: 'forecast' }));
      const latestActual = actualPoints.at(-1) || null;
      const latestTimestamp = latestActual ? Date.parse(`${latestActual.observedAt}T00:00:00.000Z`) : Number.NaN;
      const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now);
      const stale = !Number.isFinite(latestTimestamp)
        || !Number.isFinite(nowTimestamp)
        || nowTimestamp - latestTimestamp > YIPIT_STALE_DAYS * DAY_MS;

      return {
        company,
        actualPoints,
        forecastPoints,
        slope3m: regressionSlope(actualPoints),
        latestActual,
        stale,
      };
    })
    .sort((left, right) => left.company.localeCompare(right.company));
}

export function attachValuationMultiples(valuations, arrMetrics) {
  const actualsByCompany = new Map(
    (arrMetrics || []).map((metric) => [
      metric.company,
      metric.actualPoints.toSorted((left, right) => left.observedAt.localeCompare(right.observedAt)),
    ]),
  );

  return (valuations || []).map((valuation) => {
    const asOf = dateKey(valuation.asOf);
    const points = actualsByCompany.get(valuation.company) || [];
    const matched = asOf ? points.filter((point) => point.observedAt <= asOf).at(-1) : null;
    const arrValue = matched?.value ?? null;
    const valuationLow = finiteNumber(valuation.valuationLow);
    const valuationHigh = finiteNumber(valuation.valuationHigh ?? valuation.valuationLow);
    return {
      ...valuation,
      asOf,
      arrAsOf: matched?.observedAt ?? null,
      arrValue,
      parrLow: arrValue && valuationLow !== null ? valuationLow / arrValue : null,
      parrHigh: arrValue && valuationHigh !== null ? valuationHigh / arrValue : null,
    };
  });
}

function addUtcDays(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function sumRows(rows) {
  return rows.reduce((sum, row) => sum + BigInt(String(row.total_tokens || '0')), 0n);
}

export function aggregateOpenRouterWeekly(rows, { endDate, weeks = 12 } = {}) {
  const resolvedEndDate = dateKey(endDate) || addUtcDays(new Date().toISOString().slice(0, 10), -1);
  const normalizedRows = (rows || [])
    .filter((row) => dateKey(row.date) && row.model_permaslug && /^\d+$/.test(String(row.total_tokens || '')))
    .map((row) => ({
      date: dateKey(row.date),
      model: String(row.model_permaslug),
      total_tokens: String(row.total_tokens),
    }));
  const history = [];
  for (let offset = weeks - 1; offset >= 0; offset -= 1) {
    const weekEnd = addUtcDays(resolvedEndDate, -offset * 7);
    const weekStart = addUtcDays(weekEnd, -6);
    const weekRows = normalizedRows.filter((row) => row.date >= weekStart && row.date <= weekEnd);
    history.push({
      startDate: weekStart,
      endDate: weekEnd,
      totalTokens: sumRows(weekRows).toString(),
    });
  }

  const latestStart = addUtcDays(resolvedEndDate, -6);
  const latestRows = normalizedRows.filter((row) => row.date >= latestStart && row.date <= resolvedEndDate);
  const totalsByModel = new Map();
  for (const row of latestRows) {
    if (row.model === 'other') continue;
    totalsByModel.set(row.model, (totalsByModel.get(row.model) || 0n) + BigInt(row.total_tokens));
  }
  const topModels = [...totalsByModel.entries()]
    .sort((left, right) => (left[1] === right[1] ? left[0].localeCompare(right[0]) : left[1] > right[1] ? -1 : 1))
    .slice(0, 10)
    .map(([model, totalTokens], index) => ({ model, totalTokens: totalTokens.toString(), rank: index + 1 }));

  return {
    startDate: latestStart,
    endDate: resolvedEndDate,
    weekTotalTokens: sumRows(latestRows).toString(),
    topModels,
    history,
  };
}

export function selectLatestBenchmarkModels(models) {
  const latestByVendor = new Map();
  for (const model of models || []) {
    if (!model?.vendor || !model?.model || !dateKey(model.releasedAt)) continue;
    const existing = latestByVendor.get(model.vendor);
    if (!existing || model.releasedAt > existing.releasedAt) latestByVendor.set(model.vendor, model);
  }
  const latest = [...latestByVendor.values()].sort((left, right) => left.vendor.localeCompare(right.vendor));
  const eligible = latest.filter((model) => !EXCLUDED_WINNER_RE.test(`${model.vendor} ${model.model}`));
  const metricNames = new Set(eligible.flatMap((model) => Object.keys(model.scores || {})));
  const winners = {};

  for (const metricName of metricNames) {
    const scored = eligible
      .map((model) => ({ model: model.model, score: model.scores?.[metricName] }))
      .filter(({ score }) => finiteNumber(score?.value) !== null);
    if (scored.length === 0) continue;
    const direction = scored.find(({ score }) => score?.direction === 'lower') ? 'lower' : 'higher';
    const values = scored.map(({ score }) => Number(score.value));
    const best = direction === 'lower' ? Math.min(...values) : Math.max(...values);
    winners[metricName] = scored.filter(({ score }) => Number(score.value) === best).map(({ model }) => model);
  }

  return { models: latest, winners };
}

export function validateCacheHitRange(low, high) {
  const normalizedLow = finiteNumber(low);
  const normalizedHigh = finiteNumber(high);
  return normalizedLow !== null
    && normalizedHigh !== null
    && normalizedLow >= 0
    && normalizedHigh <= 100
    && normalizedLow <= normalizedHigh;
}
