import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeCdsDataset } from './aiCdsData.js';

test('normalizes CDS cards and keeps chart history in chronological order', () => {
  const normalized = normalizeCdsDataset({
    asOf: '2026-08-19',
    sourceLabel: 'ICE ICC（用户截图）',
    sourceUrl: null,
    historyEstimated: true,
    companies: [{
      company: 'Oracle',
      latestBp: 207,
      changes: { oneDayBp: 2, sevenDayBp: 14, oneMonthBp: 6 },
      history: [
        { date: '2026-08-19', valueBp: 207 },
        { date: '2026-08-18', valueBp: 205 },
        { date: '2026-08-18', valueBp: 204 },
      ],
    }],
  });

  assert.equal(normalized.asOf, '2026-08-19');
  assert.equal(normalized.historyEstimated, true);
  assert.deepEqual(normalized.companies[0], {
    company: 'Oracle',
    latestBp: 207,
    changes: { oneDayBp: 2, sevenDayBp: 14, oneMonthBp: 6 },
    history: [
      { date: '2026-08-18', valueBp: 204 },
      { date: '2026-08-19', valueBp: 207 },
    ],
  });
});

test('drops invalid CDS rows instead of turning missing values into zero', () => {
  const normalized = normalizeCdsDataset({
    asOf: '2026-08-19',
    sourceLabel: 'Source',
    companies: [
      { company: 'Valid', latestBp: 45, changes: { oneDayBp: 0, sevenDayBp: 3, oneMonthBp: -2 }, history: [] },
      { company: 'Missing latest', latestBp: null, changes: {}, history: [] },
      { company: 'Whitespace latest', latestBp: '   ', changes: {}, history: [] },
      { company: 'Boolean latest', latestBp: false, changes: {}, history: [] },
      { company: 'Array latest', latestBp: [], changes: {}, history: [] },
      { company: 'Negative', latestBp: -1, changes: {}, history: [] },
      { company: '', latestBp: 50, changes: {}, history: [] },
    ],
  });

  assert.deepEqual(normalized.companies.map((row) => row.company), ['Valid']);
  assert.deepEqual(normalized.companies[0].changes, { oneDayBp: 0, sevenDayBp: 3, oneMonthBp: -2 });
});

test('rejects a malformed CDS dataset envelope', () => {
  assert.throws(() => normalizeCdsDataset(null), /CDS dataset/);
  assert.throws(() => normalizeCdsDataset({ companies: [] }), /asOf/);
  assert.throws(() => normalizeCdsDataset({ asOf: '2026-99-99', companies: [] }), /asOf/);
  assert.throws(() => normalizeCdsDataset({ asOf: '2026-02-30', companies: [] }), /asOf/);
});

test('canonical screenshot dataset locks all seven latest values and deltas', () => {
  const dataset = JSON.parse(fs.readFileSync(new URL('../data/ai-dashboard/cds-5y.json', import.meta.url), 'utf8'));
  const normalized = normalizeCdsDataset(dataset);

  assert.equal(normalized.historyEstimated, true);
  assert.deepEqual(normalized.companies.map(({ company, latestBp, changes }) => ({ company, latestBp, changes })), [
    { company: 'Oracle', latestBp: 207, changes: { oneDayBp: 2, sevenDayBp: 14, oneMonthBp: 6 } },
    { company: 'CoreWeave', latestBp: 765, changes: { oneDayBp: 7, sevenDayBp: 91, oneMonthBp: 72 } },
    { company: 'NVIDIA', latestBp: 83, changes: { oneDayBp: 0, sevenDayBp: 11, oneMonthBp: 25 } },
    { company: 'Amazon', latestBp: 59, changes: { oneDayBp: 1, sevenDayBp: 4, oneMonthBp: 1 } },
    { company: 'Google', latestBp: 56, changes: { oneDayBp: 0, sevenDayBp: 4, oneMonthBp: -2 } },
    { company: 'Microsoft', latestBp: 45, changes: { oneDayBp: 0, sevenDayBp: 3, oneMonthBp: -2 } },
    { company: 'Meta', latestBp: 91, changes: { oneDayBp: 1, sevenDayBp: 8, oneMonthBp: 14 } },
  ]);
});
