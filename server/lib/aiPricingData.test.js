import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_GENERATION_RULES,
  derivePriceEvents,
  mergeTokenPriceHistory,
  normalizeCodingPlan,
  normalizeTokenPrice,
  normalizeVideoPrice,
  selectLatestGeneration,
} from './aiPricingData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ai-pricing/current-token-prices.json'), 'utf8'));
const source = {
  sourceLabel: 'Official pricing test fixture',
  sourceUrl: 'https://example.test/pricing',
  sourceKind: 'official',
  asOf: '2026-08-23',
  retrievedAt: '2026-08-23T01:02:03.000Z',
};

test('token normalization keeps currency and price dimensions while converting to one million tokens', () => {
  const gemini = normalizeTokenPrice({ ...fixture.find((row) => row.vendor === 'Gemini'), ...source });

  assert.equal(gemini.currency, 'USD');
  assert.equal(gemini.priceUnit, 'per_million_tokens');
  assert.equal(gemini.contextTier, 'short');
  assert.equal(gemini.serviceTier, 'standard');
  assert.equal(gemini.inputPrice, 2);
  assert.equal(gemini.cacheReadPrice, 0.2);
  assert.equal(gemini.cacheWritePrice, null);
  assert.equal(gemini.outputPrice, 12);
  assert.equal(gemini.provenance.sourceUrl, source.sourceUrl);
});

test('latest-generation selection covers all required vendors and does not exclude Fable or Mythos', () => {
  const history = fixture.map((row) => normalizeTokenPrice({ ...row, ...source }));
  const latest = selectLatestGeneration(history, CURRENT_GENERATION_RULES);
  const vendors = new Set(latest.map((row) => row.vendor));

  for (const vendor of ['OpenAI', 'Anthropic', 'Gemini', '智谱', 'MiniMax', 'Kimi', 'DeepSeek', 'MiMo', 'Qwen']) {
    assert.equal(vendors.has(vendor), true, `${vendor} should be represented`);
  }
  assert.equal(latest.some((row) => row.model === 'Claude Fable 5'), true);
  assert.equal(latest.some((row) => row.model === 'Claude Mythos 5'), true);
  assert.equal(latest.some((row) => row.model === 'GPT 5.5'), false);
  assert.equal(latest.filter((row) => row.model === 'GPT 5.6 Sol').length, 2, 'short and long context remain distinct');
});

test('price events compare only the exact same SKU, context, currency, and price field', () => {
  const base = {
    vendor: 'OpenAI', model: 'GPT 5.6 Sol', generation: 'GPT 5.6', currentGeneration: true,
    currency: 'USD', perTokens: 1_000_000, contextTier: 'short', serviceTier: 'standard',
    inputPrice: 5, outputPrice: 30, ...source,
  };
  const history = [
    normalizeTokenPrice({ ...base, asOf: '2026-06-01' }),
    normalizeTokenPrice({ ...base, asOf: '2026-08-01', inputPrice: 4, outputPrice: 24 }),
    normalizeTokenPrice({ ...base, asOf: '2026-08-15', contextTier: 'long', inputPrice: 8, outputPrice: 36 }),
    normalizeTokenPrice({ ...base, asOf: '2026-08-16', currency: 'CNY', inputPrice: 8, outputPrice: 36 }),
    normalizeTokenPrice({ ...base, asOf: '2026-08-17', model: 'GPT 5.6 Sol v2', inputPrice: 3, outputPrice: 20 }),
  ];

  const events = derivePriceEvents(history);

  assert.deepEqual(events.map((event) => [event.priceField, event.oldPrice, event.newPrice, event.percentDelta]), [
    ['inputPrice', 5, 4, -0.2],
    ['outputPrice', 30, 24, -0.2],
  ]);
});

test('history merge is idempotent for a repeated observation of the same full SKU and date', () => {
  const record = normalizeTokenPrice({ ...fixture[0], ...source });
  const merged = mergeTokenPriceHistory([record], [record, { ...record }]);
  assert.equal(merged.length, 1);
});

test('video normalization preserves original units and only derives USD per second when justified', () => {
  const seedance = normalizeVideoPrice({
    vendor: 'Seedance', model: 'Seedance 1.5 Pro', mode: 'audio', resolution: '1080p',
    pricingMode: 'fixed', price: 16, currency: 'CNY', priceUnit: 'per_million_tokens', ...source,
  });
  const kling = normalizeVideoPrice({
    vendor: 'Kling', model: 'Kling API', mode: 'standard', resolution: '—',
    pricingMode: 'inquiry', priceUnit: 'inquiry', ...source,
  });
  const comparable = normalizeVideoPrice({
    vendor: 'Example', model: 'Video One', mode: 'standard', resolution: '720p', durationSeconds: 5,
    pricingMode: 'fixed', price: 1, currency: 'USD', priceUnit: 'per_video', ...source,
  });

  assert.equal(seedance.displayUnit, 'CNY / 1M Tokens');
  assert.equal(seedance.comparableUsdPerSecond, null);
  assert.equal(kling.pricingMode, 'inquiry');
  assert.equal(kling.price, null);
  assert.equal(comparable.comparableUsdPerSecond, 0.2);
});

test('coding plan normalization supports monthly, annual-effective, inquiry, and missing overage', () => {
  const fixed = normalizeCodingPlan({
    vendor: 'MiniMax', plan: 'Starter', pricingMode: 'fixed', currency: 'CNY',
    monthlyPrice: 29, annualPrice: 290, allowanceText: '官方说明额度', overage: null, region: '中国', ...source,
  });
  const inquiry = normalizeCodingPlan({
    vendor: 'Example', plan: 'Enterprise', pricingMode: 'inquiry', allowanceText: '定制', ...source,
  });

  assert.equal(fixed.monthlyPrice, 29);
  assert.equal(fixed.annualMonthlyPrice, 290 / 12);
  assert.equal(fixed.overage, null);
  assert.equal(inquiry.monthlyPrice, null);
  assert.equal(inquiry.currency, null);
});
