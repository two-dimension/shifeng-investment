import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateOpenRouterWeekly,
  attachValuationMultiples,
  buildArrComparison,
  buildArrMetrics,
  selectLatestBenchmarkModels,
  validateCacheHitRange,
} from './aiDashboardMetrics.js';

test('ARR reports observation-to-observation absolute and percent change without calling a skipped month monthly', () => {
  const metrics = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-05-26', value: 60, kind: 'actual', sourceLabel: 'Yipit', seriesKind: 'estimate' },
    { company: 'Anthropic', observedAt: '2026-07-15', value: 90, kind: 'actual', sourceLabel: 'Yipit', seriesKind: 'estimate' },
    { company: 'Anthropic', observedAt: '2026-07-31', value: 100, kind: 'actual', sourceLabel: 'Yipit', seriesKind: 'estimate' },
    { company: 'Anthropic', observedAt: '2026-08-31', value: 120, kind: 'forecast', sourceLabel: 'Yipit', seriesKind: 'estimate' },
  ], { now: new Date('2026-08-01T00:00:00.000Z') });

  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0].actualPoints.map(({
    month, value, momAbsolute, momPercent, comparisonLabel, consecutiveMonth,
  }) => ({ month, value, momAbsolute, momPercent, comparisonLabel, consecutiveMonth })), [
    {
      month: '2026-05', value: 60, momAbsolute: null, momPercent: null,
      comparisonLabel: null, consecutiveMonth: null,
    },
    {
      month: '2026-07', value: 100, momAbsolute: 40, momPercent: 2 / 3,
      comparisonLabel: '2026-05-26 → 2026-07-31', consecutiveMonth: false,
    },
  ]);
  assert.deepEqual(metrics[0].forecastPoints.map(({ month, value }) => ({ month, value })), [
    { month: '2026-08', value: 120 },
  ]);
  assert.equal('slope3m' in metrics[0], false);
  assert.equal(metrics[0].stale, false);
});

test('ARR marks Yipit stale after 18 days without an actual observation', () => {
  const [metric] = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-07-15', value: 730, kind: 'actual', sourceLabel: 'Yipit' },
  ], { now: new Date('2026-08-20T00:00:00.000Z') });

  assert.equal(metric.stale, true);
});

test('official and estimate ARR stay separate and P/ARR matches the requested prior series', () => {
  const arr = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-05-10', value: 470, kind: 'actual', sourceLabel: 'Anthropic', seriesKind: 'official', methodology: 'run-rate revenue', commentary: '公司官网披露的收入运行率。' },
    { company: 'Anthropic', observedAt: '2026-07-31', value: 730, kind: 'actual', sourceLabel: 'Yipit', seriesKind: 'estimate', methodology: 'Yipit estimate' },
    { company: 'OpenAI', observedAt: '2025-12-31', value: 200, kind: 'actual', sourceLabel: 'OpenAI', seriesKind: 'official', methodology: 'reported ARR' },
    { company: 'OpenAI', observedAt: '2026-03-31', value: 240, kind: 'actual', sourceLabel: 'OpenAI', seriesKind: 'official', methodology: 'monthly revenue annualized' },
  ]);

  const [anthropicOfficial, anthropicEstimate, openAi, tooEarly] = attachValuationMultiples([
    { company: 'Anthropic', asOf: '2026-08-15', valuationLow: 9650, valuationHigh: 9650, arrSeriesKind: 'official', commentary: '融资公告披露的投后估值。' },
    { company: 'Anthropic', asOf: '2026-08-15', valuationLow: 9650, valuationHigh: 9650, arrSeriesKind: 'estimate' },
    { company: 'OpenAI', asOf: '2026-08-15', valuationLow: 8520, valuationHigh: 8520, arrSeriesKind: 'official' },
    { company: 'OpenAI', asOf: '2023-04-30', valuationLow: 300, valuationHigh: 300, arrSeriesKind: 'official' },
  ], arr);

  assert.equal(anthropicOfficial.arrValue, 470);
  assert.equal(anthropicOfficial.arrSourceLabel, 'Anthropic');
  assert.equal(anthropicOfficial.note, '融资公告披露的投后估值。 公司官网披露的收入运行率。 P/ARR 使用估值日前最近一期 Anthropic 官方口径（2026-05-10）配对。');
  assert.equal(anthropicEstimate.arrValue, 730);
  assert.equal(anthropicEstimate.arrSourceLabel, 'Yipit');
  assert.equal(openAi.arrAsOf, '2026-03-31');
  assert.equal(openAi.arrValue, 240);
  assert.equal(openAi.parrLow, 8520 / 240);
  assert.equal(tooEarly.arrValue, null);
  assert.equal(tooEarly.parrLow, null);
});

test('combined ARR comparison aligns Anthropic and OpenAI while preserving source series', () => {
  const metrics = buildArrMetrics([
    { company: 'Anthropic', observedAt: '2026-05-10', value: 470, kind: 'actual', sourceLabel: 'Anthropic', seriesKind: 'official' },
    { company: 'Anthropic', observedAt: '2026-07-31', value: 730, kind: 'actual', sourceLabel: 'Yipit', seriesKind: 'estimate' },
    { company: 'OpenAI', observedAt: '2026-03-31', value: 240, kind: 'actual', sourceLabel: 'OpenAI', seriesKind: 'official' },
  ]);

  const comparison = buildArrComparison(metrics, ['Anthropic', 'OpenAI']);

  assert.deepEqual(comparison.months, ['2026-03', '2026-05', '2026-07']);
  assert.deepEqual(comparison.series.map(({ company, seriesKind, sourceLabel, points }) => ({
    company, seriesKind, sourceLabel, values: points.map((point) => point?.value ?? null),
  })), [
    { company: 'Anthropic', seriesKind: 'estimate', sourceLabel: 'Yipit', values: [null, null, 730] },
    { company: 'Anthropic', seriesKind: 'official', sourceLabel: 'Anthropic', values: [null, 470, null] },
    { company: 'OpenAI', seriesKind: 'official', sourceLabel: 'OpenAI', values: [240, null, null] },
  ]);
});

test('OpenRouter aggregates two complete UTC weeks and reports positive week-over-week Token change', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({
    date: `2026-08-${String(6 + index).padStart(2, '0')}`,
    model_permaslug: index === 13 ? 'other' : 'vendor/a',
    total_tokens: String(index < 7 ? 10 : 15),
  }));

  const result = aggregateOpenRouterWeekly(rows, { endDate: '2026-08-19', weeks: 2 });

  assert.equal(result.priorWeekTotalTokens, '70');
  assert.equal(result.weekTotalTokens, '105');
  assert.equal(result.weekOverWeekAbsolute, '35');
  assert.equal(result.weekOverWeekPercent, 0.5);
  assert.deepEqual(result.topModels, [{ model: 'vendor/a', totalTokens: '90', rank: 1 }]);
  assert.equal(result.history.length, 2);
  assert.deepEqual(result.history.map(({ totalTokens, weekOverWeekAbsolute }) => ({ totalTokens, weekOverWeekAbsolute })), [
    { totalTokens: '70', weekOverWeekAbsolute: null },
    { totalTokens: '105', weekOverWeekAbsolute: '35' },
  ]);
});

test('OpenRouter reports negative change and leaves percent blank when the prior week is zero', () => {
  const datedRows = (prior, latest) => Array.from({ length: 14 }, (_, index) => ({
    date: `2026-08-${String(6 + index).padStart(2, '0')}`,
    model_permaslug: 'vendor/a',
    total_tokens: String(index < 7 ? prior : latest),
  }));

  const down = aggregateOpenRouterWeekly(datedRows(20, 10), { endDate: '2026-08-19', weeks: 2 });
  const noBase = aggregateOpenRouterWeekly(datedRows(0, 10), { endDate: '2026-08-19', weeks: 2 });

  assert.equal(down.weekOverWeekAbsolute, '-70');
  assert.equal(down.weekOverWeekPercent, -0.5);
  assert.equal(noBase.weekOverWeekAbsolute, '70');
  assert.equal(noBase.weekOverWeekPercent, null);
});

test('benchmark keeps each vendor latest model and does not exclude Fable or Mythos from winners', () => {
  const result = selectLatestBenchmarkModels([
    { vendor: 'OpenAI', model: 'GPT-5.5', releasedAt: '2026-04-01', scores: { coding: { value: 80, direction: 'higher' } } },
    { vendor: 'OpenAI', model: 'GPT-5.6', releasedAt: '2026-07-01', scores: { coding: { value: 90, direction: 'higher' }, cost: { value: 2, direction: 'lower' } } },
    { vendor: 'Anthropic', model: 'Opus 5', releasedAt: '2026-07-02', scores: { coding: { value: 90, direction: 'higher' }, cost: { value: 1, direction: 'lower' } } },
    { vendor: 'Fable', model: 'Mythos Preview', releasedAt: '2026-08-01', scores: { coding: { value: 99, direction: 'higher' }, cost: { value: 0.1, direction: 'lower' } } },
  ]);

  assert.deepEqual(result.models.map((model) => model.model), ['Opus 5', 'Mythos Preview', 'GPT-5.6']);
  assert.deepEqual(result.winners.coding, ['Mythos Preview']);
  assert.deepEqual(result.winners.cost, ['Mythos Preview']);
});

test('cache hit range accepts only ordered percentages between zero and one hundred', () => {
  assert.equal(validateCacheHitRange(20, 75), true);
  assert.equal(validateCacheHitRange(75, 20), false);
  assert.equal(validateCacheHitRange(-1, 20), false);
  assert.equal(validateCacheHitRange(20, 101), false);
});
