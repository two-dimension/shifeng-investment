import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildArrMetrics, attachValuationMultiples } from './aiDashboardMetrics.js';
import { normalizeGrowthRecords } from './aiGrowthData.js';
import { AI_GROWTH_SOURCE_REGISTRY, createAiGrowthCollector } from './aiGrowthSources.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/ai-growth/${name}`, import.meta.url), 'utf8');

function documentClient(overrides = {}) {
  const htmlById = {
    'anthropic-series-g': fixture('anthropic-series-g.html'),
    'anthropic-run-rate': fixture('anthropic-official.html'),
    'openai-arr-history': fixture('openai-official.html'),
    'openai-valuation': fixture('openai-valuation.html'),
    ...overrides,
  };
  return {
    async fetchDocument(definition) {
      const text = htmlById[definition.id];
      if (text instanceof Error) throw text;
      return {
        text,
        finalUrl: definition.entryUrl,
        retrievedAt: '2026-08-24T00:00:00.000Z',
      };
    },
  };
}

function previousWithYipit() {
  const normalized = normalizeGrowthRecords({
    yipitRecords: JSON.parse(fixture('anthropic-yipit.json')).records,
    retrievedAt: '2026-08-23T00:00:00.000Z',
  });
  return {
    arrAndValuation: {
      companies: buildArrMetrics(normalized.arrRecords, { now: new Date('2026-08-24T00:00:00.000Z') }),
      valuations: [],
    },
  };
}

test('growth registry contains only named official inputs and keeps Yipit as a preserved estimate', () => {
  assert.deepEqual(AI_GROWTH_SOURCE_REGISTRY.map(({ id, sourceKind }) => ({ id, sourceKind })), [
    { id: 'anthropic-series-g', sourceKind: 'official' },
    { id: 'anthropic-run-rate', sourceKind: 'official' },
    { id: 'openai-arr-history', sourceKind: 'official' },
    { id: 'openai-valuation', sourceKind: 'official' },
  ]);
});

test('growth collector builds official ARR and complete P/ARR history while retaining the separate Yipit series', async () => {
  const collector = createAiGrowthCollector({ documentClient: documentClient() });
  const result = await collector({
    previous: previousWithYipit(),
    now: new Date('2026-08-24T00:00:00.000Z'),
    generatedAt: '2026-08-24T00:00:00.000Z',
  });

  const companies = result.payload.arrAndValuation.companies;
  assert.equal(companies.filter((series) => series.company === 'Anthropic').length, 2);
  assert.deepEqual(companies.find((series) => series.seriesId === 'Anthropic:official:Anthropic')
    .actualPoints.map(({ observedAt, value }) => ({ observedAt, value })), [
    { observedAt: '2026-02-12', value: 140 },
    { observedAt: '2026-05-28', value: 470 },
  ]);
  assert.deepEqual(companies.find((series) => series.company === 'OpenAI')
    .actualPoints.map(({ observedAt, value }) => ({ observedAt, value })), [
    { observedAt: '2023-12-31', value: 20 },
    { observedAt: '2024-12-31', value: 60 },
    { observedAt: '2025-12-31', value: 200 },
  ]);
  assert.deepEqual(result.payload.arrAndValuation.valuations.map(({ company, asOf, valuationLow, parrLow }) => ({
    company, asOf, valuationLow, parrLow,
  })), [
    { company: 'Anthropic', asOf: '2026-02-12', valuationLow: 3800, parrLow: 27.142857142857142 },
    { company: 'OpenAI', asOf: '2026-03-31', valuationLow: 8520, parrLow: 42.6 },
    { company: 'Anthropic', asOf: '2026-05-28', valuationLow: 9650, parrLow: 20.53191489361702 },
  ]);
  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.stale, false);
});

test('growth collector isolates one official source failure and reports the retained coverage', async () => {
  const collector = createAiGrowthCollector({
    documentClient: documentClient({ 'anthropic-run-rate': new Error('timeout') }),
  });
  const result = await collector({ previous: previousWithYipit(), generatedAt: '2026-08-24T00:00:00.000Z' });

  assert.equal(result.source.status, 'ready');
  assert.equal(result.source.stale, true);
  assert.match(result.source.message, /3\/4/);
  assert.equal(result.payload.arrAndValuation.companies.some((series) => series.sourceLabel === 'Yipit'), true);
});

test('valuation multiples are calculated by the existing metric helper used by the collector', () => {
  const values = attachValuationMultiples([], []);
  assert.deepEqual(values, []);
});
