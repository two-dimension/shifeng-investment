const DAY_MS = 24 * 60 * 60 * 1000;
const YIPIT_STALE_DAYS = 18;

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
  const bySeries = new Map();
  for (const record of records || []) {
    const company = String(record?.company || '').trim();
    if (!company) continue;
    const sourceLabel = String(record?.sourceLabel || '未标注来源').trim();
    const seriesKind = record?.seriesKind === 'official' ? 'official' : 'estimate';
    const seriesId = String(record?.seriesId || `${company}:${seriesKind}:${sourceLabel}`);
    const bucket = bySeries.get(seriesId) || { company, sourceLabel, seriesKind, records: [] };
    bucket.records.push({ ...record, company, sourceLabel, seriesKind, seriesId });
    bySeries.set(seriesId, bucket);
  }

  return [...bySeries.entries()]
    .map(([seriesId, series]) => {
      const { company, sourceLabel, seriesKind, records: companyRecords } = series;
      const actualPoints = latestByMonth(companyRecords.filter((record) => record.kind !== 'forecast'))
        .map((point, index, points) => {
          const previous = points[index - 1] || null;
          const previousMonth = previous?.month;
          const currentMonth = point.month;
          const [previousYear, previousMonthNumber] = previousMonth?.split('-').map(Number) || [];
          const [currentYear, currentMonthNumber] = currentMonth.split('-').map(Number);
          const consecutiveMonth = previous
            ? currentYear * 12 + currentMonthNumber - (previousYear * 12 + previousMonthNumber) === 1
            : null;
          return {
            ...point,
            kind: 'actual',
            momAbsolute: previous ? point.value - previous.value : null,
            momPercent: previous && previous.value !== 0 ? (point.value - previous.value) / previous.value : null,
            comparisonLabel: previous ? `${previous.observedAt} → ${point.observedAt}` : null,
            consecutiveMonth,
          };
        });
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
        seriesId,
        seriesKind,
        sourceLabel,
        actualPoints,
        forecastPoints,
        latestActual,
        stale,
      };
    })
    .sort((left, right) => left.company.localeCompare(right.company)
      || left.seriesKind.localeCompare(right.seriesKind)
      || left.sourceLabel.localeCompare(right.sourceLabel));
}

export function buildArrComparison(companies, names) {
  const includedNames = new Set(names || []);
  const selected = (companies || []).filter((metric) => includedNames.has(metric.company));
  const months = [...new Set(selected.flatMap((metric) => metric.actualPoints.map((point) => point.month)))].sort();
  return {
    months,
    series: selected.map((metric) => {
      const byMonth = new Map(metric.actualPoints.map((point) => [point.month, point]));
      return {
        company: metric.company,
        seriesId: metric.seriesId,
        seriesKind: metric.seriesKind,
        sourceLabel: metric.sourceLabel,
        points: months.map((month) => byMonth.get(month) || null),
      };
    }),
  };
}

export function attachValuationMultiples(valuations, arrMetrics) {
  return (valuations || []).map((valuation) => {
    const asOf = dateKey(valuation.asOf);
    const companySeries = (arrMetrics || []).filter((metric) => metric.company === valuation.company);
    const matchingSeries = companySeries
      .filter((metric) => !valuation.arrSeriesKind || metric.seriesKind === valuation.arrSeriesKind)
      .filter((metric) => !valuation.arrSourceLabel || metric.sourceLabel === valuation.arrSourceLabel)
      .toSorted((left, right) => {
        if (left.seriesKind !== right.seriesKind) return left.seriesKind === 'official' ? -1 : 1;
        return left.sourceLabel.localeCompare(right.sourceLabel);
      })[0];
    const points = matchingSeries?.actualPoints
      .toSorted((left, right) => left.observedAt.localeCompare(right.observedAt)) || [];
    const matched = asOf ? points.filter((point) => point.observedAt <= asOf).at(-1) : null;
    const arrValue = matched?.value ?? null;
    const valuationLow = finiteNumber(valuation.valuationLow);
    const valuationHigh = finiteNumber(valuation.valuationHigh ?? valuation.valuationLow);
    return {
      ...valuation,
      asOf,
      arrAsOf: matched?.observedAt ?? null,
      arrValue,
      arrSeriesKind: matchingSeries?.seriesKind || valuation.arrSeriesKind || null,
      arrSourceLabel: matched?.sourceLabel || matchingSeries?.sourceLabel || null,
      arrMethodology: matched?.methodology || matched?.provenance?.methodology || null,
      arrProvenance: matched?.provenance || null,
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

function bigintPercent(delta, prior) {
  if (prior === 0n) return null;
  return Number((delta * 1_000_000n) / prior) / 1_000_000;
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
    const total = sumRows(weekRows);
    const previous = history.at(-1);
    const previousTotal = previous ? BigInt(previous.totalTokens) : null;
    const delta = previousTotal === null ? null : total - previousTotal;
    history.push({
      startDate: weekStart,
      endDate: weekEnd,
      totalTokens: total.toString(),
      weekOverWeekAbsolute: delta === null ? null : delta.toString(),
      weekOverWeekPercent: delta === null ? null : bigintPercent(delta, previousTotal),
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

  const latestHistory = history.at(-1);
  const priorHistory = history.at(-2);
  return {
    startDate: latestStart,
    endDate: resolvedEndDate,
    weekTotalTokens: sumRows(latestRows).toString(),
    priorWeekTotalTokens: priorHistory?.totalTokens ?? null,
    weekOverWeekAbsolute: latestHistory?.weekOverWeekAbsolute ?? null,
    weekOverWeekPercent: latestHistory?.weekOverWeekPercent ?? null,
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
  const metricNames = new Set(latest.flatMap((model) => Object.keys(model.scores || {})));
  const winners = {};

  for (const metricName of metricNames) {
    const scored = latest
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
