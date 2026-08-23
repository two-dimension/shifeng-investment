import { load } from 'cheerio';
import {
  CURRENT_GENERATION_RULES,
  derivePriceEvents,
  mergeTokenPriceHistory,
  normalizeCodingPlan,
  normalizeTokenPrice,
  normalizeVideoPrice,
  selectLatestGeneration,
} from './aiPricingData.js';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const OFFICIAL_DEFINITIONS = new Map(
  PUBLIC_SOURCE_REGISTRY.filter((source) => source.slice === 'pricing' && source.sourceKind === 'official')
    .map((source) => [source.id, source]),
);

const ADAPTER_CONFIG = Object.freeze({
  'openai-pricing': {
    vendor: 'OpenAI', kinds: ['token'], currency: 'USD', tokenUnit: 'per_million_tokens',
    currentPattern: /GPT[ -]?5\.6/gi,
  },
  'anthropic-pricing': {
    vendor: 'Anthropic', kinds: ['token'], currency: 'USD', tokenUnit: 'per_million_tokens',
    currentPattern: /Claude (?:Fable 5|Mythos 5|Opus 5|Sonnet 5|Haiku 4\.5)/gi,
  },
  'gemini-pricing': {
    vendor: 'Gemini', kinds: ['token'], currency: 'USD', tokenUnit: 'per_million_tokens',
    currentPattern: /Gemini (?:3\.7 Flash|3\.6 Flash|3\.5 Flash(?:-Lite)?|3\.1 Pro)/gi,
  },
  'zhipu-models': {
    vendor: '智谱', kinds: ['token'], currency: 'CNY', tokenUnit: 'per_million_tokens',
    currentPattern: /GLM-5\.2/gi,
  },
  'minimax-pricing': {
    vendor: 'MiniMax', kinds: ['token', 'video'], currency: 'CNY', tokenUnit: 'per_million_tokens',
    currentPattern: /MiniMax[- ]M2\.7(?:-highspeed)?/gi,
  },
  'minimax-coding-plan': {
    vendor: 'MiniMax', kinds: ['coding'], currency: 'CNY', currentPattern: /M2\.7/gi,
  },
  'kimi-pricing': {
    vendor: 'Kimi', kinds: ['token'], currency: 'CNY', tokenUnit: 'per_million_tokens',
    currentPattern: /Kimi[- ]K3/gi,
  },
  'deepseek-pricing': {
    vendor: 'DeepSeek', kinds: ['token'], currency: 'USD', tokenUnit: 'per_million_tokens',
    currentPattern: /DeepSeek[- ]V4(?:[- ](?:Flash|Pro))?/gi,
  },
  'mimo-pricing': {
    vendor: 'MiMo', kinds: ['token'], currency: 'CNY', tokenUnit: 'per_million_tokens',
    currentPattern: /MiMo[- ]V2\.5(?:[- ]Pro)?/gi,
  },
  'qwen-pricing': {
    vendor: 'Qwen', kinds: ['token'], currency: 'CNY', tokenUnit: 'per_million_tokens',
    currentPattern: /Qwen3\.8[- ](?:Max|Plus|Turbo)/gi,
  },
  'seedance-pricing': {
    vendor: 'Seedance', kinds: ['video'], currency: 'CNY', currentPattern: /(?:Doubao[- ])?Seedance[- ]2\.0(?:[- ](?:fast|mini))?/gi,
  },
  'kling-pricing': {
    vendor: 'Kling', kinds: ['video'], currency: 'CNY', currentPattern: /Kling[- ]3\.0(?:[- ](?:Omni|Turbo))?/gi,
  },
  'openai-codex-plan': {
    vendor: 'OpenAI', kinds: ['coding'], currency: 'USD', currentPattern: /Codex/gi,
  },
  'anthropic-claude-code-plan': {
    vendor: 'Anthropic', kinds: ['coding'], currency: 'USD', currentPattern: /Claude Code/gi,
  },
  'gemini-code-assist-plan': {
    vendor: 'Gemini', kinds: ['coding'], currency: 'USD', currentPattern: /Gemini Code Assist/gi,
  },
  'zhipu-coding-plan': {
    vendor: '智谱', kinds: ['coding'], currency: 'CNY', currentPattern: /GLM Coding Plan/gi,
  },
  'mimo-token-plan': {
    vendor: 'MiMo', kinds: ['coding'], currency: 'CNY', currentPattern: /Token Plan/gi,
  },
  'qwen-code-plan': {
    vendor: 'Qwen', kinds: ['coding'], currency: 'CNY', currentPattern: /Qwen Code/gi,
  },
  'kimi-coding-plan': {
    vendor: 'Kimi', kinds: ['coding'], currency: 'USD', currentPattern: /Kimi K2\.7 Code/gi,
  },
  'deepseek-coding-plan': {
    vendor: 'DeepSeek', kinds: ['coding'], currency: 'USD', currentPattern: /DeepSeek/gi,
  },
});

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[\s/_()（）·:：-]+/g, '');
}

function findHeader(headers, predicates) {
  return headers.findIndex((header) => predicates.some((predicate) => predicate(header)));
}

function tableRows($, table) {
  const rows = [];
  $(table).find('tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length > 0) rows.push(cells);
  });
  if (rows.length < 2) return null;
  return { headers: rows[0].map(normalizeHeader), rawHeaders: rows[0], rows: rows.slice(1) };
}

function amount(value) {
  if (value === null || value === undefined || /(?:询价|未公布|n\/a|^[-—]+$)/i.test(String(value).trim())) return null;
  const match = String(value).replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function currencyFrom(text, fallback) {
  const value = String(text || '');
  if (/\$|\bUSD\b/i.test(value)) return 'USD';
  if (/¥|￥|\bCNY\b|\bRMB\b|人民币|元(?:\b|\/|每)/i.test(value)) return 'CNY';
  return fallback || null;
}

function tokenUnitFrom(text, fallback) {
  const value = String(text || '').toLowerCase();
  if (/1\s*k|千\s*(?:tokens?|令牌)|\/\s*ktok/.test(value)) return 'per_thousand_tokens';
  if (/1\s*m|百万\s*(?:tokens?|令牌)|mtok|million\s+tokens?/.test(value)) return 'per_million_tokens';
  return fallback || null;
}

function videoUnitFrom(text) {
  const value = String(text || '').toLowerCase();
  if (/询价/.test(value)) return 'inquiry';
  if (/未公开|未公布/.test(value)) return 'unpublished';
  if (/百万\s*(?:tokens?|令牌)|1\s*m\s*tokens?|mtok|million\s+tokens?/.test(value)) return 'per_million_tokens';
  if (/千\s*(?:tokens?|令牌)|1\s*k\s*tokens?|ktok/.test(value)) return 'per_thousand_tokens';
  if (/每(?:条|个)?视频|\/\s*(?:video|条|次)|元\/视频/.test(value)) return 'per_video';
  if (/每秒|\/\s*s(?:ec(?:ond)?)?\b|\/秒/.test(value)) return 'per_second';
  return null;
}

function normalizeDiscovery(value) {
  return String(value || '').trim().replace(/MiniMax-M/i, 'MiniMax M');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function discoverCurrentGeneration(html, config) {
  const $ = load(String(html || ''));
  const explicit = $('[data-current-generation]').map((_, element) => normalizeDiscovery($(element).text())).get();
  if (explicit.length > 0) return unique(explicit);
  const matches = String($.root().text()).match(config.currentPattern) || [];
  return unique(matches.map(normalizeDiscovery));
}

function compactIdentity(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff.]+/g, '');
}

function isCurrentModel(model, generations, vendor) {
  const compactModel = compactIdentity(model);
  if (generations.some((generation) => compactModel.includes(compactIdentity(generation)))) return true;
  const rule = CURRENT_GENERATION_RULES[vendor];
  if (!(rule instanceof RegExp)) return false;
  rule.lastIndex = 0;
  return rule.test(model);
}

function sourceFields(definition, document, methodology) {
  const retrievedAt = document.retrievedAt;
  if (!retrievedAt || !Number.isFinite(Date.parse(retrievedAt))) throw new Error(`${definition.id} retrievedAt is invalid`);
  const finalUrl = new URL(document.finalUrl || definition.entryUrl);
  if (!definition.allowedHosts.includes(finalUrl.hostname.toLowerCase())) {
    throw new Error(`${definition.id} final URL host is not allowlisted`);
  }
  return {
    sourceLabel: `${definition.entity} 官网`,
    sourceUrl: finalUrl.toString(),
    sourceKind: 'official',
    asOf: retrievedAt.slice(0, 10),
    retrievedAt,
    commentary: methodology,
  };
}

function parseTokenTables(html, definition, document, config, generations) {
  const $ = load(html);
  const parsed = [];
  $('table').each((_, table) => {
    const extracted = tableRows($, table);
    if (!extracted) return;
    const { headers, rawHeaders, rows } = extracted;
    const modelIndex = findHeader(headers, [(header) => /^(?:model|模型|型号)$/.test(header), (header) => header.includes('modelname')]);
    const inputIndex = findHeader(headers, [(header) => (/^(?:base)?input(?:tokens?)?$|输入价格|^输入$/.test(header) && !/缓存|cache/.test(header))]);
    const outputIndex = findHeader(headers, [(header) => /^(?:output)(?:tokens?)?$|输出价格|^输出$/.test(header)]);
    if (modelIndex < 0 || (inputIndex < 0 && outputIndex < 0)) return;
    const cacheReadIndex = findHeader(headers, [(header) => /cachedinput|cachehits?|缓存读取|缓存命中/.test(header) && !/命中率/.test(header)]);
    const cacheWriteIndex = findHeader(headers, [(header) => /cachewrite|缓存写入|缓存写/.test(header)]);
    const contextIndex = findHeader(headers, [(header) => /context|上下文/.test(header)]);
    const serviceIndex = findHeader(headers, [(header) => /servicetier|服务档|速率/.test(header)]);
    const tableText = `${$(table).find('caption').text()} ${rawHeaders.join(' ')} ${$(table).text()}`;
    const currency = currencyFrom(tableText, config.currency);
    const tokenUnit = tokenUnitFrom(tableText, config.tokenUnit);
    if (!currency || !tokenUnit) throw new Error(`${definition.id} token currency or unit is not established`);
    const perTokens = tokenUnit === 'per_thousand_tokens' ? 1_000 : 1_000_000;
    for (const row of rows) {
      const model = String(row[modelIndex] || '').trim();
      if (!model || /^(?:model|模型)$/i.test(model)) continue;
      const inputPrice = amount(row[inputIndex]);
      const outputPrice = amount(row[outputIndex]);
      if (inputPrice === null && outputPrice === null) continue;
      const serviceTierText = String(row[serviceIndex] || model);
      const serviceTier = /highspeed|fast mode|极速/i.test(serviceTierText) ? 'highspeed' : 'standard';
      parsed.push(normalizeTokenPrice({
        vendor: config.vendor,
        model,
        generation: generations.find((generation) => compactIdentity(model).includes(compactIdentity(generation))) || null,
        currentGeneration: isCurrentModel(model, generations, config.vendor),
        contextTier: String(row[contextIndex] || 'standard').trim().toLowerCase(),
        serviceTier,
        currency,
        perTokens,
        originalUnit: `${currency} / ${perTokens.toLocaleString('en-US')} Tokens`,
        inputPrice,
        cacheReadPrice: amount(row[cacheReadIndex]),
        cacheWritePrice: amount(row[cacheWriteIndex]),
        outputPrice,
        ...sourceFields(definition, document, '从厂商官网价格表按列读取模型、上下文档与服务档'),
      }));
    }
  });
  return parsed;
}

function durationFrom(value) {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(?:s|秒)/i);
  return match ? Number(match[1]) : null;
}

function parseVideoTables(html, definition, document, config) {
  const $ = load(html);
  const parsed = [];
  $('table').each((_, table) => {
    const extracted = tableRows($, table);
    if (!extracted) return;
    const { headers, rawHeaders, rows } = extracted;
    const modelIndex = findHeader(headers, [(header) => /^(?:model|模型|模型名称计费项|模型名称)$/.test(header)]);
    const priceIndex = findHeader(headers, [(header) => /^(?:price|价格|单价)$/.test(header), (header) => /现金结算|单价/.test(header)]);
    if (modelIndex < 0 || priceIndex < 0) return;
    const modeIndex = findHeader(headers, [(header) => /mode|模式|功能|计费项/.test(header)]);
    const resolutionIndex = findHeader(headers, [(header) => /resolution|分辨率/.test(header)]);
    const durationIndex = findHeader(headers, [(header) => /duration|时长/.test(header)]);
    const unitIndex = findHeader(headers, [(header) => /unit|计费单位/.test(header)]);
    const tableText = `${$(table).find('caption').text()} ${rawHeaders.join(' ')}`;
    let lastModel = '';
    for (const row of rows) {
      lastModel = String(row[modelIndex] || '').trim() || lastModel;
      if (!lastModel) continue;
      const mode = String(row[modeIndex] || '').trim() || 'standard';
      const durationText = String(row[durationIndex] || mode);
      let priceUnit = videoUnitFrom(`${row[unitIndex] || ''} ${rawHeaders[priceIndex] || ''} ${tableText}`);
      const rowPrice = amount(row[priceIndex]);
      const pricingMode = rowPrice === null
        ? (/询价/.test(String(row[priceIndex] || '')) ? 'inquiry' : 'unpublished')
        : 'fixed';
      if (!priceUnit) priceUnit = pricingMode === 'fixed' ? null : pricingMode;
      if (!priceUnit) continue;
      const currency = pricingMode === 'fixed' ? currencyFrom(`${row[priceIndex]} ${tableText}`, config.currency) : null;
      if (pricingMode === 'fixed' && !currency) throw new Error(`${definition.id} video currency is not established`);
      let normalizedPrice = rowPrice;
      if (priceUnit === 'per_thousand_tokens') {
        normalizedPrice *= 1_000;
        priceUnit = 'per_million_tokens';
      }
      parsed.push(normalizeVideoPrice({
        vendor: config.vendor,
        model: lastModel,
        mode,
        resolution: String(row[resolutionIndex] || '').trim() || '—',
        durationSeconds: durationFrom(durationText),
        durationTier: durationText || '—',
        pricingMode,
        price: normalizedPrice,
        currency,
        priceUnit,
        ...sourceFields(definition, document, '保留官网视频 API 的原始计费单位；仅在可证明时生成可比单价'),
      }));
    }
  });
  return parsed;
}

function codingPriceMode(...values) {
  const text = values.join(' ');
  if (/询价/.test(text)) return 'inquiry';
  if (/未公开|未公布/.test(text)) return 'unpublished';
  return 'fixed';
}

function parseRowCodingTable($, table, extracted, definition, document, config) {
  const { headers, rows } = extracted;
  const planIndex = findHeader(headers, [(header) => /^(?:plan|套餐|套餐名称)$/.test(header)]);
  const monthlyIndex = findHeader(headers, [(header) => /monthly|月付|月费/.test(header)]);
  const annualIndex = findHeader(headers, [(header) => /annual|年付|年费/.test(header)]);
  if (planIndex < 0 || (monthlyIndex < 0 && annualIndex < 0)) return [];
  const allowanceIndex = findHeader(headers, [(header) => /allowance|额度|限制/.test(header)]);
  const overageIndex = findHeader(headers, [(header) => /overage|超量/.test(header)]);
  return rows.flatMap((row) => {
    const plan = String(row[planIndex] || '').trim();
    if (!plan) return [];
    const pricingMode = codingPriceMode(row[monthlyIndex], row[annualIndex]);
    return [normalizeCodingPlan({
      vendor: config.vendor,
      plan,
      pricingMode,
      currency: config.currency,
      monthlyPrice: amount(row[monthlyIndex]),
      annualPrice: amount(row[annualIndex]),
      allowanceText: String(row[allowanceIndex] || '').trim() || null,
      overage: String(row[overageIndex] || '').trim() || null,
      ...sourceFields(definition, document, '从厂商官网 Coding Plan 套餐表读取月付、年付、额度与超量规则'),
    })];
  });
}

function parseMatrixCodingTables(html, definition, document, config) {
  const $ = load(html);
  const observations = new Map();
  $('table').each((_, table) => {
    const extracted = tableRows($, table);
    if (!extracted || extracted.rawHeaders.length < 2) return;
    const priceRow = extracted.rows.find((row) => /^(?:价格|price)$/i.test(String(row[0] || '').trim()));
    if (!priceRow) return;
    const allowanceRow = extracted.rows.find((row) => /M2\.7/i.test(String(row[0] || '')));
    const heading = $(table).prevAll('h1,h2,h3,h4').first().text();
    const annual = /年|annual/i.test(heading);
    for (let index = 1; index < extracted.rawHeaders.length; index += 1) {
      const plan = String(extracted.rawHeaders[index] || '').replace(/立省[^\s]*/g, '').trim();
      const price = amount(priceRow[index]);
      if (!plan || price === null) continue;
      const key = plan.toLowerCase();
      const observation = observations.get(key) || { plan, monthlyPrice: null, annualPrice: null, allowanceText: null };
      if (annual) observation.annualPrice = price;
      else observation.monthlyPrice = price;
      observation.allowanceText ||= String(allowanceRow?.[index] || '').trim() || null;
      observations.set(key, observation);
    }
  });
  return [...observations.values()].map((observation) => normalizeCodingPlan({
    vendor: config.vendor,
    pricingMode: 'fixed',
    currency: config.currency,
    ...observation,
    overage: null,
    ...sourceFields(definition, document, '从厂商官网矩阵套餐表合并月付与年付价格'),
  }));
}

function parseCodingTables(html, definition, document, config) {
  const $ = load(html);
  const rowRecords = [];
  $('table').each((_, table) => {
    const extracted = tableRows($, table);
    if (extracted) rowRecords.push(...parseRowCodingTable($, table, extracted, definition, document, config));
  });
  return rowRecords.length > 0 ? rowRecords : parseMatrixCodingTables(html, definition, document, config);
}

function parseKimiK3Markdown(markdown, definition, document, config) {
  const row = String(markdown || '').match(/\["kimi-k3",\s*"1M tokens"([\s\S]{0,500}?)\]/i)?.[1] || '';
  const values = [...row.matchAll(/\{\s*"\$"\s*\}([\d.]+)/g)].map((match) => Number(match[1]));
  if (values.length < 3) throw new Error('kimi-pricing K3 official price row not found');
  return [normalizeTokenPrice({
    vendor: config.vendor,
    model: 'Kimi K3',
    generation: 'K3',
    currentGeneration: true,
    contextTier: '1M context',
    serviceTier: 'standard',
    currency: 'USD',
    priceUnit: 'per_million_tokens',
    inputPrice: values[1],
    cacheReadPrice: values[0],
    cacheWritePrice: null,
    outputPrice: values[2],
    ...sourceFields(definition, document, '从 Kimi 官网 K3 Markdown 定价表读取缓存命中、缓存未命中与输出价格'),
  })];
}

function validateOfficialDefinition(definition) {
  const registered = OFFICIAL_DEFINITIONS.get(definition?.id);
  if (!registered || !ADAPTER_CONFIG[definition.id]) {
    throw new Error(`${definition?.id || 'unknown'} is not a registered official pricing source`);
  }
  if (registered.entryUrl !== definition.entryUrl || definition.slice !== 'pricing' || definition.sourceKind !== 'official') {
    throw new Error(`${definition.id} does not match the registered official pricing source`);
  }
  return registered;
}

export function createOfficialPricingAdapter(definition) {
  const registered = validateOfficialDefinition(definition);
  const config = ADAPTER_CONFIG[registered.id];
  return Object.freeze({
    sourceId: registered.id,
    discoverCurrentGeneration(document) {
      const html = typeof document === 'string' ? document : document?.text;
      return discoverCurrentGeneration(html, config);
    },
    parsePricing(document) {
      if (!document?.text) throw new Error(`${registered.id} returned an empty HTML document`);
      const generations = discoverCurrentGeneration(document.text, config);
      return {
        token: config.kinds.includes('token')
          ? (registered.id === 'kimi-pricing'
            ? parseKimiK3Markdown(document.text, registered, document, config)
            : parseTokenTables(document.text, registered, document, config, generations))
          : [],
        video: config.kinds.includes('video')
          ? parseVideoTables(document.text, registered, document, config)
          : [],
        codingPlans: config.kinds.includes('coding')
          ? parseCodingTables(document.text, registered, document, config)
          : [],
        discoveredGenerations: generations,
      };
    },
  });
}

function historyKey(record, fields) {
  return [...fields.map((field) => record?.[field] ?? ''), record?.asOf || ''].join('|').toLowerCase();
}

function mergeHistory(previous, incoming, fields) {
  const merged = new Map();
  for (const record of [...(previous || []), ...(incoming || [])]) {
    if (!record?.sourceUrl || record.sourceKind !== 'official' || !record.asOf) continue;
    merged.set(historyKey(record, fields), record);
  }
  return [...merged.values()].sort((left, right) => String(left.asOf).localeCompare(String(right.asOf)));
}

function latestRows(history, fields) {
  const latest = new Map();
  for (const record of history) {
    const key = fields.map((field) => record?.[field] ?? '').join('|').toLowerCase();
    const previous = latest.get(key);
    if (!previous || record.asOf >= previous.asOf) latest.set(key, record);
  }
  return [...latest.values()];
}

export function createAiPricingCollector({
  documentClient,
  registry = PUBLIC_SOURCE_REGISTRY.filter((source) => source.slice === 'pricing'),
} = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') {
    throw new Error('pricing collector requires an official document client');
  }
  const sources = registry.map((definition) => ({
    definition: validateOfficialDefinition(definition),
    adapter: createOfficialPricingAdapter(definition),
  }));
  if (sources.length === 0) throw new Error('pricing collector requires registered official sources');

  return async function collectPricing({ previous = {}, generatedAt = new Date().toISOString() } = {}) {
    const results = await Promise.all(sources.map(async ({ definition, adapter }) => {
      try {
        const document = await documentClient.fetchDocument(definition);
        const parsed = adapter.parsePricing(document);
        return { definition, parsed, status: 'ready' };
      } catch (error) {
        return { definition, error, status: 'error' };
      }
    }));
    const succeeded = results.filter((result) => result.status === 'ready');
    if (succeeded.length === 0) {
      throw new Error(`all ${sources.length} official pricing sources failed: ${results.map((result) => `${result.definition.id}: ${result.error?.message}`).join('; ')}`);
    }
    const incomingToken = succeeded.flatMap((result) => result.parsed.token);
    const incomingVideo = succeeded.flatMap((result) => result.parsed.video);
    const incomingCoding = succeeded.flatMap((result) => result.parsed.codingPlans);
    const previousPricing = previous.modelPricing || {};
    const tokenHistory = mergeTokenPriceHistory(
      (previousPricing.tokenHistory || []).filter((row) => row?.sourceKind === 'official' && row?.sourceUrl),
      incomingToken,
    );
    const videoHistory = mergeHistory(
      previousPricing.videoHistory || previousPricing.video,
      incomingVideo,
      ['vendor', 'model', 'mode', 'resolution', 'durationTier', 'currency', 'priceUnit'],
    );
    const codingPlanHistory = mergeHistory(
      previousPricing.codingPlanHistory || previousPricing.codingPlans,
      incomingCoding,
      ['vendor', 'plan', 'region', 'currency'],
    );
    const failed = results.length - succeeded.length;
    const previousReports = new Map((previousPricing.sourceReports || []).map((report) => [report.sourceId, report]));
    const sourceReports = results.map((result) => {
      const rows = result.status === 'ready'
        ? result.parsed.token.length + result.parsed.video.length + result.parsed.codingPlans.length
        : 0;
      const previousReport = previousReports.get(result.definition.id);
      return {
        sourceId: result.definition.id,
        entity: result.definition.entity,
        url: result.definition.entryUrl,
        status: result.status,
        asOf: result.status === 'ready' ? generatedAt.slice(0, 10) : null,
        rows,
        message: result.error?.message
          || (rows === 0 ? previousReport?.message || '官网可访问，但尚未解析出可复核的结构化价格行。' : null),
      };
    });
    return {
      payload: {
        modelPricing: {
          token: selectLatestGeneration(tokenHistory, CURRENT_GENERATION_RULES),
          tokenHistory,
          priceEvents: derivePriceEvents(tokenHistory),
          video: latestRows(videoHistory, ['vendor', 'model', 'mode', 'resolution', 'durationTier', 'currency', 'priceUnit']),
          videoHistory,
          codingPlans: latestRows(codingPlanHistory, ['vendor', 'plan', 'region', 'currency']),
          codingPlanHistory,
          sourceReports,
        },
      },
      source: {
        status: 'ready',
        stale: failed > 0,
        asOf: generatedAt.slice(0, 10),
        url: succeeded[0].definition.entryUrl,
        message: `${succeeded.length}/${results.length} 个厂商官网价格源同步成功${failed ? `；${failed} 个沿用上一版` : ''}`,
      },
    };
  };
}
