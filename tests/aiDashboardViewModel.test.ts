import assert from 'node:assert/strict';
import test from 'node:test';
import * as dashboardViewModel from '../src/pages/AIDashboard/viewModel.ts';
import {
  formatTokenCount,
  formatUsd,
  sourceStatusLabel,
} from '../src/pages/AIDashboard/viewModel.ts';

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

test('source status labels distinguish ready, stale errors, and missing authorization', () => {
  assert.equal(sourceStatusLabel({ status: 'ready', stale: false }), '已同步');
  assert.equal(sourceStatusLabel({ status: 'error', stale: true }), '使用上一版');
  assert.equal(sourceStatusLabel({ status: 'authorization_required', stale: true }), '待授权');
});

test('public dashboard mode hides the separate session controls', () => {
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(true), false);
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(false), true);
});

test('cache hit range never renders missing values as null percentages', () => {
  assert.equal(dashboardViewModel.formatCacheHitRange?.(null, null, false), '待补录');
  assert.equal(dashboardViewModel.formatCacheHitRange?.(20, 80, true), '20%–80%');
});
