import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';
import { buildIceCdsWorkbook, readIceCdsWorkbook } from './iceCdsWorkbook.js';

const SHEET_NAMES = [
  'Raw EOD Prices',
  'Derived 5Y Spreads',
  'Daily Dashboard',
  'Discount Curves',
  'Contract Registry',
  'Validation Log',
  'Methodology',
];

function sampleState() {
  const sourceUrl = 'https://www.ice.com/cds-settlement-prices/icc/single-name-instruments';
  const rawRows = [];
  const derivedRows = [];
  for (const [date, oraclePrice, oracleSpread, corePrice, coreSpread] of [
    ['2026-08-21', 95.31, 205.2, 88.4, 781.5],
    ['2026-08-24', 95.24, 207.4, 88.125, 800.1],
  ]) {
    for (const [company, symbol, couponBp, eodPrice, spreadBp] of [
      ['Oracle', 'ORCL', 100, oraclePrice, oracleSpread],
      ['CoreWeave', 'CRWV', 500, corePrice, coreSpread],
    ]) {
      const instrumentName = `${symbol}.SNRFOR.USD.XR14.${couponBp}.2031-06-20`;
      rawRows.push({
        batchId: `ice-${date.replaceAll('-', '')}`,
        clearingDate: date,
        company,
        name: company.toUpperCase(),
        instrumentName,
        eodPrice,
        sourceUrl,
        importedAt: `${date}T23:00:00.000Z`,
      });
      derivedRows.push({
        batchId: `ice-${date.replaceAll('-', '')}`,
        clearingDate: date,
        company,
        instrumentName,
        eodPrice,
        couponBp,
        maturityDate: '2031-06-20',
        spreadBp,
        roundTripPrice: eodPrice,
        priceResidual: 0.000001,
        hazardRate: spreadBp / 6000,
        curveId: 'usd-sofr-2026-08-24-test',
        recoveryRate: 0.4,
        modelVersion: 'ice-isda-compatible-v1',
        qualityStatus: 'model-derived',
        officialSpreadBp: null,
        relativeError: null,
        sourceUrl,
      });
    }
  }
  return {
    schemaVersion: 1,
    batchId: 'ice-20260824-final',
    generatedAt: '2026-08-25T01:00:00.000Z',
    rawRows,
    derivedRows,
    curves: [{
      curveId: 'usd-sofr-2026-08-24-test',
      asOf: '2026-08-24',
      currency: 'USD',
      sourceLabel: 'USD SOFR zero curve',
      sourceUrl: 'https://example.test/curve',
      nodes: [
        { years: 0.25, zeroRate: 0.041 },
        { years: 1, zeroRate: 0.039 },
        { years: 5, zeroRate: 0.036 },
      ],
    }],
    registry: ICE_CDS_CONTRACT_REGISTRY.slice(0, 2),
    validationLog: [{
      batchId: 'ice-20260824-final',
      createdAt: '2026-08-25T01:00:00.000Z',
      level: 'info',
      code: 'round-trip-ok',
      company: 'Oracle',
      message: 'Price residual within tolerance',
    }],
    methodology: {
      modelVersion: 'ice-isda-compatible-v1',
      priceTolerance: 0.005,
      relativeBenchmarkTolerance: 0.01,
      note: 'Model-derived unless an official spread benchmark passes validation.',
    },
  };
}

test('builds the exact seven-sheet audited workbook with typed fields and live formulas', async () => {
  const buffer = await buildIceCdsWorkbook(sampleState());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), SHEET_NAMES);
  const raw = workbook.getWorksheet('Raw EOD Prices');
  const dashboard = workbook.getWorksheet('Daily Dashboard');
  assert.ok(raw.getCell('B2').value instanceof Date);
  assert.equal(typeof raw.getCell('F2').value, 'number');
  assert.equal(raw.getCell('G2').value.hyperlink, sampleState().rawRows[0].sourceUrl);
  assert.deepEqual(raw.views[0].state, 'frozen');
  assert.equal(raw.views[0].ySplit, 1);
  assert.ok(raw.autoFilter);

  const oneDayChange = dashboard.getCell('D4').value;
  assert.equal(typeof oneDayChange.formula, 'string');
  assert.equal(typeof oneDayChange.result, 'number');
  assert.ok(Math.abs(oneDayChange.result - 2.2) < 0.000001);
  assert.equal(typeof dashboard.getCell('E4').value.formula, 'string');
  assert.equal(typeof dashboard.getCell('F4').value.formula, 'string');
});

test('workbook round-trip preserves raw, derived, curve, registry, and audit values', async () => {
  const state = sampleState();
  const restored = await readIceCdsWorkbook(await buildIceCdsWorkbook(state));

  assert.equal(restored.batchId, state.batchId);
  assert.equal(restored.generatedAt, state.generatedAt);
  assert.equal(restored.rawRows.length, state.rawRows.length);
  assert.equal(restored.derivedRows.length, state.derivedRows.length);
  assert.equal(restored.curves.length, 1);
  assert.equal(restored.curves[0].nodes.length, 3);
  assert.equal(restored.registry.length, 2);
  assert.equal(restored.validationLog.length, 1);
  assert.equal(restored.rawRows[0].clearingDate, '2026-08-21');
  assert.equal(restored.derivedRows.find((row) => row.company === 'Oracle' && row.clearingDate === '2026-08-24').spreadBp, 207.4);
  assert.equal(restored.rawRows[0].sourceUrl, state.rawRows[0].sourceUrl);
  assert.deepEqual(restored.methodology, state.methodology);
});

test('rejects duplicate derived unique keys before creating an audit archive', async () => {
  const state = sampleState();
  state.derivedRows.push({ ...state.derivedRows[0], spreadBp: 999 });

  await assert.rejects(() => buildIceCdsWorkbook(state), /duplicate derived/i);
});

test('generated workbook contains no broken formula tokens', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildIceCdsWorkbook(sampleState()));
  const brokenTokens = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?'];
  const formulas = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) formulas.push(cell.value.formula);
    }));
  });

  assert.ok(formulas.length > 0);
  assert.equal(formulas.some((formula) => brokenTokens.some((token) => formula.includes(token))), false);
});

test('dashboard seven-day formula uses the latest valid clearing day at or before the anchor', async () => {
  const state = sampleState();
  state.derivedRows.push({
    ...state.derivedRows[0],
    batchId: 'ice-20260814',
    clearingDate: '2026-08-14',
    eodPrice: 95.8,
    spreadBp: 190,
    roundTripPrice: 95.8,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildIceCdsWorkbook(state));
  const dashboard = workbook.getWorksheet('Daily Dashboard');
  let targetRow = null;
  dashboard.eachRow((row) => {
    const date = row.getCell(1).value;
    if (date instanceof Date && date.toISOString().slice(0, 10) === '2026-08-24' && row.getCell(2).value === 'Oracle') {
      targetRow = row;
    }
  });

  assert.ok(targetRow);
  assert.ok(Math.abs(targetRow.getCell(5).value.result - 17.4) < 0.000001);
  assert.match(targetRow.getCell(5).value.formula, /Derived 5Y Spreads/);
});
