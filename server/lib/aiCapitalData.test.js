import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCapitalMetrics, normalizeCapitalEvent } from './aiCapitalData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ai-capital/events.json'), 'utf8'));
const source = {
  sourceLabel: 'Official capital fixture', sourceUrl: 'https://example.test/capital', sourceKind: 'official',
  asOf: '2026-08-23', retrievedAt: '2026-08-23T00:00:00.000Z',
};

test('capital normalization preserves instruments, currencies, rates, and unknown fields without inference', () => {
  const events = fixture.map((row) => normalizeCapitalEvent({ ...row, ...source }));
  const fixed = events.find((row) => row.entity === 'Anthropic');
  const floating = events.find((row) => row.rateType === 'floating');
  const cny = events.find((row) => row.currency === 'CNY');
  const unknown = events.find((row) => row.entity === 'xAI');
  const equity = events.find((row) => row.entity === 'OpenAI');

  assert.equal(fixed.amountOriginal, 2_000_000_000);
  assert.equal(fixed.couponPercent, 5.5);
  assert.equal(floating.benchmark, 'SOFR');
  assert.equal(floating.spreadBps, 450);
  assert.equal(cny.amountOriginal, 5_000_000_000);
  assert.equal(cny.comparableUsdAmount, 690_000_000);
  assert.equal(unknown.couponPercent, null);
  assert.equal(equity.couponPercent, null);
  assert.equal(equity.rateType, 'not_applicable');
});

test('capital metrics compute TTM cadence and debt-only comparable weighted fixed coupon', () => {
  const events = fixture.map((row) => normalizeCapitalEvent({ ...row, ...source }));
  const metrics = buildCapitalMetrics(events, { now: new Date('2026-08-23T00:00:00.000Z') });
  const coreweave = metrics.byEntity.find((row) => row.entity === 'CoreWeave');

  assert.equal(metrics.industry.eventCount, 6);
  assert.equal(metrics.industry.trailing12MonthCount, 6);
  assert.equal(coreweave.trailing12MonthCount, 2);
  assert.equal(coreweave.averageDaysBetweenEvents, 115);
  assert.equal(metrics.industry.fixedCouponEventCount, 2);
  assert.equal(metrics.industry.weightedAverageFixedCoupon, (2_000 * 5.5 + 2_000 * 3) / 4_000);
  assert.equal(metrics.industry.cumulativeComparableUsd, 120_690_000_000);
});

test('weighted coupon excludes equity, floating debt, unknown rates, and non-comparable currencies', () => {
  const events = fixture.map((row) => normalizeCapitalEvent({ ...row, ...source }));
  const extra = normalizeCapitalEvent({
    entity: 'Example', geography: 'China', eventDate: '2026-04-01', instrumentCategory: 'debt',
    instrument: 'Bond', amount: 1000, amountUnit: 'million', currency: 'CNY', rateType: 'fixed', couponPercent: 9,
    comparableUsdAmount: null, ...source,
  });
  const metrics = buildCapitalMetrics([...events, extra], { now: new Date('2026-08-23T00:00:00.000Z') });
  assert.equal(metrics.industry.fixedCouponEventCount, 2);
});
