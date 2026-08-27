import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIceCdsPublicClient,
  refreshIceCdsFromPublicSources,
  startIceCdsAutoRefresh,
} from './iceCdsPublicSource.js';

const iceRows = [
  { clearingDate: '2026-08-24', name: 'Oracle Cop', instrumentName: 'ORCLE.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '95.0309' },
  { clearingDate: '2026-08-24', name: 'COREWEAVE INC', instrumentName: 'COREWEI.SNRFOR.USD.XR14.500.2031-06-20', eodPrice: '90.0135' },
  { clearingDate: '2026-08-24', name: 'NVIDIA Corp', instrumentName: 'NVIDIA.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '100.5487' },
  { clearingDate: '2026-08-24', name: 'Amazon Com Inc', instrumentName: 'AMZN.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '101.4668' },
  { clearingDate: '2026-08-24', name: 'Alphabet Inc', instrumentName: 'ALPHINC.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '101.7418' },
  { clearingDate: '2026-08-24', name: 'Microsoft Corp', instrumentName: 'MSFT.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '102.2015' },
  { clearingDate: '2026-08-24', name: 'META PLATFORMS INC', instrumentName: 'METAPL.SNRFOR.USD.XR14.100.2031-06-20', eodPrice: '100.1232' },
];

const treasuryCsv = [
  'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"',
  '08/25/2026,3.80,3.79,3.81,3.88,3.91,3.97,4.05,4.25,4.32,4.42,4.56,4.71,5.22,5.24',
  '08/24/2026,3.79,3.78,3.80,3.87,3.90,3.96,4.04,4.24,4.31,4.41,4.55,4.70,5.21,5.23',
  '08/21/2026,3.80,3.77,3.80,3.88,3.90,3.95,4.03,4.24,4.31,4.43,4.57,4.74,5.25,5.27',
].join('\n');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return body; } };
}

test('builds a seven-company import batch from the free ICE feed and same-day Treasury curve', async () => {
  const fetchImpl = async (url) => String(url).includes('icc-single-names')
    ? response(iceRows)
    : response(treasuryCsv);
  const client = createIceCdsPublicClient({ fetchImpl });

  const input = await client.fetchLatestInput();

  assert.match(input.iceText, /Oracle Cop\tORCLE\.SNRFOR/);
  assert.equal(input.iceText.trim().split('\n').length, 8);
  assert.equal(input.discountCurve.asOf, '2026-08-24');
  assert.equal(input.discountCurve.curveId, 'ust-par-zero-proxy-2026-08-24');
  assert.deepEqual(input.discountCurve.nodes.slice(0, 3), [
    { years: 1 / 12, zeroRate: 0.0379 },
    { years: 0.125, zeroRate: 0.0378 },
    { years: 1 / 6, zeroRate: 0.038 },
  ]);
});

test('uses the latest Treasury curve not after the ICE clearing date', async () => {
  const fridayRows = iceRows.map((row) => ({ ...row, clearingDate: '2026-08-23' }));
  const fetchImpl = async (url) => String(url).includes('icc-single-names')
    ? response(fridayRows)
    : response(treasuryCsv);

  const input = await createIceCdsPublicClient({ fetchImpl }).fetchLatestInput();

  assert.equal(input.discountCurve.asOf, '2026-08-21');
  assert.equal(input.discountCurve.nodes[0].zeroRate, 0.038);
});

test('uses the latest complete seven-company ICE date when a newer partial market date exists', async () => {
  const partialNextDay = [{
    clearingDate: '2026-08-25',
    name: 'Untracked Issuer',
    instrumentName: 'OTHER.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '99.5000',
  }];
  const fetchImpl = async (url) => String(url).includes('icc-single-names')
    ? response([...partialNextDay, ...iceRows])
    : response(treasuryCsv);

  const input = await createIceCdsPublicClient({ fetchImpl }).fetchLatestInput();

  assert.match(input.iceText, /^Clearing Date[\s\S]*2026-08-24\tOracle Cop/m);
  assert.doesNotMatch(input.iceText, /2026-08-25/);
  assert.equal(input.discountCurve.asOf, '2026-08-24');
});

test('rejects an incomplete ICE batch before writing any files', async () => {
  const fetchImpl = async (url) => String(url).includes('icc-single-names')
    ? response(iceRows.slice(1))
    : response(treasuryCsv);

  await assert.rejects(
    () => createIceCdsPublicClient({ fetchImpl }).fetchLatestInput(),
    /Oracle/,
  );
});

test('refresh imports the public batch through the audited pipeline', async () => {
  const expected = { iceText: 'batch', discountCurve: { curveId: 'curve' } };
  const client = { async fetchLatestInput() { return expected; } };
  const pipeline = { async import(input) { assert.equal(input, expected); return { batchId: 'ice-20260824-live' }; } };

  const result = await refreshIceCdsFromPublicSources({ client, pipeline });

  assert.equal(result.batchId, 'ice-20260824-live');
});

test('daily scheduler runs once after startup, repeats daily, and can be stopped', async () => {
  const timeouts = [];
  const intervals = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  let refreshes = 0;
  const stop = startIceCdsAutoRefresh(async () => { refreshes += 1; }, {
    setTimeoutImpl(callback, ms) { const timer = { callback, ms, id: 'initial' }; timeouts.push(timer); return timer.id; },
    setIntervalImpl(callback, ms) { const timer = { callback, ms, id: 'daily' }; intervals.push(timer); return timer.id; },
    clearTimeoutImpl(id) { clearedTimeouts.push(id); },
    clearIntervalImpl(id) { clearedIntervals.push(id); },
  });

  assert.equal(timeouts[0].ms, 5_000);
  assert.equal(intervals[0].ms, 86_400_000);
  await timeouts[0].callback();
  await intervals[0].callback();
  assert.equal(refreshes, 2);
  stop();
  assert.deepEqual(clearedTimeouts, ['initial']);
  assert.deepEqual(clearedIntervals, ['daily']);
});
