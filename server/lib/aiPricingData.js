const TOKEN_PRICE_FIELDS = Object.freeze([
  'inputPrice',
  'cacheReadPrice',
  'cacheWritePrice',
  'outputPrice',
]);

const PRICE_UNIT_LABELS = Object.freeze({
  per_million_tokens: '1M Tokens',
  per_thousand_tokens: '1K Tokens',
  per_video: '条视频',
  per_second: '秒',
  inquiry: '询价',
  unpublished: '未公开',
});

export const CURRENT_GENERATION_RULES = Object.freeze({
  OpenAI: /\bGPT[ -]?5\.6\b/i,
  Anthropic: /\bClaude (?:Fable 5|Mythos 5|Opus 5|Sonnet 5|Haiku 4\.5)\b/i,
  Gemini: /\bGemini (?:3\.7 Flash|3\.6 Flash|3\.5 Flash(?:-Lite)?|3\.1 Pro)\b/i,
  智谱: /\bGLM-5\.2\b/i,
  MiniMax: /\bMiniMax M2\.7\b/i,
  Kimi: /\bKimi K3\b/i,
  DeepSeek: /\bDeepSeek V4(?:\s|$)/i,
  MiMo: /\bMiMo V2\.5(?:\s|$)/i,
  Qwen: /\bQwen3\.8(?:-|\s|$)/i,
});

function cleanText(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function requiredText(value, label) {
  const result = cleanText(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function nullableNumber(value, label) {
  if (value === null || value === undefined || value === '' || value === '—') return null;
  const number = typeof value === 'number' ? value : Number(String(value).replaceAll(',', '').trim());
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number or null`);
  return number;
}

function normalizedDate(value, label) {
  const result = requiredText(value, label);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date`);
  return result.slice(0, 10);
}

function provenanceFrom(record, methodology) {
  const sourceLabel = requiredText(record.sourceLabel, 'sourceLabel');
  const sourceUrl = requiredText(record.sourceUrl, 'sourceUrl');
  const sourceKind = record.sourceKind || 'official';
  if (sourceKind !== 'official') throw new Error('pricing sourceKind must be official');
  const asOf = normalizedDate(record.asOf, 'asOf');
  const retrievedAt = requiredText(record.retrievedAt, 'retrievedAt');
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('retrievedAt must be a valid date-time');
  return {
    sourceLabel,
    sourceUrl,
    sourceKind,
    asOf,
    retrievedAt,
    methodology,
    commentary: cleanText(record.commentary || record.note),
    stale: Boolean(record.stale),
  };
}

function perMillionMultiplier(record) {
  if (record.priceUnit === 'per_million_tokens') return 1;
  if (record.priceUnit === 'per_thousand_tokens') return 1_000;
  const perTokens = nullableNumber(record.perTokens ?? 1_000_000, 'perTokens');
  if (!perTokens || perTokens <= 0) throw new Error('perTokens must be positive');
  return 1_000_000 / perTokens;
}

function scaledPrice(record, field, multiplier) {
  const value = nullableNumber(record[field], field);
  if (value === null) return null;
  return Number((value * multiplier).toPrecision(14));
}

function tokenSkuKey(record) {
  return [
    record.vendor,
    record.model,
    record.serviceTier || 'standard',
    record.contextTier || 'standard',
    record.currency,
    record.region || 'global',
    record.priceUnit || 'per_million_tokens',
  ].map((value) => String(value).trim().toLowerCase()).join('|');
}

export function normalizeTokenPrice(record) {
  const vendor = requiredText(record?.vendor, 'vendor');
  const model = requiredText(record?.model, 'model');
  const currency = requiredText(record?.currency, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter code');
  const multiplier = perMillionMultiplier(record);
  const prices = Object.fromEntries(TOKEN_PRICE_FIELDS.map((field) => [field, scaledPrice(record, field, multiplier)]));
  if (prices.inputPrice === null && prices.outputPrice === null) {
    throw new Error('token price requires an input or output price');
  }
  const provenance = provenanceFrom(
    record,
    `厂商官网公开价；统一换算为 ${currency} / 1M Tokens，未进行币种换算`,
  );
  return {
    region: cleanText(record.region) || 'global',
    vendor,
    model,
    generation: cleanText(record.generation),
    releasedAt: cleanText(record.releasedAt),
    category: cleanText(record.category),
    contextTier: cleanText(record.contextTier) || 'standard',
    serviceTier: cleanText(record.serviceTier) || 'standard',
    currency,
    priceUnit: 'per_million_tokens',
    originalUnit: cleanText(record.originalUnit)
      || `${currency} / ${record.perTokens ? Number(record.perTokens).toLocaleString('en-US') : '1M'} Tokens`,
    publicPrice: record.publicPrice !== false,
    currentGeneration: typeof record.currentGeneration === 'boolean' ? record.currentGeneration : null,
    ...prices,
    // Retained as optional compatibility fields until the legacy dashboard parser is deleted.
    cacheHitLow: null,
    cacheHitHigh: null,
    cacheRangeValid: true,
    sourceLabel: provenance.sourceLabel,
    sourceUrl: provenance.sourceUrl,
    sourceKind: provenance.sourceKind,
    asOf: provenance.asOf,
    retrievedAt: provenance.retrievedAt,
    note: cleanText(record.note),
    provenance,
  };
}

function generationMatches(record, rules) {
  if (record.currentGeneration === true) return true;
  if (record.currentGeneration === false) return false;
  const rule = rules?.[record.vendor];
  if (!rule) return false;
  const candidate = `${record.model} ${record.generation || ''}`;
  if (rule instanceof RegExp) {
    rule.lastIndex = 0;
    return rule.test(candidate);
  }
  if (typeof rule === 'function') return Boolean(rule(record));
  if (Array.isArray(rule)) return rule.some((value) => candidate.toLowerCase().includes(String(value).toLowerCase()));
  return candidate.toLowerCase().includes(String(rule).toLowerCase());
}

export function selectLatestGeneration(prices, rules = CURRENT_GENERATION_RULES) {
  const latestBySku = new Map();
  for (const record of prices || []) {
    if (!record || record.publicPrice === false || (record.serviceTier || 'standard') !== 'standard') continue;
    if (!generationMatches(record, rules)) continue;
    const key = tokenSkuKey(record);
    const previous = latestBySku.get(key);
    if (!previous || String(record.asOf || '') >= String(previous.asOf || '')) latestBySku.set(key, record);
  }
  return [...latestBySku.values()].sort((left, right) => (
    left.vendor.localeCompare(right.vendor, 'zh-CN')
    || left.model.localeCompare(right.model, 'zh-CN')
    || left.contextTier.localeCompare(right.contextTier, 'en')
  ));
}

export function mergeTokenPriceHistory(previous, incoming) {
  const records = new Map();
  for (const record of [...(previous || []), ...(incoming || [])]) {
    if (!record?.vendor || !record?.model || !record?.currency || !record?.asOf) continue;
    records.set(`${tokenSkuKey(record)}|${record.asOf}`, record);
  }
  return [...records.values()].sort((left, right) => (
    String(left.asOf).localeCompare(String(right.asOf)) || tokenSkuKey(left).localeCompare(tokenSkuKey(right))
  ));
}

export function derivePriceEvents(history) {
  const grouped = new Map();
  for (const record of mergeTokenPriceHistory([], history)) {
    const key = tokenSkuKey(record);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const events = [];
  for (const records of grouped.values()) {
    records.sort((left, right) => String(left.asOf).localeCompare(String(right.asOf)));
    for (let index = 1; index < records.length; index += 1) {
      const previous = records[index - 1];
      const current = records[index];
      for (const priceField of TOKEN_PRICE_FIELDS) {
        const oldPrice = previous[priceField];
        const newPrice = current[priceField];
        if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice) || oldPrice === newPrice) continue;
        const absoluteDelta = newPrice - oldPrice;
        events.push({
          id: `${tokenSkuKey(current)}|${priceField}|${previous.asOf}|${current.asOf}`,
          vendor: current.vendor,
          model: current.model,
          contextTier: current.contextTier,
          serviceTier: current.serviceTier,
          region: current.region,
          currency: current.currency,
          priceUnit: current.priceUnit,
          priceField,
          oldPrice,
          newPrice,
          absoluteDelta,
          percentDelta: oldPrice === 0 ? null : absoluteDelta / oldPrice,
          previousAsOf: previous.asOf,
          asOf: current.asOf,
          sourceLabel: current.sourceLabel,
          sourceUrl: current.sourceUrl,
          provenance: current.provenance,
        });
      }
    }
  }
  return events.sort((left, right) => right.asOf.localeCompare(left.asOf) || left.id.localeCompare(right.id));
}

function videoDisplayUnit(currency, priceUnit) {
  if (priceUnit === 'inquiry') return '询价';
  if (priceUnit === 'unpublished') return '未公开';
  return `${currency} / ${PRICE_UNIT_LABELS[priceUnit] || priceUnit}`;
}

export function normalizeVideoPrice(record) {
  const vendor = requiredText(record?.vendor, 'vendor');
  const model = requiredText(record?.model, 'model');
  const pricingMode = cleanText(record.pricingMode) || 'fixed';
  if (!['fixed', 'inquiry', 'unpublished'].includes(pricingMode)) throw new Error('unsupported video pricingMode');
  const priceUnit = cleanText(record.priceUnit) || (pricingMode === 'fixed' ? null : pricingMode);
  if (!priceUnit || !PRICE_UNIT_LABELS[priceUnit]) throw new Error('unsupported video priceUnit');
  const price = pricingMode === 'fixed' ? nullableNumber(record.price, 'price') : null;
  const currency = pricingMode === 'fixed' ? requiredText(record.currency, 'currency').toUpperCase() : null;
  if (pricingMode === 'fixed' && price === null) throw new Error('fixed video price is required');
  const durationSeconds = nullableNumber(record.durationSeconds, 'durationSeconds');
  let comparableUsdPerSecond = null;
  if (currency === 'USD' && price !== null && priceUnit === 'per_second') comparableUsdPerSecond = price;
  if (currency === 'USD' && price !== null && priceUnit === 'per_video' && durationSeconds) {
    comparableUsdPerSecond = price / durationSeconds;
  }
  const provenance = provenanceFrom(
    record,
    comparableUsdPerSecond === null
      ? '保留厂商官网原始计费单位；因币种或计费单位不可比，未推导 USD / 秒'
      : '厂商官网公开价；仅在 USD 与明确视频时长同时存在时推导 USD / 秒',
  );
  return {
    vendor,
    model,
    mode: cleanText(record.mode) || 'standard',
    resolution: cleanText(record.resolution) || '—',
    durationTier: cleanText(record.durationTier) || (durationSeconds ? `${durationSeconds} 秒` : '—'),
    durationSeconds,
    pricingMode,
    price,
    currency,
    priceUnit,
    displayUnit: videoDisplayUnit(currency, priceUnit),
    comparableUsdPerSecond,
    pricePerSecond: comparableUsdPerSecond,
    region: cleanText(record.region) || 'global',
    sourceLabel: provenance.sourceLabel,
    sourceUrl: provenance.sourceUrl,
    sourceKind: provenance.sourceKind,
    asOf: provenance.asOf,
    retrievedAt: provenance.retrievedAt,
    note: cleanText(record.note),
    provenance,
  };
}

export function normalizeCodingPlan(record) {
  const vendor = requiredText(record?.vendor, 'vendor');
  const plan = requiredText(record?.plan, 'plan');
  const pricingMode = cleanText(record.pricingMode) || 'fixed';
  if (!['fixed', 'inquiry', 'unpublished'].includes(pricingMode)) throw new Error('unsupported coding plan pricingMode');
  const monthlyPrice = pricingMode === 'fixed' ? nullableNumber(record.monthlyPrice, 'monthlyPrice') : null;
  const annualPrice = pricingMode === 'fixed' ? nullableNumber(record.annualPrice, 'annualPrice') : null;
  if (pricingMode === 'fixed' && monthlyPrice === null && annualPrice === null) {
    throw new Error('fixed coding plan requires monthlyPrice or annualPrice');
  }
  const currency = pricingMode === 'fixed' ? requiredText(record.currency, 'currency').toUpperCase() : null;
  const provenance = provenanceFrom(record, '厂商官网 Coding Plan 公开套餐价；年付折算/月为年价除以 12');
  return {
    vendor,
    plan,
    pricingMode,
    currency,
    monthlyPrice,
    annualPrice,
    annualMonthlyPrice: annualPrice === null ? null : annualPrice / 12,
    allowanceText: cleanText(record.allowanceText || record.limits),
    limits: cleanText(record.allowanceText || record.limits),
    overage: cleanText(record.overage),
    region: cleanText(record.region) || 'global',
    sourceLabel: provenance.sourceLabel,
    sourceUrl: provenance.sourceUrl,
    sourceKind: provenance.sourceKind,
    asOf: provenance.asOf,
    retrievedAt: provenance.retrievedAt,
    note: cleanText(record.note),
    provenance,
  };
}
