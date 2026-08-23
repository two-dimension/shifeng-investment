import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  normalizeGrowthRecords,
  parseOfficialArrHistoryHtml,
  parseOfficialRunRateRevenueHtml,
  parseOfficialValuationHtml,
} from './aiGrowthData.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/ai-growth/${name}`, import.meta.url), 'utf8');

test('official Anthropic run-rate disclosure and Yipit estimate remain parallel series with original units', () => {
  const yipit = JSON.parse(fixture('anthropic-yipit.json'));
  const official = parseOfficialRunRateRevenueHtml(fixture('anthropic-official.html'), {
    company: 'Anthropic',
    observedAt: '2026-05-10',
    sourceLabel: 'Anthropic',
    sourceUrl: 'https://www.anthropic.com/news/series-h',
    commentary: 'Company disclosure accompanying Series H financing.',
  });

  const normalized = normalizeGrowthRecords({
    yipitRecords: yipit.records,
    officialRecords: [official],
    valuationRecords: [],
    retrievedAt: '2026-08-23T00:00:00.000Z',
  });

  assert.deepEqual(normalized.arrRecords.map((record) => ({
    sourceLabel: record.sourceLabel,
    seriesKind: record.seriesKind,
    value: record.value,
    originalValue: record.originalValue,
    originalUnit: record.originalUnit,
    unitScale: record.unitScale,
  })), [
    { sourceLabel: 'Yipit', seriesKind: 'estimate', value: 730, originalValue: 73, originalUnit: 'USD billion', unitScale: 100_000_000 },
    { sourceLabel: 'Anthropic', seriesKind: 'official', value: 470, originalValue: 47, originalUnit: 'USD billion', unitScale: 100_000_000 },
  ]);
  assert.equal(normalized.arrRecords[0].provenance.sourceKind, 'estimate');
  assert.equal(normalized.arrRecords[1].provenance.methodology, 'Company-disclosed run-rate revenue');
});

test('official OpenAI ARR history parser preserves every disclosed year instead of only the latest point', () => {
  const records = parseOfficialArrHistoryHtml(fixture('openai-official.html'), {
    company: 'OpenAI',
    sourceLabel: 'OpenAI',
    sourceUrl: 'https://openai.com/index/a-business-that-scales-with-the-value-of-intelligence/',
  });

  const normalized = normalizeGrowthRecords({
    yipitRecords: [],
    officialRecords: records,
    valuationRecords: [{
      company: 'OpenAI', asOf: '2026-03-31', valuationLow: 852, valuationHigh: 852,
      originalUnit: 'USD billion', sourceLabel: 'OpenAI', sourceUrl: 'https://openai.com/index/accelerating-the-next-phase-ai/',
      sourceKind: 'official', methodology: 'Post-money financing valuation', arrSeriesKind: 'official',
    }],
    retrievedAt: '2026-08-23T00:00:00.000Z',
  });

  assert.deepEqual(normalized.arrRecords.map(({ observedAt, value }) => ({ observedAt, value })), [
    { observedAt: '2023-12-31', value: 20 },
    { observedAt: '2024-12-31', value: 60 },
    { observedAt: '2025-12-31', value: 200 },
  ]);
  assert.equal(normalized.valuationRecords[0].valuationLow, 8520);
  assert.equal(normalized.valuationRecords[0].arrSeriesKind, 'official');
  assert.equal(normalized.valuationRecords[0].provenance.sourceKind, 'official');
});

test('growth normalizer rejects unsupported currencies and non-positive unit scales', () => {
  assert.throws(() => normalizeGrowthRecords({
    yipitRecords: [{
      company: 'Anthropic', observedAt: '2026-08-01', originalValue: 1, originalUnit: 'EUR billion',
      currency: 'EUR', sourceLabel: 'Yipit', sourceUrl: 'https://www.yipitdata.com/', methodology: 'Estimate',
    }],
    officialRecords: [],
    valuationRecords: [],
    retrievedAt: '2026-08-23T00:00:00.000Z',
  }), /unsupported currency/i);
});

test('official financing announcements expose post-money valuation without borrowing a media estimate', () => {
  const anthropic = parseOfficialValuationHtml(fixture('anthropic-official.html'), {
    company: 'Anthropic',
    asOf: '2026-05-28',
    sourceLabel: 'Anthropic',
    sourceUrl: 'https://www.anthropic.com/news/series-h',
    arrSeriesKind: 'official',
  });
  const openai = parseOfficialValuationHtml(fixture('openai-valuation.html'), {
    company: 'OpenAI',
    asOf: '2026-03-31',
    sourceLabel: 'OpenAI',
    sourceUrl: 'https://openai.com/index/accelerating-the-next-phase-ai/',
    arrSeriesKind: 'official',
  });

  assert.deepEqual({ low: anthropic.valuationLow, unit: anthropic.originalUnit }, { low: 965, unit: 'USD billion' });
  assert.deepEqual({ low: openai.valuationLow, unit: openai.originalUnit }, { low: 852, unit: 'USD billion' });
  assert.equal(openai.methodology, 'Company-disclosed post-money financing valuation');
});
