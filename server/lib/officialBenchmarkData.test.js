import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BENCHMARK_CATEGORY_ORDER,
  classifyOfficialBenchmark,
  normalizeOfficialBenchmarks,
  officialComparisonKey,
} from './officialBenchmarkData.js';

const source = (vendor, model, scores, extra = {}) => ({
  vendor,
  status: 'ready',
  stale: false,
  model,
  releasedAt: '2026-08-20',
  sourceUrl: `https://official.example/${vendor.toLowerCase()}/${model.toLowerCase().replaceAll(' ', '-')}`,
  sourceLabel: `${vendor} official model card`,
  discoveryMode: 'official-docs',
  retrievedAt: '2026-08-23T00:00:00.000Z',
  scores,
  ...extra,
});

test('classifies exact tests by capability and pins Terminal-Bench first', () => {
  assert.deepEqual(BENCHMARK_CATEGORY_ORDER, ['Agent', 'Coding', 'Search & Tool Use', 'Reasoning & Knowledge', 'Multimodal', '其他']);
  assert.equal(classifyOfficialBenchmark('Terminal-Bench 2.1'), 'Agent');
  assert.equal(classifyOfficialBenchmark('SWE-bench Verified'), 'Coding');
  assert.equal(classifyOfficialBenchmark('BrowseComp'), 'Search & Tool Use');
  assert.equal(classifyOfficialBenchmark('GPQA Diamond'), 'Reasoning & Knowledge');
  assert.equal(classifyOfficialBenchmark('MMMU-Pro'), 'Multimodal');
  assert.equal(classifyOfficialBenchmark('Vendor Novel Eval'), '其他');
});

test('comparison keys separate exact versions/configurations and reject incomplete records', () => {
  assert.equal(officialComparisonKey({
    testName: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy', unit: 'percent-point', direction: 'higher',
    agent: 'Claude Code', effort: 'xhigh', configurationComplete: true,
  }), 'agent:terminal-bench:2.1:accuracy:claude-code:xhigh');
  assert.notEqual(
    officialComparisonKey({ testName: 'Terminal-Bench', testVersion: '2.0', scoreName: 'Accuracy', unit: 'percent-point', direction: 'higher', agent: 'Claude Code', effort: 'xhigh', configurationComplete: true }),
    officialComparisonKey({ testName: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy', unit: 'percent-point', direction: 'higher', agent: 'Claude Code', effort: 'xhigh', configurationComplete: true }),
  );
  assert.equal(officialComparisonKey({ testName: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy', unit: 'percent-point', direction: 'higher', configurationComplete: false }), null);
});

test('groups identical Terminal-Bench disclosures into one metric without inventing strict comparability', () => {
  const terminal = (value) => ({
    testName: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy', value,
    unit: 'percent-point', direction: 'higher', configurationComplete: false,
  });
  const result = normalizeOfficialBenchmarks({
    vendorCards: [
      source('Qwen', 'Qwen3.8', [terminal(86.6)]),
      source('Gemini', 'Gemini 3.7 Flash', [terminal(85.8)]),
      source('Kimi', 'Kimi K3', [terminal(88.3)]),
    ],
  });

  const terminalMetrics = result.metrics.filter((metric) => metric.label === 'Terminal-Bench 2.1 · Accuracy');
  assert.equal(terminalMetrics.length, 1);
  const [metric] = terminalMetrics;
  assert.deepEqual(result.models.map((model) => model.scores[metric.key]?.value), [86.6, 85.8, 88.3]);
  assert.equal(metric.comparable, false);
  assert.equal(result.winners[metric.key], undefined);
});

test('groups matching non-Agent official tests and derives a useful cross-vendor winner', () => {
  const gpqa = (value) => ({
    testName: 'GPQA', testVersion: 'Diamond', scoreName: 'Accuracy', value,
    unit: 'percent-point', direction: 'higher',
  });
  const result = normalizeOfficialBenchmarks({
    vendorCards: [
      source('OpenAI', 'GPT-5.6 Sol', [gpqa(91.2)]),
      source('Gemini', 'Gemini 3.7 Pro', [gpqa(92.4)]),
    ],
  });

  const gpqaMetrics = result.metrics.filter((metric) => metric.label === 'GPQA Diamond · Accuracy');
  assert.equal(gpqaMetrics.length, 1);
  const [metric] = gpqaMetrics;
  assert.equal(metric.comparable, true);
  assert.deepEqual(result.winners[metric.key], { models: ['Gemini 3.7 Pro'], value: 92.4 });
});

test('normalization preserves exact tests and produces strict winners, ties, lower-is-better, and missing latest models', () => {
  const terminal = (value, version = '2.1', complete = true) => ({
    testName: 'Terminal-Bench', testVersion: version, scoreName: 'Accuracy', value,
    unit: 'percent-point', direction: 'higher', agent: 'Claude Code', effort: 'xhigh', configurationComplete: complete,
  });
  const cards = [
    source('Anthropic', 'Claude Fable 5', [terminal(83.8), terminal(82.2, '2.0'), {
      testName: 'SWE-bench', testVersion: 'Verified', scoreName: 'Pass@1', value: 78,
      unit: 'percent-point', direction: 'higher', harness: 'official', passK: 1, configurationComplete: true,
    }, {
      testName: 'Vendor Novel Eval', testVersion: null, scoreName: 'Error', value: 1.5,
      unit: 'number', direction: 'lower', configurationComplete: true,
    }]),
    source('OpenAI', 'GPT 5.6 Sol', [terminal(82.5), terminal(82.2, '2.0'), {
      testName: 'SWE-bench', testVersion: 'Verified', scoreName: 'Pass@1', value: 78,
      unit: 'percent-point', direction: 'higher', harness: 'official', passK: 1, configurationComplete: true,
    }, {
      testName: 'Vendor Novel Eval', testVersion: null, scoreName: 'Error', value: 2,
      unit: 'number', direction: 'lower', configurationComplete: true,
    }, terminal(90, '2.1', false)]),
    source('Gemini', 'Gemini 3.7 Flash', []),
  ];

  const result = normalizeOfficialBenchmarks({ vendorCards: cards, asOf: '2026-08-23T00:00:00.000Z' });

  assert.equal(result.sourceMode, 'official-model-cards');
  const terminal21 = result.metrics.find((metric) => metric.testName === 'Terminal-Bench' && metric.testVersion === '2.1');
  const terminal20 = result.metrics.find((metric) => metric.testName === 'Terminal-Bench' && metric.testVersion === '2.0');
  const swe = result.metrics.find((metric) => metric.testName === 'SWE-bench');
  assert.deepEqual(result.winners[terminal21.key], { models: ['Claude Fable 5'], value: 83.8 });
  assert.deepEqual(result.winners[terminal20.key], { models: ['Claude Fable 5', 'GPT 5.6 Sol'], value: 82.2 });
  assert.deepEqual(result.winners[swe.key], { models: ['Claude Fable 5', 'GPT 5.6 Sol'], value: 78 });
  const lowerMetric = result.metrics.find((metric) => metric.testName === 'Vendor Novel Eval');
  assert.equal(result.winners[lowerMetric.key].value, 1.5);
  assert.equal(result.metrics.filter((metric) => metric.testName === 'Terminal-Bench' && metric.testVersion === '2.1').length, 1);
  assert.equal(result.metrics[0].testFamily, 'Terminal-Bench');
  assert.equal(result.metrics[0].category, 'Agent');
  assert.equal(result.models.find((model) => model.vendor === 'Gemini').model, 'Gemini 3.7 Flash');
  assert.deepEqual(result.models.find((model) => model.vendor === 'Gemini').scores, {});
  assert.deepEqual(result.coverage, { vendors: 3, disclosedVendors: 2, metrics: 4, comparableMetrics: 4 });
  assert.equal(result.attributions.every((row) => row.source === 'official-model-card'), true);
});

test('Fable and Mythos names remain eligible for winners', () => {
  const score = (value) => ({
    testName: 'GPQA', testVersion: 'Diamond', scoreName: 'Accuracy', value,
    unit: 'percent-point', direction: 'higher', shots: 0, configurationComplete: true,
  });
  const result = normalizeOfficialBenchmarks({
    vendorCards: [source('Anthropic', 'Claude Fable 5', [score(88)]), source('OpenAI', 'Mythos 5', [score(87)])],
    asOf: '2026-08-23T00:00:00.000Z',
  });
  assert.deepEqual(Object.values(result.winners)[0].models, ['Claude Fable 5']);
});
