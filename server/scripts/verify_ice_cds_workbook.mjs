import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { readIceCdsWorkbook } from '../lib/iceCdsWorkbook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ICE_CDS_DATA_DIR || path.join(__dirname, '../data/ai-dashboard/ice-cds');
const workbookFile = path.join(dataDir, 'ice-cds-history.xlsx');
const snapshotFile = process.env.AI_DASHBOARD_DATA_FILE || path.join(__dirname, '../data/ai-dashboard/snapshot.json');
const expectedSheets = [
  'Raw EOD Prices',
  'Derived 5Y Spreads',
  'Daily Dashboard',
  'Discount Curves',
  'Contract Registry',
  'Validation Log',
  'Methodology',
];
const requiredHeaders = {
  'Raw EOD Prices': ['Batch ID', 'Clearing Date', 'Company', 'ICE Name', 'Instrument Name', 'EOD Price', 'Source URL', 'Imported At'],
  'Derived 5Y Spreads': ['Batch ID', 'Clearing Date', 'Company', 'Instrument Name', 'EOD Price', 'Coupon (bp)', 'Spread (bp)'],
  'Daily Dashboard': ['Date', 'Company', 'Spread (bp)', '1D Δ (bp)', '7D Δ (bp)', '1M Δ (bp)', 'EOD Price'],
  'Discount Curves': ['Curve ID', 'As Of', 'Currency', 'Years', 'Continuous Zero Rate'],
  'Contract Registry': ['Company', 'Aliases', 'Symbols', 'Currency', 'Tier', 'Restructuring', 'Coupon (bp)'],
  'Validation Log': ['Batch ID', 'Created At', 'Level', 'Code', 'Company', 'Message'],
  Methodology: ['Key', 'Value'],
};

const buffer = await fs.promises.readFile(workbookFile);
const state = await readIceCdsWorkbook(buffer);
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(buffer);
assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), expectedSheets);

for (const [sheetName, headers] of Object.entries(requiredHeaders)) {
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `Missing sheet ${sheetName}`);
  assert.deepEqual(headers.map((_, index) => sheet.getCell(1, index + 1).value), headers, `${sheetName} headers`);
  assert.equal(sheet.views[0]?.state, 'frozen', `${sheetName} must freeze its header`);
}

const unique = new Set();
for (const row of state.derivedRows) {
  const key = `${row.clearingDate}|${row.company}|${row.instrumentName}`;
  assert.equal(unique.has(key), false, `Duplicate derived key ${key}`);
  unique.add(key);
  assert.ok(Number.isFinite(row.spreadBp), `${key} spread`);
  if (row.modelVersion === 'screenshot-backfill-v1') {
    assert.equal(row.eodPrice, null, `${key} must not fabricate an EOD Price`);
    assert.equal(row.priceResidual, null, `${key} must not fabricate a price residual`);
    assert.equal(row.qualityStatus, 'stale', `${key} screenshot quality status`);
  } else {
    assert.ok(Number.isFinite(row.eodPrice), `${key} EOD Price`);
    assert.ok(row.priceResidual <= 0.005, `${key} price residual`);
  }
}

const brokenTokens = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A'];
workbook.eachSheet((sheet) => {
  sheet.eachRow((row) => row.eachCell((cell) => {
    const value = cell.value;
    if (value && typeof value === 'object' && 'formula' in value) {
      assert.equal(brokenTokens.some((token) => String(value.formula).includes(token)), false, `${sheet.name}!${cell.address} formula`);
      assert.equal(brokenTokens.some((token) => String(value.result ?? '').includes(token)), false, `${sheet.name}!${cell.address} result`);
    }
  }));
});

if (fs.existsSync(snapshotFile)) {
  const snapshot = JSON.parse(await fs.promises.readFile(snapshotFile, 'utf8'));
  const cds = snapshot.creditRisk?.cds5y;
  if (state.derivedRows.length > 0 || cds?.batchId === state.batchId) {
    assert.equal(cds?.batchId, state.batchId, 'JSON/workbook batch ID');
    const workbookByCompany = new Map();
    for (const row of state.derivedRows) {
      const prior = workbookByCompany.get(row.company);
      if (!prior || row.clearingDate > prior.clearingDate) workbookByCompany.set(row.company, row);
    }
    for (const company of cds.companies || []) {
      const expected = workbookByCompany.get(company.company);
      assert.ok(expected, `Missing workbook row for ${company.company}`);
      assert.ok(Math.abs(company.latestBp - expected.spreadBp) < 1e-9, `${company.company} spread equality`);
      assert.ok(Math.abs(company.latestEodPrice - expected.eodPrice) < 1e-9, `${company.company} EOD Price equality`);
    }
  }
}

console.log(`[ice-cds] verified ${expectedSheets.length} sheets, ${state.rawRows.length} raw rows, ${state.derivedRows.length} derived rows, batch ${state.batchId}`);
