import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeArtificialAnalysisSnapshot } from './artificialAnalysisData.js';

const datasets = [
  {
    '@type': 'Dataset', name: 'Artificial Analysis Intelligence Index: Score',
    data: [
      { label: 'Model B', 'Artificial Analysis Intelligence Index': 55.25, detailsUrl: '/models/model-b' },
      { label: 'Model A', 'Artificial Analysis Intelligence Index': 63.05, detailsUrl: '/models/model-a' },
    ],
  },
  {
    '@type': 'Dataset', name: 'Artificial Analysis Intelligence Index: Output Tokens per Task',
    data: [{ label: 'Model A', answer: 3200, reasoning: 6800, detailsUrl: '/models/model-a' }],
  },
  {
    '@type': 'Dataset', name: 'Cost per Intelligence Index Task',
    data: [{ label: 'Model A', input: 0.02, cacheHit: 0.03, cacheWrite: 0.01, reasoning: 0.12, answer: 0.08, detailsUrl: '/models/model-a' }],
  },
];

test('normalizes public AA JSON-LD into a separate named-third-party snapshot', () => {
  const result = normalizeArtificialAnalysisSnapshot({
    datasets,
    indexVersion: '4.1.1',
    asOf: '2026-08-23',
    retrievedAt: '2026-08-23T00:00:00.000Z',
    sourceUrl: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
  });

  assert.deepEqual(result.intelligenceIndex.map(({ model, score, rank }) => ({ model, score, rank })), [
    { model: 'Model A', score: 63.05, rank: 1 },
    { model: 'Model B', score: 55.25, rank: 2 },
  ]);
  assert.deepEqual(result.taskCosts[0], {
    model: 'Model A', modelUrl: 'https://artificialanalysis.ai/models/model-a',
    taskName: 'Artificial Analysis Intelligence Index', taskVersion: '4.1.1',
    harness: 'Artificial Analysis independent evaluation',
    answerTokens: 3200, reasoningTokens: 6800, outputTokens: 10000,
    inputCost: 0.02, cacheHitCost: 0.03, cacheWriteCost: 0.01,
    reasoningCost: 0.12, answerCost: 0.08, totalCost: 0.26, currency: 'USD',
    sourceLabel: 'Artificial Analysis',
    sourceUrl: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
    sourceKind: 'named-third-party', asOf: '2026-08-23', retrievedAt: '2026-08-23T00:00:00.000Z',
    methodology: 'AA 公共 JSON-LD：每项评测按任务数与 Intelligence Index 权重计算；组件成本求和',
    stale: false,
  });
  assert.equal(result.intelligenceIndex.every((row) => row.sourceKind === 'named-third-party'), true);
  assert.equal('benchmarks' in result, false);
});

test('preserves missing token components as unavailable instead of zero', () => {
  const result = normalizeArtificialAnalysisSnapshot({
    datasets: [datasets[0], { ...datasets[1], data: [] }, datasets[2]], indexVersion: '4.1.1', asOf: '2026-08-23',
    retrievedAt: '2026-08-23T00:00:00.000Z', sourceUrl: 'https://artificialanalysis.ai/',
  });
  assert.equal(result.taskCosts[0].answerTokens, null);
  assert.equal(result.taskCosts[0].outputTokens, null);
  assert.equal(result.taskCosts[0].totalCost, 0.26);
});
