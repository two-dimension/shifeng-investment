import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';
import { buildIceCdsWorkbook, readIceCdsWorkbook } from './iceCdsWorkbook.js';
import { applyScreenshotBackfill } from './iceCdsScreenshotBackfill.js';
import {
  calculateCdsChanges,
  createIceCdsPipeline,
} from './iceCdsPipeline.js';

const curve = {
  curveId: 'usd-sofr-2026-08-24-test',
  asOf: '2026-08-24',
  currency: 'USD',
  sourceLabel: 'USD SOFR zero curve',
  sourceUrl: 'https://example.test/curve',
  nodes: [
    { years: 0.25, zeroRate: 0.041 },
    { years: 1, zeroRate: 0.039 },
    { years: 3, zeroRate: 0.037 },
    { years: 5, zeroRate: 0.036 },
    { years: 10, zeroRate: 0.038 },
  ],
};

const issuerInputs = [
  ['ORACLE CORP', 'ORCL', 100, 95.24],
  ['COREWEAVE INC', 'CRWV', 500, 88.125],
  ['NVIDIA CORP', 'NVDA', 100, 100.42],
  ['AMAZON.COM INC', 'AMZN', 100, 100.2],
  ['ALPHABET INC', 'GOOGL', 100, 100.25],
  ['MICROSOFT CORP', 'MSFT', 100, 100.3],
  ['META PLATFORMS INC', 'META', 100, 99.7],
];

function iceText(date = '2026-08-24', overrides = {}) {
  const lines = ['Clearing Date\tName\tInstrument Name\tEOD Price'];
  for (const [name, symbol, couponBp, defaultPrice] of issuerInputs) {
    const price = overrides[symbol] ?? defaultPrice;
    lines.push(`${date}\t${name}\t${symbol}.SNRFOR.USD.XR14.${couponBp}.2031-06-20\t${price}`);
  }
  return lines.join('\n');
}

async function tempPipeline(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ice-cds-pipeline-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'ice-cds');
  const snapshotFile = path.join(root, 'snapshot.json');
  return {
    root,
    dataDir,
    snapshotFile,
    pipeline: createIceCdsPipeline({ dataDir, snapshotFile, now: () => new Date('2026-08-25T01:00:00.000Z'), ...options }),
  };
}

test('preview derives all seven contracts without filesystem writes and labels unbenchmarked rows model-derived', async (t) => {
  const { dataDir, pipeline } = await tempPipeline(t);

  const preview = await pipeline.preview({ iceText: iceText(), discountCurve: curve });

  assert.equal(fs.existsSync(dataDir), false);
  assert.deepEqual(preview.rows.map((row) => row.company), ICE_CDS_CONTRACT_REGISTRY.map((row) => row.company));
  assert.equal(preview.rows.every((row) => row.qualityStatus === 'model-derived'), true);
  assert.equal(preview.rows.every((row) => Number.isFinite(row.spreadBp) && row.priceResidual <= 0.005), true);
  assert.equal(preview.publishedRows.length, 7);
  assert.equal(preview.blocking, false);
  assert.match(preview.warnings.join(' '), /model-derived/i);
});

test('official benchmark promotes only rows inside every 1% and price threshold', async (t) => {
  const { pipeline } = await tempPipeline(t);
  const base = await pipeline.preview({ iceText: iceText(), discountCurve: curve });
  const officialSpreads = Object.fromEntries(base.rows.map((row) => [row.company, row.spreadBp]));
  officialSpreads.Oracle = base.rows.find((row) => row.company === 'Oracle').spreadBp * 1.02;

  const preview = await pipeline.preview({ iceText: iceText(), discountCurve: curve, officialSpreads });
  const oracle = preview.rows.find((row) => row.company === 'Oracle');

  assert.equal(oracle.qualityStatus, 'needs-review');
  assert.equal(oracle.publishable, false);
  assert.equal(preview.rows.filter((row) => row.qualityStatus === 'validated').length, 6);
  assert.equal(preview.publishedRows.length, 6);
  assert.equal(preview.blocking, true);
});

test('change periods use valid clearing-day anchors and return signed absolute bp changes', () => {
  const history = [
    { date: '2026-07-24', valueBp: 180 },
    { date: '2026-08-14', valueBp: 190 },
    { date: '2026-08-17', valueBp: 195 },
    { date: '2026-08-21', valueBp: 200 },
    { date: '2026-08-24', valueBp: 207 },
  ];

  assert.deepEqual(calculateCdsChanges(history, '2026-08-24'), {
    oneDayBp: 7,
    sevenDayBp: 12,
    oneMonthBp: 27,
  });
  assert.deepEqual(calculateCdsChanges(history.slice(2), '2026-08-24'), {
    oneDayBp: 7,
    sevenDayBp: 12,
    oneMonthBp: null,
  });
});

test('import is idempotent, records corrections, and commits matching Excel/JSON batches', async (t) => {
  const { dataDir, snapshotFile, pipeline } = await tempPipeline(t);
  const input = { iceText: iceText(), discountCurve: curve };

  const first = await pipeline.import(input);
  const repeated = await pipeline.import(input);
  const corrected = await pipeline.import({ ...input, iceText: iceText('2026-08-24', { ORCL: 95.1 }) });
  const workbookState = await readIceCdsWorkbook(await fs.promises.readFile(path.join(dataDir, 'ice-cds-history.xlsx')));
  const snapshot = JSON.parse(await fs.promises.readFile(snapshotFile, 'utf8'));

  assert.equal(first.batchId, repeated.batchId);
  assert.equal(workbookState.derivedRows.length, 7);
  assert.equal(workbookState.rawRows.length, 7);
  assert.equal(workbookState.validationLog.some((row) => row.code === 'corrected-row'), true);
  assert.equal(workbookState.batchId, corrected.batchId);
  assert.equal(snapshot.creditRisk.cds5y.batchId, corrected.batchId);
  assert.equal(snapshot.sources.creditRisk.status, 'ready');
  assert.equal(snapshot.creditRisk.cds5y.companies.length, 7);
});

test('a live import keeps screenshot history and makes the live observation the latest point', async (t) => {
  const { dataDir, snapshotFile, pipeline } = await tempPipeline(t);
  const initialState = applyScreenshotBackfill({
    schemaVersion: 1,
    batchId: 'ice-empty-v1',
    generatedAt: '2026-08-24T00:00:00.000Z',
    rawRows: [],
    derivedRows: [],
    curves: [],
    registry: ICE_CDS_CONTRACT_REGISTRY,
    validationLog: [],
    methodology: {
      modelVersion: 'ice-isda-compatible-v1',
      priceTolerance: 0.005,
      relativeBenchmarkTolerance: 0.01,
      note: 'Model-derived.',
    },
  });
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(path.join(dataDir, 'ice-cds-history.xlsx'), await buildIceCdsWorkbook(initialState));

  await pipeline.import({ iceText: iceText(), discountCurve: curve });
  const snapshot = JSON.parse(await fs.promises.readFile(snapshotFile, 'utf8'));
  const oracle = snapshot.creditRisk.cds5y.companies.find((row) => row.company === 'Oracle');

  assert.equal(oracle.history[0].sourceKind, 'screenshot_backfill');
  assert.equal(oracle.history.at(-1).date, '2026-08-24');
  assert.equal(oracle.history.at(-1).eodPrice, 95.24);
  assert.equal(oracle.history.length > 40, true);
});

test('a second-file rename failure restores both last-good files', async (t) => {
  const baseline = await tempPipeline(t);
  await baseline.pipeline.import({ iceText: iceText(), discountCurve: curve });
  const workbookFile = path.join(baseline.dataDir, 'ice-cds-history.xlsx');
  const beforeWorkbook = await fs.promises.readFile(workbookFile);
  const beforeSnapshot = await fs.promises.readFile(baseline.snapshotFile);
  let failed = false;
  const fsImpl = {
    ...fs.promises,
    async rename(from, to) {
      if (!failed && String(from).includes('snapshot.') && String(from).includes('.tmp.json') && to === baseline.snapshotFile) {
        failed = true;
        throw new Error('injected snapshot rename failure');
      }
      return fs.promises.rename(from, to);
    },
  };
  const failing = createIceCdsPipeline({
    dataDir: baseline.dataDir,
    snapshotFile: baseline.snapshotFile,
    now: () => new Date('2026-08-26T01:00:00.000Z'),
    fsImpl,
  });

  await assert.rejects(
    () => failing.import({ iceText: iceText('2026-08-25'), discountCurve: { ...curve, asOf: '2026-08-25', curveId: 'usd-sofr-2026-08-25-test' } }),
    /injected snapshot rename failure/,
  );
  assert.deepEqual(await fs.promises.readFile(workbookFile), beforeWorkbook);
  assert.deepEqual(await fs.promises.readFile(baseline.snapshotFile), beforeSnapshot);
});

test('backup rotation keeps the newest 30 batch pairs and archives older pairs', async (t) => {
  const { dataDir, pipeline } = await tempPipeline(t);
  const backups = path.join(dataDir, 'backups');
  await fs.promises.mkdir(backups, { recursive: true });
  for (let index = 0; index < 31; index += 1) {
    const id = `old-${String(index).padStart(2, '0')}`;
    await fs.promises.writeFile(path.join(backups, `${id}.xlsx`), id);
    await fs.promises.writeFile(path.join(backups, `${id}.json`), id);
    const date = new Date(Date.UTC(2026, 0, index + 1));
    await fs.promises.utimes(path.join(backups, `${id}.xlsx`), date, date);
    await fs.promises.utimes(path.join(backups, `${id}.json`), date, date);
  }

  await pipeline.import({ iceText: iceText(), discountCurve: curve });
  const currentFiles = await fs.promises.readdir(backups);
  const archivedFiles = await fs.promises.readdir(path.join(dataDir, 'archive'));

  assert.equal(currentFiles.filter((name) => name.endsWith('.xlsx')).length, 30);
  assert.equal(currentFiles.filter((name) => name.endsWith('.json')).length, 30);
  assert.equal(archivedFiles.filter((name) => name.endsWith('.xlsx')).length, 2);
  assert.equal(archivedFiles.filter((name) => name.endsWith('.json')).length, 2);
});
