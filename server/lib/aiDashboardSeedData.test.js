import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildAiDashboardSeedPayload } from './aiDashboardSeedData.js';

const ledger = JSON.parse(fs.readFileSync(new URL('../data/ai-dashboard/research-ledger.json', import.meta.url), 'utf8'));

test('research ledger seeds parallel official and Yipit growth series plus complete financing events', () => {
  const payload = buildAiDashboardSeedPayload(ledger, {
    now: new Date('2026-08-24T00:10:00.000+08:00'),
    generatedAt: '2026-08-23T16:10:00.000Z',
  });

  assert.deepEqual(payload.arrAndValuation.companies.map(({ company, seriesKind, sourceLabel }) => ({
    company, seriesKind, sourceLabel,
  })), [
    { company: 'Anthropic', seriesKind: 'estimate', sourceLabel: 'Yipit' },
    { company: 'Anthropic', seriesKind: 'official', sourceLabel: 'Anthropic' },
    { company: 'OpenAI', seriesKind: 'official', sourceLabel: 'OpenAI' },
  ]);
  assert.deepEqual(payload.arrAndValuation.valuations.map(({ company, valuationLow, parrLow }) => ({
    company, valuationLow, parrLow,
  })), [
    { company: 'Anthropic', valuationLow: 3800, parrLow: 3800 / 140 },
    { company: 'OpenAI', valuationLow: 8520, parrLow: 8520 / 200 },
    { company: 'Anthropic', valuationLow: 9650, parrLow: 9650 / 470 },
  ]);
  assert.deepEqual(payload.capitalEvents.map(({ entity, eventDate, amountOriginal, rateType }) => ({
    entity, eventDate, amountOriginal, rateType,
  })), [
    { entity: 'Anthropic', eventDate: '2026-05-28', amountOriginal: 65_000_000_000, rateType: 'not_applicable' },
    { entity: 'OpenAI', eventDate: '2026-03-31', amountOriginal: 122_000_000_000, rateType: 'not_applicable' },
    { entity: 'Anthropic', eventDate: '2026-02-12', amountOriginal: 30_000_000_000, rateType: 'not_applicable' },
  ]);
  assert.equal(payload.capitalMetrics.industry.eventCount, 3);

  assert.deepEqual([...new Set(payload.modelPricing.token.map((row) => row.vendor))].sort(), [
    'Anthropic', 'DeepSeek', 'Gemini', 'Kimi', 'MiMo', 'MiniMax', 'OpenAI', 'Qwen',
  ]);
  assert.equal(payload.modelPricing.sourceReports.some((report) => (
    report.sourceId === 'zhipu-models'
    && report.status === 'unavailable'
    && report.rows === 0
  )), true);
  assert.deepEqual([...new Set(payload.modelPricing.video.map((row) => row.vendor))].sort(), [
    'Kling', 'MiniMax', 'Seedance',
  ]);
  assert.deepEqual([...new Set(payload.modelPricing.codingPlans.map((row) => row.vendor))].sort(), [
    'Anthropic', 'DeepSeek', 'Gemini', 'Kimi', 'MiMo', 'MiniMax', 'OpenAI', 'Qwen', '智谱',
  ]);
  assert.equal(payload.modelPricing.codingPlans.find((row) => row.vendor === 'Qwen')?.pricingMode, 'unpublished');
});

test('seed builder ignores unrelated ledger metrics instead of fabricating dashboard rows', () => {
  const payload = buildAiDashboardSeedPayload({
    schemaVersion: 1,
    records: [{ ...ledger.records[0], id: 'unrelated', metric: 'unknown_metric' }],
  }, { generatedAt: '2026-08-23T16:10:00.000Z' });

  assert.deepEqual(payload.arrAndValuation, { companies: [], valuations: [] });
  assert.deepEqual(payload.capitalEvents, []);
  assert.deepEqual(payload.modelPricing, {
    token: [], tokenHistory: [], priceEvents: [], video: [], videoHistory: [],
    codingPlans: [], codingPlanHistory: [], sourceReports: [],
  });
});
