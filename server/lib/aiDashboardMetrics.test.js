import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateOpenRouterWeekly,
  attachValuationMultiples,
  buildArrMetrics,
  selectLatestBenchmarkModels,
  validateCacheHitRange,
} from './aiDashboardMetrics.js';

test('ARR uses the last monthly actual, excludes forecasts, and reports absolute movement plus three-month slope', () => {
  const metrics = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-05-01', value: 470, kind: 'actual', sourceLabel: 'Yipit' },
    { company: 'Anthropic', observedAt: '2026-05-26', value: 500, kind: 'actual', sourceLabel: 'Yipit' },
    { company: 'Anthropic', observedAt: '2026-05-26', value: 700, kind: 'forecast', sourceLabel: 'Yipit' },
    { company: 'Anthropic', observedAt: '2026-06-12', value: 650, kind: 'actual', sourceLabel: 'Yipit' },
    { company: 'Anthropic', observedAt: '2026-07-15', value: 730, kind: 'actual', sourceLabel: 'Yipit' },
  ], { now: new Date('2026-08-01T00:00:00.000Z') });

  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0].actualPoints.map(({ month, value, momAbsolute }) => ({ month, value, momAbsolute })), [
    { month: '2026-05', value: 500, momAbsolute: null },
    { month: '2026-06', value: 650, momAbsolute: 150 },
    { month: '2026-07', value: 730, momAbsolute: 80 },
  ]);
  assert.deepEqual(metrics[0].forecastPoints.map(({ month, value }) => ({ month, value })), [
    { month: '2026-05', value: 700 },
  ]);
  assert.equal(metrics[0].slope3m, 115);
  assert.equal(metrics[0].stale, false);
});

test('ARR marks Yipit stale after 18 days without an actual observation', () => {
  const [metric] = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-07-15', value: 730, kind: 'actual', sourceLabel: 'Yipit' },
  ], { now: new Date('2026-08-20T00:00:00.000Z') });

  assert.equal(metric.stale, true);
});

test('valuation uses the most recent prior actual ARR and returns a P/ARR range', () => {
  const arr = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-05-26', value: 500, kind: 'actual', sourceLabel: 'Yipit' },
    { company: 'Anthropic', observedAt: '2026-06-12', value: 650, kind: 'actual', sourceLabel: 'Yipit' },
  ]);

  const [valuation, tooEarly] = attachValuationMultiples([
    { company: 'Anthropic', asOf: '2026-06-30', valuationLow: 3800, valuationHigh: 4000 },
    { company: 'Anthropic', asOf: '2026-04-30', valuationLow: 3000, valuationHigh: 3000 },
  ], arr);

  assert.equal(valuation.arrAsOf, '2026-06-12');
  assert.equal(valuation.arrValue, 650);
  assert.equal(valuation.parrLow, 3800 / 650);
  assert.equal(valuation.parrHigh, 4000 / 650);
  assert.equal(tooEarly.arrValue, null);
  assert.equal(tooEarly.parrLow, null);
});

test('OpenRouter aggregates seven complete UTC days with 64-bit-safe totals and keeps other in the platform total', () => {
  const rows = [
    { date: '2026-08-12', model_permaslug: 'vendor/ignored', total_tokens: '999999' },
    { date: '2026-08-13', model_permaslug: 'vendor/a', total_tokens: '9007199254740993' },
    { date: '2026-08-13', model_permaslug: 'other', total_tokens: '7' },
    { date: '2026-08-14', model_permaslug: 'vendor/b', total_tokens: '20' },
    { date: '2026-08-19', model_permaslug: 'vendor/a', total_tokens: '10' },
  ];

  const result = aggregateOpenRouterWeekly(rows, { endDate: '2026-08-19', weeks: 2 });

  assert.equal(result.weekTotalTokens, '9007199254741030');
  assert.deepEqual(result.topModels, [
    { model: 'vendor/a', totalTokens: '9007199254741003', rank: 1 },
    { model: 'vendor/b', totalTokens: '20', rank: 2 },
  ]);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[1].endDate, '2026-08-19');
});

test('benchmark keeps each vendor latest model and excludes Fable or Mythos from winners', () => {
  const result = selectLatestBenchmarkModels([
    { vendor: 'OpenAI', model: 'GPT-5.5', releasedAt: '2026-04-01', scores: { coding: { value: 80, direction: 'higher' } } },
    { vendor: 'OpenAI', model: 'GPT-5.6', releasedAt: '2026-07-01', scores: { coding: { value: 90, direction: 'higher' }, cost: { value: 2, direction: 'lower' } } },
    { vendor: 'Anthropic', model: 'Opus 5', releasedAt: '2026-07-02', scores: { coding: { value: 90, direction: 'higher' }, cost: { value: 1, direction: 'lower' } } },
    { vendor: 'Fable', model: 'Mythos Preview', releasedAt: '2026-08-01', scores: { coding: { value: 99, direction: 'higher' }, cost: { value: 0.1, direction: 'lower' } } },
  ]);

  assert.deepEqual(result.models.map((model) => model.model), ['Opus 5', 'Mythos Preview', 'GPT-5.6']);
  assert.deepEqual(result.winners.coding, ['Opus 5', 'GPT-5.6']);
  assert.deepEqual(result.winners.cost, ['Opus 5']);
});

test('cache hit range accepts only ordered percentages between zero and one hundred', () => {
  assert.equal(validateCacheHitRange(20, 75), true);
  assert.equal(validateCacheHitRange(75, 20), false);
  assert.equal(validateCacheHitRange(-1, 20), false);
  assert.equal(validateCacheHitRange(20, 101), false);
});
