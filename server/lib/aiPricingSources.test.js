import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SOURCE_REGISTRY } from './publicSourceRegistry.js';
import {
  createAiPricingCollector,
  createOfficialPricingAdapter,
} from './aiPricingSources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/ai-pricing', name), 'utf8');
const definition = (id) => PUBLIC_SOURCE_REGISTRY.find((source) => source.id === id);
const document = (text, finalUrl) => ({
  text,
  finalUrl,
  retrievedAt: '2026-08-23T01:02:03.000Z',
  contentType: 'text/html',
});

test('official token adapter discovers the current generation and parses context/cache dimensions', () => {
  const source = definition('openai-pricing');
  const adapter = createOfficialPricingAdapter(source);
  const html = readFixture('openai-pricing.html');

  assert.deepEqual(adapter.discoverCurrentGeneration(html), ['GPT 5.6']);
  const parsed = adapter.parsePricing(document(html, source.entryUrl));
  assert.equal(parsed.token.length, 3);
  assert.equal(parsed.token[0].sourceUrl, source.entryUrl);
  assert.equal(parsed.token[0].sourceKind, 'official');
  assert.equal(parsed.token[0].currency, 'USD');
  assert.equal(parsed.token[0].inputPrice, 5);
  assert.equal(parsed.token[0].cacheWritePrice, 6.25);
  assert.equal(parsed.token[0].currentGeneration, true);
  assert.equal(parsed.token[2].currentGeneration, false);
});

test('official Chinese pricing adapter parses CNY per-million token rows without currency conversion', () => {
  const source = definition('minimax-pricing');
  const adapter = createOfficialPricingAdapter(source);
  const parsed = adapter.parsePricing(document(readFixture('minimax-pricing.html'), source.entryUrl));

  assert.equal(parsed.token[0].vendor, 'MiniMax');
  assert.equal(parsed.token[0].currency, 'CNY');
  assert.equal(parsed.token[0].inputPrice, 2.1);
  assert.equal(parsed.token[0].currentGeneration, true);
  assert.equal(parsed.token[1].currentGeneration, false);
});

test('official Kimi markdown adapter parses the latest K3 cache-hit, cache-miss, and output prices', () => {
  const source = definition('kimi-pricing');
  const adapter = createOfficialPricingAdapter(source);
  const parsed = adapter.parsePricing({
    ...document(readFixture('kimi-k3-pricing.md'), source.entryUrl),
    contentType: 'text/markdown',
  });

  assert.equal(parsed.token.length, 1);
  assert.deepEqual({
    model: parsed.token[0].model,
    currency: parsed.token[0].currency,
    input: parsed.token[0].inputPrice,
    cache: parsed.token[0].cacheReadPrice,
    output: parsed.token[0].outputPrice,
    current: parsed.token[0].currentGeneration,
  }, { model: 'Kimi K3', currency: 'USD', input: 3, cache: 0.3, output: 15, current: true });
});

test('video and Coding Plan adapters preserve non-comparable units and inquiry-only rows', () => {
  const videoSource = definition('seedance-pricing');
  const videoAdapter = createOfficialPricingAdapter(videoSource);
  const video = videoAdapter.parsePricing(document(readFixture('video-coding-pricing.html'), videoSource.entryUrl)).video;
  assert.equal(video[0].priceUnit, 'per_million_tokens');
  assert.equal(video[0].comparableUsdPerSecond, null);

  const codingSource = definition('minimax-coding-plan');
  const codingAdapter = createOfficialPricingAdapter(codingSource);
  const plans = codingAdapter.parsePricing(document(readFixture('video-coding-pricing.html'), codingSource.entryUrl)).codingPlans;
  assert.equal(plans[0].monthlyPrice, 29);
  assert.equal(plans[0].annualMonthlyPrice, 290 / 12);
  assert.equal(plans[1].pricingMode, 'inquiry');
});

test('pricing adapters reject unregistered or mismatched source URLs', () => {
  assert.throws(() => createOfficialPricingAdapter({
    ...definition('openai-pricing'), id: 'unknown-pricing', entryUrl: 'https://example.test/pricing', allowedHosts: ['example.test'],
  }), /registered official pricing source/i);
});

test('collector isolates failed official pages, keeps history, and emits current rows plus source reports', async () => {
  const sources = [definition('openai-pricing'), definition('minimax-pricing')];
  const documents = new Map([
    [sources[0].entryUrl, readFixture('openai-pricing.html')],
  ]);
  const collector = createAiPricingCollector({
    registry: sources,
    documentClient: {
      async fetchDocument(source) {
        if (!documents.has(source.entryUrl)) throw new Error('temporary official page failure');
        return document(documents.get(source.entryUrl), source.entryUrl);
      },
    },
  });

  const result = await collector({
    previous: { modelPricing: { token: [], tokenHistory: [], video: [], codingPlans: [] } },
    generatedAt: '2026-08-23T01:02:03.000Z',
  });

  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.stale, true);
  assert.match(result.source.message, /1\/2/);
  assert.equal(result.payload.modelPricing.token.some((row) => row.model === 'GPT 5.6 Sol'), true);
  assert.equal(result.payload.modelPricing.token.some((row) => row.model === 'GPT 5.5'), false);
  assert.equal(result.payload.modelPricing.tokenHistory.some((row) => row.model === 'GPT 5.5'), true);
  assert.equal(result.payload.modelPricing.sourceReports.find((row) => row.sourceId === 'minimax-pricing').status, 'error');
});

test('collector retains verified ledger coverage notes when an accessible official page yields no rows', async () => {
  const source = definition('zhipu-models');
  const collector = createAiPricingCollector({
    registry: [source],
    documentClient: {
      async fetchDocument() {
        return document('<main><h1>GLM-5.2</h1><p>模型总览</p></main>', source.entryUrl);
      },
    },
  });
  const result = await collector({
    previous: {
      modelPricing: {
        sourceReports: [{
          sourceId: 'zhipu-models', status: 'unavailable', rows: 0,
          message: 'GLM-5.2 最新代已确认；官网未公开可复核 Token 单价。',
        }],
      },
    },
    generatedAt: '2026-08-23T01:02:03.000Z',
  });

  const report = result.payload.modelPricing.sourceReports[0];
  assert.equal(report.status, 'ready');
  assert.equal(report.rows, 0);
  assert.match(report.message, /未公开可复核/);
});
