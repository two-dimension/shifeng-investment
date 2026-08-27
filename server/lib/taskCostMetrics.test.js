import assert from 'node:assert/strict';
import test from 'node:test';
import { attachOfficialTaskCosts, calculateTaskCost } from './taskCostMetrics.js';

test('calculates exact token components without silently folding cached input into input', () => {
  assert.deepEqual(calculateTaskCost({
    inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000,
    price: { input: 2, cachedInput: 0.2, output: 10, currency: 'USD', perTokens: 1_000_000 },
  }), { inputCost: 2, cachedInputCost: 0.04, outputCost: 1, totalCost: 3.04, currency: 'USD' });
  assert.equal(calculateTaskCost({ inputTokens: null, cachedInputTokens: 0, outputTokens: 1, price: {} }), null);
  assert.equal(calculateTaskCost({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, price: { input: 1, output: null } }), null);
});

test('joins a task only to the latest same-model official price not later than the run', () => {
  const run = {
    taskName: 'Terminal-Bench', taskVersion: '2.1', harness: 'Codex', vendor: 'OpenAI', model: 'GPT-5.6 Sol',
    asOf: '2026-08-20', inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000,
    contextTier: 'standard', serviceTier: 'standard',
  };
  const price = (asOf, inputPrice) => ({
    vendor: 'OpenAI', model: 'GPT-5.6 Sol', asOf, inputPrice, cacheReadPrice: 0.2, outputPrice: 10,
    currency: 'USD', priceUnit: 'per_million_tokens', contextTier: 'standard', serviceTier: 'standard',
    sourceUrl: 'https://platform.openai.com/pricing', sourceLabel: 'OpenAI 官网',
  });
  const [result] = attachOfficialTaskCosts({ runs: [run], prices: [price('2026-08-01', 2), price('2026-08-21', 1)] });

  assert.equal(result.status, 'ready');
  assert.equal(result.priceAsOf, '2026-08-01');
  assert.equal(result.totalCost, 3.04);
  assert.equal(result.comparableTaskKey, 'terminal-bench|2.1|codex');
});

test('rejects missing, future-only, and incompatible task/pricing records', () => {
  const baseRun = { taskName: 'Task', taskVersion: '1', harness: 'Harness', vendor: 'A', model: 'M', asOf: '2026-08-20', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
  const future = { vendor: 'A', model: 'M', asOf: '2026-08-21', inputPrice: 1, cacheReadPrice: 1, outputPrice: 1, currency: 'USD', priceUnit: 'per_million_tokens' };
  assert.equal(attachOfficialTaskCosts({ runs: [baseRun], prices: [future] })[0].status, 'price_unavailable');
  assert.equal(attachOfficialTaskCosts({ runs: [{ ...baseRun, harness: null }], prices: [] })[0].comparableTaskKey, null);
  assert.equal(attachOfficialTaskCosts({ runs: [{ ...baseRun, outputTokens: null }], prices: [] })[0].status, 'tokens_unavailable');
});
