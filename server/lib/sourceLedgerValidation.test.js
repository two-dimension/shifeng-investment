import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAiDashboardSourceManifest,
  validateResearchLedger,
  validateSourceManifest,
} from './sourceLedgerValidation.js';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function minimalManifest() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    sources: [{
      id: 'anthropic-run-rate', slice: 'growth', entity: 'Anthropic', sourceKind: 'official',
      entryUrl: 'https://www.anthropic.com/news/series-h', allowedHosts: ['www.anthropic.com'], status: 'active',
    }, {
      id: 'yipit-ai-revenue', slice: 'growth', entity: 'AI company ARR estimates', sourceKind: 'estimate',
      entryUrl: 'https://www.yipitdata.com/', allowedHosts: ['www.yipitdata.com'], status: 'active',
    }],
  };
}

function record(overrides = {}) {
  return {
    id: 'anthropic-run-rate-2026-05-28',
    entity: 'Anthropic',
    metric: 'run_rate_revenue',
    value: 47,
    unit: 'USD billion',
    asOf: '2026-05-28',
    sourceId: 'anthropic-run-rate',
    sourceUrl: 'https://www.anthropic.com/news/series-h',
    sourceKind: 'official',
    retrievedAt: '2026-08-24T00:00:00.000Z',
    methodology: 'Company-disclosed run-rate revenue.',
    verification: { status: 'verified', checkedAt: '2026-08-24T00:00:00.000Z' },
    ...overrides,
  };
}

test('generated source manifest covers registered dashboard, capital, benchmark, and OpenRouter sources', () => {
  const manifest = buildAiDashboardSourceManifest({ generatedAt: '2026-08-24T00:00:00.000Z' });
  const ids = new Set(manifest.sources.map((source) => source.id));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(ids.has('anthropic-run-rate'), true);
  assert.equal(ids.has('alibaba-capital'), true);
  assert.equal(ids.has('benchmark:OpenAI'), true);
  assert.equal(ids.has('openrouter-rankings'), true);
  assert.equal(new Set(manifest.sources.map((source) => source.id)).size, manifest.sources.length);
  assert.deepEqual(validateSourceManifest(manifest, { now: NOW }).errors, []);
});

test('ledger accepts an exact registered first-party record and a clearly labeled Yipit estimate', () => {
  const manifest = minimalManifest();
  const ledger = {
    schemaVersion: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    records: [record(), record({
      id: 'anthropic-yipit-2026-07-31', metric: 'arr_estimate', value: 73, asOf: '2026-07-31',
      sourceId: 'yipit-ai-revenue', sourceUrl: 'https://www.yipitdata.com/', sourceKind: 'estimate',
      methodology: 'Yipit estimated ARR; user-supplied datapoint, not reproducible from the public landing page.',
      verification: { status: 'user-confirmed-estimate', checkedAt: '2026-08-24T00:00:00.000Z' },
    })],
  };

  const result = validateResearchLedger(ledger, manifest, { now: NOW });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.counts, { records: 2, verified: 1, estimates: 1, unavailable: 0 });
});

test('ledger rejects unregistered, mismatched-host, future, media, and falsely official Yipit records', () => {
  const manifest = minimalManifest();
  const ledger = {
    schemaVersion: 1,
    generatedAt: '2026-08-24T00:00:00.000Z',
    records: [
      record({ id: 'missing', sourceId: 'unknown' }),
      record({ id: 'wrong-host', sourceUrl: 'https://example.com/copied-story' }),
      record({ id: 'future', asOf: '2027-01-01' }),
      record({ id: 'media', sourceUrl: 'https://www.reuters.com/article/ai' }),
      record({
        id: 'fake-official-yipit', sourceId: 'yipit-ai-revenue', sourceUrl: 'https://www.yipitdata.com/',
        sourceKind: 'official', verification: { status: 'verified', checkedAt: '2026-08-24T00:00:00.000Z' },
      }),
    ],
  };
  const codes = validateResearchLedger(ledger, manifest, { now: NOW }).errors.map((error) => error.code);

  assert.equal(codes.includes('LEDGER_SOURCE_UNREGISTERED'), true);
  assert.equal(codes.includes('LEDGER_HOST_NOT_ALLOWLISTED'), true);
  assert.equal(codes.includes('LEDGER_DATE_FUTURE'), true);
  assert.equal(codes.includes('LEDGER_MEDIA_SOURCE'), true);
  assert.equal(codes.includes('LEDGER_SOURCE_KIND_MISMATCH'), true);
  assert.equal(codes.includes('LEDGER_YIPIT_KIND'), true);
});

test('unavailable coverage rows may omit a value but must explain the first-party gap', () => {
  const manifest = minimalManifest();
  const unavailable = record({
    id: 'anthropic-missing-field', metric: 'net_debt', value: null, unit: 'not disclosed',
    methodology: 'No value disclosed on the checked official page.',
    verification: { status: 'unavailable', checkedAt: '2026-08-24T00:00:00.000Z', note: 'Checked the financing announcement.' },
  });
  assert.deepEqual(validateResearchLedger({
    schemaVersion: 1, generatedAt: '2026-08-24T00:00:00.000Z', records: [unavailable],
  }, manifest, { now: NOW }).errors, []);

  const invalid = { ...unavailable, verification: { status: 'verified', checkedAt: '2026-08-24T00:00:00.000Z' } };
  assert.equal(validateResearchLedger({
    schemaVersion: 1, generatedAt: '2026-08-24T00:00:00.000Z', records: [invalid],
  }, manifest, { now: NOW }).errors.some((error) => error.code === 'LEDGER_VALUE_MISSING'), true);
});
