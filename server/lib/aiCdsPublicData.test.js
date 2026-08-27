import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import {
  createDtccCdsClient,
  deriveCdsObservations,
  mergePublicCdsObservations,
  parseDtccCdsCsv,
} from './aiCdsPublicData.js';

const HEADERS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Asset Class',
  'Execution Timestamp',
  'Effective Date',
  'Expiration Date',
  'Notional amount-Leg 1',
  'Notional currency-Leg 1',
  'Fixed rate-Leg 1',
  'Other payment amount',
  'Other payment currency',
  'Underlying Asset Name',
  'UPI FISN',
  'UPI Underlier Name',
];

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function csv(rows) {
  return [HEADERS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function trade({
  id,
  originalId = '',
  action = 'NEWT',
  eventType = 'TRAD',
  assetClass = 'CR',
  executedAt = '2026-08-24T14:00:00Z',
  effectiveDate = '2026-08-25',
  expirationDate = '2031-06-20',
  notional = '1,000,000',
  currency = 'USD',
  coupon = '0.01',
  upfront = '10,000',
  paymentCurrency = 'USD',
  underlyingName = '',
  fisn = 'NA/CDS Corp SN Sr',
  upiName = '',
}) {
  return [
    id, originalId, action, eventType, assetClass, executedAt, effectiveDate, expirationDate,
    notional, currency, coupon, upfront, paymentCurrency, underlyingName, fisn, upiName,
  ];
}

const REFERENCE = {
  asOf: '2026-08-19',
  sourceLabel: 'ICE ICC（用户截图估算）',
  historyEstimated: true,
  companies: [
    { company: 'Oracle', latestBp: 216, changes: {}, history: [{ date: '2026-07-24', valueBp: 210 }, { date: '2026-08-17', valueBp: 214 }, { date: '2026-08-19', valueBp: 214 }] },
    { company: 'CoreWeave', latestBp: 800, changes: {}, history: [{ date: '2026-07-24', valueBp: 700 }, { date: '2026-08-19', valueBp: 786 }] },
    { company: 'NVIDIA', latestBp: 87, changes: {}, history: [{ date: '2026-07-24', valueBp: 70 }, { date: '2026-08-19', valueBp: 86 }] },
    { company: 'Amazon', latestBp: 66, changes: {}, history: [{ date: '2026-07-24', valueBp: 68 }, { date: '2026-08-19', valueBp: 63 }] },
    { company: 'Google', latestBp: 60, changes: {}, history: [{ date: '2026-07-24', valueBp: 64 }, { date: '2026-08-19', valueBp: 58 }] },
    { company: 'Microsoft', latestBp: 49, changes: {}, history: [{ date: '2026-07-24', valueBp: 54 }, { date: '2026-08-19', valueBp: 47 }] },
    { company: 'Meta', latestBp: 97, changes: {}, history: [{ date: '2026-07-24', valueBp: 92 }, { date: '2026-08-19', valueBp: 94 }] },
  ],
};

test('parses the seven tracked single-name 5Y CDS aliases and ignores unsuitable trades', () => {
  const content = csv([
    trade({ id: '1', underlyingName: 'ORACLE CORPORATION', upfront: '47,707.62' }),
    trade({ id: '2', underlyingName: 'CoreWeave;Inc.', coupon: '0.05', upfront: '89,166.67' }),
    trade({ id: '3', underlyingName: 'NVIDIA CORP', upfront: '6,000' }),
    trade({ id: '4', underlyingName: 'AMAZON.COM INC', upfront: '16,420' }),
    trade({ id: '5', underlyingName: 'Alphabet Inc.', upfront: '17,500' }),
    trade({ id: '6', underlyingName: 'Microsoft Corporation', upfront: '22,196' }),
    trade({ id: '7', underlyingName: 'META PLATFORMS;INC.', upfront: '3,000' }),
    trade({ id: '8', underlyingName: 'ORACLE CORPORATION', expirationDate: '2036-06-20' }),
    trade({ id: '9', underlyingName: 'ORACLE CORPORATION', currency: 'EUR' }),
    trade({ id: '10', underlyingName: 'ORACLE CORPORATION', fisn: 'NA/CDS Index' }),
    trade({ id: '11', underlyingName: 'ORACLE CORPORATION', eventType: 'NOVA' }),
  ]);

  const parsed = parseDtccCdsCsv(content);

  assert.deepEqual(parsed.map((row) => row.company), [
    'Oracle', 'CoreWeave', 'NVIDIA', 'Amazon', 'Google', 'Microsoft', 'Meta',
  ]);
  assert.equal(parsed[0].notionalUsd, 1_000_000);
  assert.equal(parsed[0].upfrontUsd, 47_707.62);
  assert.equal(parsed[1].couponBp, 500);
});

test('removes canceled originals and marks capped notional trades as low-confidence estimates', () => {
  const content = csv([
    trade({ id: 'old', underlyingName: 'ORACLE CORPORATION', upfront: '47,707.62' }),
    trade({ id: 'error', originalId: 'old', action: 'EROR', underlyingName: 'ORACLE CORPORATION' }),
    trade({ id: 'new', underlyingName: 'ORACLE CORPORATION', notional: '5,000,000+', upfront: '238,538' }),
  ]);

  const parsed = parseDtccCdsCsv(content);
  const observations = deriveCdsObservations(parsed, REFERENCE.companies);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'new');
  assert.equal(parsed[0].notionalCapped, true);
  assert.equal(observations[0].confidence, 'low');
  assert.equal(observations[0].tradeCount, 1);
  assert.ok(observations[0].valueBp > 190 && observations[0].valueBp < 250);
});

test('derives coupon/upfront implied spreads without presenting them as exchange settlement quotes', () => {
  const parsed = parseDtccCdsCsv(csv([
    trade({ id: 'oracle', underlyingName: 'ORACLE CORPORATION', upfront: '47,707.62' }),
    trade({ id: 'amazon', underlyingName: 'AMAZON.COM INC', upfront: '16,420' }),
    trade({ id: 'coreweave', underlyingName: 'CoreWeave;Inc.', coupon: '0.05', upfront: '89,166.67' }),
  ]));

  const observations = deriveCdsObservations(parsed, REFERENCE.companies);
  const byCompany = new Map(observations.map((row) => [row.company, row]));

  assert.ok(byCompany.get('Oracle').valueBp > 200);
  assert.ok(byCompany.get('Amazon').valueBp < 100);
  assert.ok(byCompany.get('CoreWeave').valueBp > 700);
  assert.equal(byCompany.get('Oracle').confidence, 'medium');
});

test('uses the daily median so one exact-notional package outlier does not dominate capped trades', () => {
  const parsed = parseDtccCdsCsv(csv([
    trade({ id: 'meta-1', underlyingName: 'META PLATFORMS;INC.', notional: '5,000,000+', upfront: '15,271.72' }),
    trade({ id: 'meta-2', underlyingName: 'META PLATFORMS;INC.', notional: '5,000,000+', upfront: '13,142.38' }),
    trade({ id: 'meta-3', underlyingName: 'META PLATFORMS;INC.', notional: '5,000,000+', upfront: '19,534.96' }),
    trade({ id: 'package-outlier', underlyingName: 'META PLATFORMS;INC.', notional: '1,000,000', upfront: '22,196' }),
  ]));

  const [observation] = deriveCdsObservations(parsed, REFERENCE.companies);

  assert.ok(observation.valueBp > 80);
  assert.equal(observation.confidence, 'low');
  assert.equal(observation.tradeCount, 4);
});

test('merges public observations into the existing screenshot-shaped cards and history', () => {
  const next = mergePublicCdsObservations(REFERENCE, [
    { company: 'Oracle', asOf: '2026-08-24', executedAt: '2026-08-24T14:00:00Z', valueBp: 221.2, confidence: 'medium', tradeCount: 3 },
    { company: 'Amazon', asOf: '2026-08-24', executedAt: '2026-08-24T16:00:00Z', valueBp: 60.9, confidence: 'medium', tradeCount: 2 },
  ], { checkedAt: '2026-08-25T01:00:00.000Z' });

  assert.equal(next.sourceKind, 'dtcc_public_trade_estimate');
  assert.equal(next.sourceLabel, 'DTCC SEC PPD · 成交隐含估算');
  assert.equal(next.asOf, '2026-08-24');
  assert.equal(next.companies.length, 7);
  assert.equal(next.companies[0].latestBp, 221);
  assert.deepEqual(next.companies[0].history.at(-1), { date: '2026-08-24', valueBp: 221 });
  assert.equal(next.companies[0].changes.oneDayBp, 7);
  assert.equal(next.companies[0].changes.sevenDayBp, 7);
  assert.equal(next.companies[0].changes.oneMonthBp, 11);
  assert.equal(next.companies[1].latestBp, 800);
  assert.match(next.note, /不是 ICE ICC/);
});

test('DTCC client discovers the current public bucket and reads the latest SEC credit ZIP', async () => {
  const content = csv([
    trade({ id: '1', underlyingName: 'ORACLE CORPORATION', upfront: '47,707.62' }),
  ]);
  const archive = zipSync({ 'SEC_CUMULATIVE_CREDITS_2026_08_24.csv': strToU8(content) });
  const calls = [];
  const client = createDtccCdsClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/general/bucketname')) return new Response('public-bucket');
      if (String(url).endsWith('/dashboard/Cumulative.json')) {
        return Response.json({ SEC_CR: [{
          dissemDTM: '2026-08-25T00:00:00Z',
          fileName: 'SEC_CUMULATIVE_CREDITS_2026_08_24.zip',
          fullFilePath: 'https://public-bucket.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_CREDITS_2026_08_24.zip',
        }] });
      }
      return new Response(archive, { headers: { 'content-type': 'application/zip' } });
    },
  });

  const result = await client.fetchLatest({ referenceCompanies: REFERENCE.companies });

  assert.equal(result.asOf, '2026-08-24');
  assert.equal(result.observations[0].company, 'Oracle');
  assert.equal(calls.length, 3);
  assert.match(calls[1], /public-bucket\.s3\.amazonaws\.com\/dashboard\/Cumulative\.json/);
});
