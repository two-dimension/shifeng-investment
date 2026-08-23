import assert from 'node:assert/strict';
import test from 'node:test';
import * as dashboardViewModel from '../src/pages/AIDashboard/viewModel.ts';
import {
  benchmarkRefreshRequest,
  formatBenchmarkValue,
  formatCurrencyPrice,
  formatPriceChange,
  formatTokenCount,
  formatUsd,
  sourceStatusLabel,
} from '../src/pages/AIDashboard/viewModel.ts';

test('only entering the Benchmark tab requests a scoped non-forced refresh', () => {
  assert.deepEqual(benchmarkRefreshRequest('benchmark'), { sources: ['benchmarks'], force: false });
  assert.equal(benchmarkRefreshRequest('pricing'), null);
});

test('benchmark formatter respects metric units and missing values', () => {
  assert.equal(formatBenchmarkValue({ value: 0.72 }, { unit: 'percent' }), '72.0%');
  assert.equal(formatBenchmarkValue({ value: 1200 }, { unit: 'elo' }), '1,200');
  assert.equal(formatBenchmarkValue({ value: 4 }, { unit: 'rank' }), '#4');
  assert.equal(formatBenchmarkValue({ value: 71.234 }, { unit: 'index' }), '71.2%');
  assert.equal(formatBenchmarkValue(null, { unit: 'index' }), '—');
});

test('token formatter keeps 64-bit values readable without converting through Number first', () => {
  assert.equal(formatTokenCount('1250000000000'), '1.25T');
  assert.equal(formatTokenCount('9007199254740993'), '9.01P');
  assert.equal(formatTokenCount('0'), '0');
});

test('USD formatter preserves zero and distinguishes unavailable values', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(2.5), '$2.50');
  assert.equal(formatUsd(null), '—');
});

test('pricing formatter preserves CNY/USD currency and renders official same-SKU changes', () => {
  assert.equal(formatCurrencyPrice(29, 'CNY'), '¥29.00');
  assert.equal(formatCurrencyPrice(2.5, 'USD'), '$2.50');
  assert.equal(formatCurrencyPrice(null, 'CNY'), '—');
  assert.equal(formatPriceChange({ oldPrice: 10, newPrice: 8, percentDelta: -0.2, currency: 'CNY' }), '¥10.00 → ¥8.00（-20.0%）');
});

test('ARR and Token delta formatters preserve sign, unit, percent, zero, and unavailable values', () => {
  assert.equal(dashboardViewModel.formatArrDelta?.(30, 0.5), '+30 亿美元（+50.0%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(-5, -0.125), '-5 亿美元（-12.5%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(0, 0), '0 亿美元（0.0%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(null, null), '—');

  assert.equal(dashboardViewModel.formatTokenDelta?.('1250000000000', 0.25), '+1.25T Tokens（+25.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.('-500000000', -0.1), '-500M Tokens（-10.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.('0', 0), '0 Tokens（0.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.(null, null), '—');
});

test('source status labels distinguish ready, stale errors, and missing authorization', () => {
  assert.equal(sourceStatusLabel({ status: 'ready', stale: false }), '已同步');
  assert.equal(sourceStatusLabel({ status: 'error', stale: true }), '使用上一版');
  assert.equal(sourceStatusLabel({ status: 'authorization_required', stale: true }), '待授权');
});

test('dashboard source entries map all seven public slices without exposing Feishu', () => {
  const ready = { status: 'ready' as const, stale: false, asOf: '2026-08-22' };
  const sources = {
    growth: ready,
    openRouter: ready,
    pricing: ready,
    capital: ready,
    benchmarks: ready,
    artificialAnalysis: ready,
    compute: ready,
  };

  assert.deepEqual(dashboardViewModel.dashboardSourceEntries?.(sources).map(({ key, label }) => [key, label]), [
    ['growth', '增长与估值'],
    ['openRouter', 'OpenRouter 流量'],
    ['pricing', '模型与套餐价格'],
    ['capital', '融资与债务'],
    ['benchmarks', '厂商官网模型卡'],
    ['artificialAnalysis', 'AA Index'],
    ['compute', '算力租赁'],
  ]);
  assert.equal('feishu' in sources, false);
});

test('public dashboard mode hides the separate session controls', () => {
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(true), false);
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(false), true);
});

test('cache hit range never renders missing values as null percentages', () => {
  assert.equal(dashboardViewModel.formatCacheHitRange?.(null, null, false), '待补录');
  assert.equal(dashboardViewModel.formatCacheHitRange?.(20, 80, true), '20%–80%');
});

test('methodology tooltip keeps method, source, date, and commentary in investment-reading order', () => {
  assert.deepEqual(dashboardViewModel.methodologyTooltip?.({
    sourceLabel: 'Yipit',
    sourceUrl: 'https://example.test/yipit',
    sourceKind: 'estimate',
    asOf: '2026-08-01',
    retrievedAt: '2026-08-23T00:00:00Z',
    methodology: 'ARR estimate',
    commentary: 'Monthly observation',
    stale: false,
  }), [
    '数据口径：ARR estimate',
    '数据来源：Yipit',
    '数据日期：2026-08-01',
    '点评：Monthly observation',
  ]);
});
