import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { enrichComputeQuotes, normalizeComputeQuote } from './aiComputeData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ai-compute/quotes.json'), 'utf8'));
const source = {
  sourceLabel: 'Official compute fixture', sourceUrl: 'https://example.test/compute', sourceKind: 'official',
  retrievedAt: '2026-08-23T00:00:00.000Z',
};

test('compute normalization derives per-GPU price but preserves full instance identity', () => {
  const quote = normalizeComputeQuote({ ...fixture[0], ...source });
  assert.equal(quote.pricePerGpuHour, 12.29);
  assert.equal(quote.instanceHourlyPrice, 98.32);
  assert.equal(quote.quoteKey, 'aws|h100 80gb|p5.48xlarge / 8 gpu|us-east-1|on_demand|usd');
});

test('compute changes compare only exact platform/GPU/instance/region/billing/currency keys', () => {
  const quotes = fixture.map((row) => normalizeComputeQuote({ ...row, ...source }));
  const enriched = enrichComputeQuotes(quotes);
  const latestEastOnDemand = enriched.find((row) => row.platform === 'AWS' && row.region === 'us-east-1' && row.billingMode === 'on_demand' && row.latest);
  const spot = enriched.find((row) => row.billingMode === 'spot');
  const west = enriched.find((row) => row.region === 'us-west-2');

  assert.equal(latestEastOnDemand.previousPricePerGpuHour, 12.29);
  assert.ok(Math.abs(latestEastOnDemand.absoluteChange + 0.39) < 1e-9);
  assert.ok(Math.abs(latestEastOnDemand.percentChange - (-0.39 / 12.29)) < 1e-12);
  assert.equal(spot.previousPricePerGpuHour, null);
  assert.equal(west.previousPricePerGpuHour, null);
});

test('compute enrichment calculates positive changes and marks only one latest quote per exact key', () => {
  const base = { ...fixture[0], ...source, instanceHourlyPrice: 80, asOf: '2026-06-01' };
  const later = { ...fixture[0], ...source, instanceHourlyPrice: 88, asOf: '2026-07-01' };
  const enriched = enrichComputeQuotes([normalizeComputeQuote(base), normalizeComputeQuote(later)]);
  assert.equal(enriched.filter((row) => row.latest).length, 1);
  assert.equal(enriched.find((row) => row.latest).percentChange, 0.1);
});
