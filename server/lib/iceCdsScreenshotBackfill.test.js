import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyScreenshotBackfill,
  generateScreenshotBackfillRows,
} from './iceCdsScreenshotBackfill.js';

test('digitizes the reference screenshot into seven weekday-only history series', () => {
  const rows = generateScreenshotBackfillRows();
  const companies = [...new Set(rows.map((row) => row.company))];

  assert.deepEqual(companies, ['Oracle', 'CoreWeave', 'NVIDIA', 'Amazon', 'Google', 'Microsoft', 'Meta']);
  assert.equal(rows.every((row) => ![0, 6].includes(new Date(`${row.clearingDate}T00:00:00Z`).getUTCDay())), true);
  assert.equal(rows.every((row) => row.clearingDate <= '2026-08-21'), true);
  assert.equal(rows.every((row) => row.modelVersion === 'screenshot-backfill-v1' && row.qualityStatus === 'stale'), true);
  assert.equal(rows.find((row) => row.company === 'Oracle' && row.clearingDate === '2026-06-10').spreadBp, 160);
  assert.equal(rows.find((row) => row.company === 'Meta' && row.clearingDate === '2026-08-21').spreadBp, 96);
});

test('backfill preserves live model rows and is idempotent', () => {
  const live = {
    clearingDate: '2026-08-24', company: 'Oracle', instrumentName: 'ORCLE.SNRFOR.USD.XR14.100.2031-06-20',
    modelVersion: 'ice-isda-compatible-v1', spreadBp: 223.3,
  };
  const initial = {
    schemaVersion: 1,
    batchId: 'ice-live',
    generatedAt: '2026-08-25T00:00:00.000Z',
    rawRows: [],
    derivedRows: [live],
    curves: [],
    registry: [],
    validationLog: [],
    methodology: { note: 'Live model.' },
  };

  const once = applyScreenshotBackfill(initial, { generatedAt: '2026-08-25T01:00:00.000Z' });
  const twice = applyScreenshotBackfill(once, { generatedAt: '2026-08-25T02:00:00.000Z' });

  assert.equal(twice.derivedRows.filter((row) => row === live).length, 1);
  assert.equal(twice.derivedRows.filter((row) => row.modelVersion === 'screenshot-backfill-v1').length,
    once.derivedRows.filter((row) => row.modelVersion === 'screenshot-backfill-v1').length);
  assert.equal(twice.validationLog.filter((row) => row.code === 'screenshot-history-backfill').length, 1);
});
