function cleanText(value) {
  return String(value ?? '').trim() || null;
}

function requiredText(value, label) {
  const result = cleanText(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function nullableNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function dateOnly(value, label) {
  const result = requiredText(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a valid date`);
  return result.slice(0, 10);
}

function quoteKey(record) {
  return [record.platform, record.gpu, record.instanceSpec, record.region, record.billingMode, record.currency]
    .map((value) => String(value).trim().toLowerCase()).join('|');
}

export function normalizeComputeQuote(record) {
  const platform = requiredText(record?.platform, 'platform');
  const gpu = requiredText(record?.gpu, 'gpu');
  const instanceSpec = requiredText(record?.instanceSpec, 'instanceSpec');
  const region = requiredText(record?.region, 'region');
  const billingMode = requiredText(record?.billingMode, 'billingMode');
  if (!['on_demand', 'spot', 'preemptible', 'reserved', 'capacity_block'].includes(billingMode)) throw new Error(`unsupported billingMode: ${billingMode}`);
  const currency = requiredText(record.currency, 'currency').toUpperCase();
  const gpuCount = nullableNumber(record.gpuCount, 'gpuCount');
  if (!gpuCount || !Number.isInteger(gpuCount)) throw new Error('gpuCount must be a positive integer');
  const instanceHourlyPrice = nullableNumber(record.instanceHourlyPrice, 'instanceHourlyPrice');
  let pricePerGpuHour = nullableNumber(record.pricePerGpuHour, 'pricePerGpuHour');
  if (pricePerGpuHour === null && instanceHourlyPrice !== null) pricePerGpuHour = instanceHourlyPrice / gpuCount;
  if (pricePerGpuHour === null) throw new Error('pricePerGpuHour or instanceHourlyPrice is required');
  const asOf = dateOnly(record.asOf, 'asOf');
  const sourceKind = cleanText(record.sourceKind) || 'official';
  if (sourceKind !== 'official') throw new Error('compute sourceKind must be official');
  const retrievedAt = requiredText(record.retrievedAt, 'retrievedAt');
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('retrievedAt must be a valid date-time');
  const provenance = {
    sourceLabel: requiredText(record.sourceLabel, 'sourceLabel'),
    sourceUrl: requiredText(record.sourceUrl, 'sourceUrl'),
    sourceKind,
    asOf,
    retrievedAt,
    methodology: cleanText(record.methodology) || '厂商官网精确实例、地区和计费方式公开价；实例价按 GPU 数量折算',
    commentary: cleanText(record.commentary || record.note),
    stale: Boolean(record.stale),
  };
  const normalized = {
    platform,
    gpu,
    instanceSpec,
    gpuCount,
    region,
    billingMode,
    currency,
    instanceHourlyPrice,
    pricePerGpuHour,
    comparableUsdPerGpuHour: currency === 'USD' ? pricePerGpuHour : null,
    asOf,
    sourceLabel: provenance.sourceLabel,
    sourceUrl: provenance.sourceUrl,
    sourceKind,
    retrievedAt,
    note: cleanText(record.note),
    provenance,
  };
  return {
    ...normalized,
    quoteKey: quoteKey(normalized),
    previousPricePerGpuHour: null,
    absoluteChange: null,
    percentChange: null,
    latest: false,
  };
}

export function enrichComputeQuotes(quotes) {
  const deduped = new Map();
  for (const quote of quotes || []) deduped.set(`${quote.quoteKey || quoteKey(quote)}|${quote.asOf}`, quote);
  const grouped = new Map();
  for (const quote of deduped.values()) {
    const key = quote.quoteKey || quoteKey(quote);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(quote);
  }
  const enriched = [];
  for (const group of grouped.values()) {
    group.sort((left, right) => left.asOf.localeCompare(right.asOf));
    group.forEach((quote, index) => {
      const previous = index > 0 ? group[index - 1] : null;
      const absoluteChange = previous ? quote.pricePerGpuHour - previous.pricePerGpuHour : null;
      enriched.push({
        ...quote,
        previousPricePerGpuHour: previous?.pricePerGpuHour ?? null,
        absoluteChange,
        percentChange: previous && previous.pricePerGpuHour !== 0 ? absoluteChange / previous.pricePerGpuHour : null,
        latest: index === group.length - 1,
      });
    });
  }
  return enriched.sort((left, right) => right.asOf.localeCompare(left.asOf) || left.quoteKey.localeCompare(right.quoteKey));
}
