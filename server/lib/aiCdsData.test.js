import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCdsDataset } from './aiCdsData.js';

test('normalizes ICE-derived CDS cards with auditable EOD prices and quality state', () => {
  const normalized = normalizeCdsDataset({
    asOf: '2026-08-24',
    sourceKind: 'ice_eod_isda',
    sourceLabel: 'ICE EOD Price · ISDA 换算值',
    sourceUrl: 'https://www.ice.com/cds-settlement-prices/icc/single-name-instruments',
    batchId: 'ice-20260824-a1',
    qualityStatus: 'model-derived',
    workbookAvailable: true,
    historyEstimated: true,
    companies: [{
      company: 'Oracle',
      latestBp: 207.4,
      latestEodPrice: 95.24,
      latestInstrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20',
      qualityStatus: 'model-derived',
      changes: { oneDayBp: 2.1, sevenDayBp: 14.2, oneMonthBp: 6.3 },
      history: [
        { date: '2026-08-24', valueBp: 207.4, eodPrice: 95.24, instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
        { date: '2026-08-22', valueBp: 205.3, eodPrice: 95.33, instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
        { date: '2026-08-22', valueBp: 204.9, eodPrice: 95.34, instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
      ],
    }],
  });

  assert.equal(normalized.asOf, '2026-08-24');
  assert.equal(normalized.sourceKind, 'ice_eod_isda');
  assert.equal(normalized.batchId, 'ice-20260824-a1');
  assert.equal(normalized.qualityStatus, 'model-derived');
  assert.equal(normalized.workbookAvailable, true);
  assert.equal(normalized.historyEstimated, true);
  assert.deepEqual(normalized.companies[0], {
    company: 'Oracle',
    latestBp: 207.4,
    latestEodPrice: 95.24,
    latestInstrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20',
    qualityStatus: 'model-derived',
    changes: { oneDayBp: 2.1, sevenDayBp: 14.2, oneMonthBp: 6.3 },
    history: [
      { date: '2026-08-22', valueBp: 204.9, eodPrice: 95.34, instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
      { date: '2026-08-24', valueBp: 207.4, eodPrice: 95.24, instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
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
      { company: 'Bad price', latestBp: 50, latestEodPrice: 'bad', qualityStatus: 'model-derived', changes: {}, history: [] },
      { company: 'Bad status', latestBp: 50, latestEodPrice: 99, qualityStatus: 'official', changes: {}, history: [] },
      { company: '', latestBp: 50, changes: {}, history: [] },
    ],
  });

  assert.deepEqual(normalized.companies.map((row) => row.company), ['Valid']);
  assert.deepEqual(normalized.companies[0].changes, { oneDayBp: 0, sevenDayBp: 3, oneMonthBp: -2 });
});

test('keeps explicitly labeled screenshot history without fabricating EOD prices', () => {
  const normalized = normalizeCdsDataset({
    asOf: '2026-08-24',
    sourceKind: 'ice_eod_isda',
    sourceLabel: 'ICE EOD Price · ISDA 换算值',
    qualityStatus: 'model-derived',
    companies: [{
      company: 'Oracle',
      latestBp: 223.3,
      latestEodPrice: 95.0309,
      latestInstrumentName: 'ORCLE.SNRFOR.USD.XR14.100.2031-06-20',
      qualityStatus: 'model-derived',
      changes: {},
      history: [
        { date: '2026-08-21', valueBp: 214, sourceKind: 'screenshot_backfill', qualityStatus: 'stale' },
        { date: '2026-08-24', valueBp: 223.3, eodPrice: 95.0309, instrumentName: 'ORCLE.SNRFOR.USD.XR14.100.2031-06-20', qualityStatus: 'model-derived' },
      ],
    }],
  });

  assert.deepEqual(normalized.companies[0].history[0], {
    date: '2026-08-21',
    valueBp: 214,
    sourceKind: 'screenshot_backfill',
    qualityStatus: 'stale',
  });
});

test('rejects a malformed CDS dataset envelope', () => {
  assert.throws(() => normalizeCdsDataset(null), /CDS dataset/);
  assert.throws(() => normalizeCdsDataset({ companies: [] }), /asOf/);
  assert.throws(() => normalizeCdsDataset({ asOf: '2026-99-99', companies: [] }), /asOf/);
  assert.throws(() => normalizeCdsDataset({ asOf: '2026-02-30', companies: [] }), /asOf/);
});
