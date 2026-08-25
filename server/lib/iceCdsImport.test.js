import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ICE_CDS_CONTRACT_REGISTRY } from './iceCdsRegistry.js';
import {
  parseIceInstrumentName,
  parseIceSettlementText,
  selectTrackedFiveYearContracts,
} from './iceCdsImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureFile = path.join(__dirname, '../fixtures/ice-cds/icc-single-name-sample.tsv');

test('parses ICE tabular rows and preserves duplicates for explicit validation', () => {
  const rows = parseIceSettlementText(fs.readFileSync(fixtureFile, 'utf8'));

  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], {
    clearingDate: '2026-08-24',
    name: 'ORACLE CORPORATION',
    instrumentName: 'ORCL.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: 95.24,
    rowNumber: 2,
  });
  assert.deepEqual(parseIceInstrumentName(rows[0].instrumentName), {
    symbol: 'ORCL',
    tier: 'SNRFOR',
    currency: 'USD',
    restructuring: 'XR14',
    couponBp: 100,
    maturityDate: '2031-06-20',
  });

  const result = selectTrackedFiveYearContracts(rows, '2026-08-24');
  assert.equal(result.selected.some((row) => row.company === 'NVIDIA'), false);
  assert.equal(result.errors.find((row) => row.company === 'NVIDIA').code, 'ambiguous-contract');
});

test('accepts RFC-4180 CSV including quoted issuer names', () => {
  const rows = parseIceSettlementText([
    'Clearing Date,Name,Instrument Name,EOD Price',
    '2026-08-24,"Alphabet, Inc.",GOOGL.SNRFOR.USD.XR14.100.2031-06-20,99.1250',
  ].join('\r\n'));

  assert.equal(rows[0].name, 'Alphabet, Inc.');
  assert.equal(rows[0].eodPrice, 99.125);
});

test('rejects malformed dates, prices, headers, and instrument names', () => {
  assert.throws(() => parseIceSettlementText('Name\tEOD Price\nOracle\t99'), /headers/i);
  assert.throws(() => parseIceSettlementText('Clearing Date\tName\tInstrument Name\tEOD Price\n2026-02-30\tOracle\tORCL.SNRFOR.USD.XR14.100.2031-06-20\t99'), /date/i);
  assert.throws(() => parseIceSettlementText('Clearing Date\tName\tInstrument Name\tEOD Price\n2026-08-24\tOracle\tORCL.SNRFOR.USD.XR14.100.2031-06-20\t-1'), /price/i);
  assert.throws(() => parseIceInstrumentName('not-an-instrument'), /instrument/i);
});

test('registry covers the seven requested companies and selects only exact canonical 5Y contracts', () => {
  assert.deepEqual(
    ICE_CDS_CONTRACT_REGISTRY.map((row) => row.company),
    ['Oracle', 'CoreWeave', 'NVIDIA', 'Amazon', 'Google', 'Microsoft', 'Meta'],
  );

  const rawRows = [
    ['ORACLE CORP', 'ORCL', 100],
    ['COREWEAVE INC', 'CRWV', 500],
    ['NVIDIA CORP', 'NVDA', 100],
    ['AMAZON.COM INC', 'AMZN', 100],
    ['ALPHABET INC', 'GOOGL', 100],
    ['MICROSOFT CORP', 'MSFT', 100],
    ['META PLATFORMS INC', 'META', 100],
  ].map(([name, symbol, couponBp], index) => ({
    clearingDate: '2026-08-24',
    name,
    instrumentName: `${symbol}.SNRFOR.USD.XR14.${couponBp}.2031-06-${String(20 + index).padStart(2, '0')}`,
    eodPrice: 90 + index,
    rowNumber: index + 2,
  }));

  const result = selectTrackedFiveYearContracts(rawRows, '2026-08-24');

  assert.deepEqual(result.selected.map((row) => row.company), ICE_CDS_CONTRACT_REGISTRY.map((row) => row.company));
  assert.deepEqual(result.selected.map((row) => row.contract.couponBp), [100, 500, 100, 100, 100, 100, 100]);
  assert.deepEqual(result.errors, []);
});

test('selects the seven live ICE issuer codes published by the free single-name feed', () => {
  const officialRows = [
    ['Oracle Cop', 'ORCLE', 100, 95.0309],
    ['COREWEAVE INC', 'COREWEI', 500, 90.0135],
    ['NVIDIA Corp', 'NVIDIA', 100, 100.5487],
    ['Amazon Com Inc', 'AMZN', 100, 101.4668],
    ['Alphabet Inc', 'ALPHINC', 100, 101.7418],
    ['Microsoft Corp', 'MSFT', 100, 102.2015],
    ['META PLATFORMS INC', 'METAPL', 100, 100.1232],
  ].map(([name, symbol, couponBp, eodPrice], index) => ({
    clearingDate: '2026-08-24',
    name,
    instrumentName: `${symbol}.SNRFOR.USD.XR14.${couponBp}.2031-06-20`,
    eodPrice,
    rowNumber: index + 2,
  }));

  const result = selectTrackedFiveYearContracts(officialRows, '2026-08-24');

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.selected.map((row) => row.company),
    ['Oracle', 'CoreWeave', 'NVIDIA', 'Amazon', 'Google', 'Microsoft', 'Meta']);
});

test('selection reports missing, ambiguous, wrong-coupon, and wrong-tenor rows without guessing', () => {
  const rows = [
    { clearingDate: '2026-08-24', name: 'ORACLE CORP', instrumentName: 'ORCL.SNRFOR.USD.XR14.500.2031-06-20', eodPrice: 95, rowNumber: 2 },
    { clearingDate: '2026-08-24', name: 'COREWEAVE INC', instrumentName: 'CRWV.SNRFOR.USD.XR14.500.2036-06-20', eodPrice: 88, rowNumber: 3 },
    { clearingDate: '2026-08-24', name: 'NVIDIA CORP', instrumentName: 'NVDA.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: 99, rowNumber: 4 },
    { clearingDate: '2026-08-24', name: 'NVIDIA CORPORATION', instrumentName: 'NVDA.SNRFOR.USD.XR14.100.2031-06-21', eodPrice: 99.1, rowNumber: 5 },
  ];

  const result = selectTrackedFiveYearContracts(rows, '2026-08-24');
  const errors = new Map(result.errors.map((error) => [error.company, error.code]));

  assert.equal(errors.get('Oracle'), 'no-canonical-contract');
  assert.equal(errors.get('CoreWeave'), 'no-canonical-contract');
  assert.equal(errors.get('NVIDIA'), 'ambiguous-contract');
  assert.equal(errors.get('Amazon'), 'missing-issuer');
  assert.deepEqual(result.selected, []);
});
