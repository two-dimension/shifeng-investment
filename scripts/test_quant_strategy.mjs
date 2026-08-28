import assert from 'node:assert/strict';
import { indicatorChecks, quantTestInternals } from '../server/lib/quantStrategy.js';

const row = (hist, overrides = {}) => ({
  hist,
  dif: overrides.dif ?? hist,
  dea: overrides.dea ?? 0,
  close: overrides.close ?? 10,
  ma5: overrides.ma5 ?? 11,
  ma10: overrides.ma10 ?? 10,
  ma20: overrides.ma20 ?? 9,
  volume: overrides.volume ?? 100,
  volMa5: overrides.volMa5 ?? 80,
  volMa10: overrides.volMa10 ?? 90,
});

const redExpansionRows = [0.6, 0.4, 0.2, 0.3, 0.5, 0.7].map((hist) => row(hist));
assert.equal(indicatorChecks.redExpansion(redExpansionRows, 5), true, '3+3 red expansion should pass');
assert.equal(indicatorChecks.redExpansion([0.6, 0.4, -0.2, 0.3, 0.5, 0.7].map((hist) => row(hist)), 5), false, 'red expansion requires all positive hist');

const greenDecayRows = [0.2, -0.5, -0.4, -0.3, -0.2].map((hist) => row(hist));
assert.equal(indicatorChecks.greenDecay(greenDecayRows, 4), true, 'green decay should pass with red-to-green in lookback');
assert.equal(indicatorChecks.greenDecay([-0.6, -0.5, -0.4, -0.3, -0.2].map((hist) => row(hist)), 4), false, 'green decay requires red-to-green transition');

assert.equal(indicatorChecks.trendFilter(row(0.1, { close: 8, ma5: 11, ma10: 12, ma20: 10 }), { trendMode: '5/10/20' }), false, 'default trend requires close>20MA or 5MA>10MA');
assert.equal(indicatorChecks.trendFilter(row(0.1, { close: 8, ma5: 11, ma10: 12, ma20: 10 }), { trendMode: '5/20' }), true, '5/20 mode should use 5MA>20MA');
assert.equal(indicatorChecks.trendFilter(row(0.1, { close: 8, ma5: 9, ma10: 11, ma20: 10 }), { trendMode: '10/20' }), true, '10/20 mode should use 10MA>20MA');

const fixedRows = [
  row(0.1, { dif: 1, dea: 0.5 }),
  row(0.2, { dif: 0.9, dea: 0.4 }),
];
assert.equal(indicatorChecks.fixedFilter(fixedRows, 1), true, 'hist rising alone should satisfy fixed filter');

assert.equal(indicatorChecks.volumeFilter(row(0.1, { volume: 101, volMa5: 100 }), { volumeMa: 5 }), true, 'volume above 5-day average should pass');
assert.equal(indicatorChecks.volumeFilter(row(0.1, { volume: 99, volMa5: 100 }), { volumeMa: 5 }), false, 'volume below 5-day average should fail');

const weeklyCounts = new Map([['2026-01', 8]]);
const allWeeks = Array.from({ length: 13 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`);
assert.equal(quantTestInternals.calculateRolling13WeekMin(weeklyCounts, allWeeks) < 8, true, 'weeks without openings must count as zero');

console.log('quant strategy tests passed');
