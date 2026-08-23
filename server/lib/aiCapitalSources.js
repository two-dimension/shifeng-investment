import { load } from 'cheerio';
import { buildCapitalMetrics, normalizeCapitalEvent } from './aiCapitalData.js';

const DAY_MS = 86_400_000;

function activeSource(id, entity, geography, entryUrl, allowedHosts, sourceKind = 'official', format = 'html') {
  return Object.freeze({ id, entity, geography, entryUrl, allowedHosts: Object.freeze(allowedHosts), sourceKind, format, freshMs: DAY_MS, status: 'active' });
}

function discoverySource(id, entity, geography, entryUrl = null) {
  return Object.freeze({ id, entity, geography, entryUrl, allowedHosts: Object.freeze([]), sourceKind: 'official', format: 'html', freshMs: DAY_MS, status: 'discovery-maintained' });
}

export const AI_CAPITAL_SOURCE_REGISTRY = Object.freeze([
  activeSource('openai-capital', 'OpenAI', 'US', 'https://openai.com/news/company/', ['openai.com']),
  activeSource('anthropic-capital', 'Anthropic', 'US', 'https://www.anthropic.com/news', ['www.anthropic.com']),
  activeSource('google-sec', 'Google', 'US', 'https://data.sec.gov/submissions/CIK0001652044.json', ['data.sec.gov'], 'filing', 'json'),
  activeSource('microsoft-sec', 'Microsoft', 'US', 'https://data.sec.gov/submissions/CIK0000789019.json', ['data.sec.gov'], 'filing', 'json'),
  activeSource('amazon-sec', 'Amazon', 'US', 'https://data.sec.gov/submissions/CIK0001018724.json', ['data.sec.gov'], 'filing', 'json'),
  activeSource('meta-sec', 'Meta', 'US', 'https://data.sec.gov/submissions/CIK0001326801.json', ['data.sec.gov'], 'filing', 'json'),
  activeSource('xai-capital', 'xAI', 'US', 'https://x.ai/news', ['x.ai']),
  activeSource('coreweave-capital', 'CoreWeave', 'US', 'https://investors.coreweave.com/news-events/news-releases', ['investors.coreweave.com']),
  activeSource('alibaba-capital', 'Alibaba', 'China', 'https://www.alibabagroup.com/en-US/ir-filings-hkex', ['www.alibabagroup.com'], 'filing'),
  activeSource('tencent-capital', 'Tencent', 'China', 'https://www.tencent.com/en-us/investors.html', ['www.tencent.com'], 'filing'),
  activeSource('baidu-capital', 'Baidu', 'China', 'https://ir.baidu.com/', ['ir.baidu.com'], 'filing'),
  discoverySource('zhipu-capital', '智谱', 'China', 'https://www.zhipuai.cn/'),
  discoverySource('minimax-capital', 'MiniMax', 'China', 'https://www.minimaxi.com/'),
  discoverySource('moonshot-capital', 'Moonshot', 'China', 'https://www.moonshot.cn/'),
  discoverySource('deepseek-capital', 'DeepSeek', 'China', 'https://www.deepseek.com/'),
  activeSource('xiaomi-capital', 'Xiaomi', 'China', 'https://ir.mi.com/', ['ir.mi.com'], 'filing'),
]);

const SOURCE_BY_ID = new Map(AI_CAPITAL_SOURCE_REGISTRY.map((source) => [source.id, source]));

function validateDefinition(definition) {
  const registered = SOURCE_BY_ID.get(definition?.id);
  if (!registered || registered.status !== 'active') throw new Error(`${definition?.id || 'unknown'} is not an active official capital source`);
  if (registered.entryUrl !== definition.entryUrl) throw new Error(`${definition.id} does not match the capital source registry`);
  return registered;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseAmount(text) {
  const match = text.match(/(\$|USD\s*|CNY\s*|RMB\s*|¥\s*)([\d,.]+)\s*(billion|million|bn|mn|亿|百万)?/i);
  if (!match) return null;
  const symbol = match[1].toUpperCase();
  const currency = symbol.includes('$') || symbol.includes('USD') ? 'USD' : 'CNY';
  const unitText = String(match[3] || '').toLowerCase();
  const amountUnit = unitText === 'billion' || unitText === 'bn' ? 'billion'
    : unitText === '亿' ? '亿'
      : unitText === '百万' || unitText === 'million' || unitText === 'mn' ? 'million' : 'base';
  return { amount: Number(match[2].replaceAll(',', '')), amountUnit, currency };
}

function inferInstrument(text) {
  if (/primary equity|equity financing|funding round|financing round/i.test(text)) {
    return { instrumentCategory: 'equity', instrument: 'Equity financing round' };
  }
  if (/convertible (?:senior )?notes?/i.test(text)) {
    return { instrumentCategory: 'convertible', instrument: 'Convertible senior notes' };
  }
  if (/credit facility|revolving credit/i.test(text)) {
    return { instrumentCategory: 'credit_facility', instrument: 'Credit facility' };
  }
  if (/senior (?:unsecured )?notes?/i.test(text)) {
    return { instrumentCategory: 'debt', instrument: 'Senior notes' };
  }
  if (/term loan/i.test(text)) return { instrumentCategory: 'debt', instrument: 'Term loan' };
  if (/debt financing/i.test(text)) return { instrumentCategory: 'debt', instrument: 'Debt financing' };
  return null;
}

function eventDateFrom($, text) {
  const explicit = $('time[datetime]').first().attr('datetime');
  if (explicit && Number.isFinite(Date.parse(explicit))) return explicit.slice(0, 10);
  const match = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
}

function parseArticle(definition, document) {
  if (!document?.text) return [];
  const finalUrl = new URL(document.finalUrl || definition.entryUrl);
  if (!definition.allowedHosts.includes(finalUrl.hostname.toLowerCase())) throw new Error('capital final URL host is not allowlisted');
  const $ = load(document.text);
  const article = $('article').first();
  const text = compactText(article.length ? article.text() : $('body').text());
  const eventDate = eventDateFrom($, text);
  const amount = parseAmount(text);
  const instrument = inferInstrument(text);
  if (!eventDate || !amount || !instrument) return [];
  const couponMatch = text.match(/(\d+(?:\.\d+)?)%\s+(?:senior|convertible|secured|unsecured)/i);
  const floatingMatch = text.match(/\b(SOFR|LIBOR)\b\s*\+\s*(\d+(?:\.\d+)?)\s*(?:bps?|basis points?)/i);
  const rateType = instrument.instrumentCategory === 'equity' ? 'not_applicable'
    : couponMatch ? 'fixed' : floatingMatch ? 'floating' : 'unknown';
  const maturityMatch = text.match(/\bdue\s+(20\d{2})\b/i);
  const proceeds = text.split(/(?<=[.!?])\s+/).find((sentence) => /proceeds/i.test(sentence)) || null;
  return [normalizeCapitalEvent({
    entity: definition.entity,
    geography: definition.geography,
    eventDate,
    maturityDate: maturityMatch ? `${maturityMatch[1]}-12-31` : null,
    ...instrument,
    ...amount,
    comparableUsdAmount: amount.currency === 'USD' ? amount.amount : null,
    comparableUsdAmountUnit: amount.amountUnit,
    rateType,
    couponPercent: couponMatch ? Number(couponMatch[1]) : null,
    benchmark: floatingMatch?.[1] || null,
    spreadBps: floatingMatch ? Number(floatingMatch[2]) : null,
    useOfProceeds: proceeds,
    sourceLabel: `${definition.entity} 官网`,
    sourceUrl: finalUrl.toString(),
    sourceKind: definition.sourceKind,
    asOf: eventDate,
    retrievedAt: document.retrievedAt,
  })];
}

export function createCapitalSourceAdapter(definition) {
  const registered = validateDefinition(definition);
  return Object.freeze({
    sourceId: registered.id,
    parseDocument(document) {
      if (registered.format !== 'html') return [];
      return parseArticle(registered, document);
    },
  });
}

function mergeEvents(previous, incoming) {
  const events = new Map();
  for (const event of [...(previous || []), ...(incoming || [])]) {
    if (!event?.id || !event?.sourceUrl || !['official', 'filing'].includes(event.sourceKind)) continue;
    events.set(event.id, event);
  }
  return [...events.values()].sort((left, right) => right.eventDate.localeCompare(left.eventDate));
}

export function createAiCapitalCollector({ documentClient, registry = AI_CAPITAL_SOURCE_REGISTRY } = {}) {
  if (!documentClient || typeof documentClient.fetchDocument !== 'function') throw new Error('capital collector requires an official document client');
  const active = registry.filter((source) => source.status === 'active').map((definition) => ({ definition, adapter: createCapitalSourceAdapter(definition) }));
  const discovery = registry.filter((source) => source.status === 'discovery-maintained');
  if (active.length === 0) throw new Error('capital collector requires active official sources');
  return async function collectCapital({ previous = {}, generatedAt = new Date().toISOString(), now = new Date() } = {}) {
    const results = await Promise.all(active.map(async ({ definition, adapter }) => {
      try {
        const document = await documentClient.fetchDocument(definition);
        return { definition, events: adapter.parseDocument(document), status: 'ready' };
      } catch (error) {
        return { definition, events: [], error, status: 'error' };
      }
    }));
    const succeeded = results.filter((result) => result.status === 'ready');
    if (succeeded.length === 0) throw new Error(`all ${active.length} active capital sources failed`);
    const capitalEvents = mergeEvents(previous.capitalEvents, succeeded.flatMap((result) => result.events));
    const failed = results.length - succeeded.length;
    const capitalSourceReports = [
      ...results.map((result) => ({
        sourceId: result.definition.id, entity: result.definition.entity, url: result.definition.entryUrl,
        status: result.status, asOf: result.status === 'ready' ? generatedAt.slice(0, 10) : null,
        rows: result.events.length, message: result.error?.message || null,
      })),
      ...discovery.map((definition) => ({
        sourceId: definition.id, entity: definition.entity, url: definition.entryUrl,
        status: 'discovery-maintained', asOf: null, rows: 0,
        message: '尚无可稳定复现的第一方融资端点；由公开网络发现流程维护，不使用聚合平台补值',
      })),
    ];
    return {
      payload: {
        capitalEvents,
        capitalMetrics: buildCapitalMetrics(capitalEvents, { now }),
        capitalSourceReports,
        debtFinancing: capitalEvents.filter((event) => event.instrumentCategory !== 'equity'),
      },
      source: {
        status: 'ready', stale: failed > 0, asOf: generatedAt.slice(0, 10),
        url: succeeded[0].definition.entryUrl,
        message: `${succeeded.length}/${results.length} 个可抓取的官网/监管融资源同步成功；${discovery.length} 家由来源发现流程维护`,
      },
    };
  };
}
