import assert from 'node:assert/strict';
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
});
