import { load } from 'cheerio';
import { enrichComputeQuotes, normalizeComputeQuote } from './aiComputeData.js';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';

const PLATFORM_BY_ID = Object.freeze({
  'aws-ec2-pricing': 'AWS',
  'azure-vm-pricing': 'Azure',
  'gcp-gpu-pricing': 'Google Cloud',
  'coreweave-pricing': 'CoreWeave',
  'lambda-cloud-pricing': 'Lambda',
});

export const AI_COMPUTE_SOURCE_REGISTRY = Object.freeze(
  PUBLIC_SOURCE_REGISTRY.filter((source) => Object.hasOwn(PLATFORM_BY_ID, source.id))
    .map((source) => Object.freeze({ ...source, platform: PLATFORM_BY_ID[source.id] })),
);

const SOURCE_BY_ID = new Map(AI_COMPUTE_SOURCE_REGISTRY.map((source) => [source.id, source]));

function validateDefinition(definition) {
  const registered = SOURCE_BY_ID.get(definition?.id);
  if (!registered || registered.entryUrl !== definition.entryUrl) throw new Error(`${definition?.id || 'unknown'} is not a registered official compute source`);
  return registered;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[\s/_()（）·:：-]+/g, '');
}

function findHeader(headers, regex) {
  return headers.findIndex((header) => regex.test(header));
}

function amount(value) {
  const match = String(value || '').replaceAll(',', '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function billingMode(value) {
  const text = String(value || '').toLowerCase();
  if (/spot/.test(text)) return 'spot';
  if (/preempt|抢占/.test(text)) return 'preemptible';
  if (/reserv|预留/.test(text)) return 'reserved';
  return 'on_demand';
}

function parseTables(definition, document) {
  if (!document?.text) return [];
  const finalUrl = new URL(document.finalUrl || definition.entryUrl);
  if (!definition.allowedHosts.includes(finalUrl.hostname.toLowerCase())) throw new Error('compute final URL host is not allowlisted');
  const $ = load(document.text);
  const quotes = [];
  $('table').each((_, table) => {
    const rows = [];
    $(table).find('tr').each((__, row) => {
      const cells = $(row).find('th,td').map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length) rows.push(cells);
    });
    if (rows.length < 2) return;
    const headers = rows[0].map(normalizeHeader);
    const instanceIndex = findHeader(headers, /instance|实例|规格/);
    const gpuIndex = findHeader(headers, /^(?:gpu|加速卡)$/);
    const countIndex = findHeader(headers, /gpucount|gpu数量|卡数/);
    const regionIndex = findHeader(headers, /region|地区|地域/);
    const billingIndex = findHeader(headers, /billing|计费|购买方式/);
    const priceIndex = findHeader(headers, /hourlyprice|每小时|小时价格|price/);
    if ([instanceIndex, gpuIndex, countIndex, regionIndex, billingIndex, priceIndex].some((index) => index < 0)) return;
    const tableText = `${$(table).find('caption').text()} ${rows[0].join(' ')}`;
    const currency = /\$|USD/i.test(tableText) ? 'USD' : /¥|CNY|人民币|元/.test(tableText) ? 'CNY' : null;
    if (!currency) throw new Error(`${definition.id} compute currency is not established`);
    for (const row of rows.slice(1)) {
      const instanceSpec = String(row[instanceIndex] || '').trim();
      const gpu = String(row[gpuIndex] || '').trim();
      const gpuCount = amount(row[countIndex]);
      const region = String(row[regionIndex] || '').trim();
      const instanceHourlyPrice = amount(row[priceIndex]);
      if (!instanceSpec || !gpu || !gpuCount || !region || instanceHourlyPrice === null) continue;
      quotes.push(normalizeComputeQuote({
        platform: definition.platform,
        gpu,
        instanceSpec,
        gpuCount,
        region,
        billingMode: billingMode(row[billingIndex]),
        currency,
        instanceHourlyPrice,
        asOf: document.retrievedAt.slice(0, 10),
        sourceLabel: `${definition.platform} 官网`,
        sourceUrl: finalUrl.toString(),
        sourceKind: 'official',
        retrievedAt: document.retrievedAt,
      }));
    }
  });
  return quotes;
}

export function createComputeSourceAdapter(definition) {
  const registered = validateDefinition(definition);
  return Object.freeze({ sourceId: registered.id, parseDocument: (document) => parseTables(registered, document) });
}

function mergeHistory(previous, incoming) {
  const history = new Map();
  for (const quote of [...(previous || []), ...(incoming || [])]) {
    if (!quote?.quoteKey || !quote?.asOf || quote.sourceKind !== 'official') continue;
    history.set(`${quote.quoteKey}|${quote.asOf}`, quote);
  }
  return enrichComputeQuotes([...history.values()]);
}

export function createAiComputeCollector({ documentClient, registry = AI_COMPUTE_SOURCE_REGISTRY } = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') throw new Error('compute collector requires an official document client');
  const sources = registry.map((definition) => ({ definition: validateDefinition(definition), adapter: createComputeSourceAdapter(definition) }));
  if (sources.length === 0) throw new Error('compute collector requires official sources');
  return async function collectCompute({ previous = {}, generatedAt = new Date().toISOString() } = {}) {
    const results = await Promise.all(sources.map(async ({ definition, adapter }) => {
      try {
        const document = await documentClient.fetchDocument(definition);
        return { definition, quotes: adapter.parseDocument(document), status: 'ready' };
      } catch (error) {
        return { definition, quotes: [], error, status: 'error' };
      }
    }));
    const succeeded = results.filter((result) => result.status === 'ready');
    if (succeeded.length === 0) throw new Error(`all ${sources.length} official compute sources failed`);
    const computeRental = mergeHistory(previous.computeRental, succeeded.flatMap((result) => result.quotes));
    const failed = results.length - succeeded.length;
    return {
      payload: {
        computeRental,
        computeSourceReports: results.map((result) => ({
          sourceId: result.definition.id, platform: result.definition.platform, url: result.definition.entryUrl,
          status: result.status, asOf: result.status === 'ready' ? generatedAt.slice(0, 10) : null,
          rows: result.quotes.length, message: result.error?.message || null,
        })),
      },
      source: {
        status: 'ready', stale: failed > 0, asOf: generatedAt.slice(0, 10), url: succeeded[0].definition.entryUrl,
        message: `${succeeded.length}/${results.length} 个算力官网价格源同步成功${failed ? `；${failed} 个沿用上一版` : ''}`,
      },
    };
  };
}
