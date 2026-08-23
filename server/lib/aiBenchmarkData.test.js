import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalModelSlug,
  normalizeOnlineBenchmarks,
  selectLatestCatalogModels,
  vendorLabel,
} from './aiBenchmarkData.js';

const catalog = [
  { id: 'openai/gpt-old', name: 'GPT Old', created: 100, architecture: { output_modalities: ['text'] } },
  { id: 'openai/gpt-new', name: 'GPT New', created: 200, architecture: { output_modalities: ['text'] } },
  { id: 'openai/gpt-new:free', name: 'GPT New Free', created: 300, architecture: { output_modalities: ['text'] } },
  { id: 'anthropic/claude-old', name: 'Claude Old', created: 110, architecture: { output_modalities: ['text'] } },
  { id: 'anthropic/claude-new', name: 'Claude New', created: 250, architecture: { output_modalities: ['text'] } },
  { id: 'anthropic/image-newer', name: 'Image Newer', created: 400, architecture: { output_modalities: ['image'] } },
  { id: 'meta-llama/llama-new', name: 'Llama New', created: 180, architecture: { output_modalities: ['text'] } },
];

const benchmarkRows = [
  { source: 'artificial-analysis', model_permaslug: 'openai/gpt-new', intelligence_index: 71.2 },
  { source: 'artificial-analysis', model_permaslug: 'anthropic/claude-old', intelligence_index: 80 },
  { source: 'artificial-analysis', model_permaslug: 'meta-llama/llama-new', intelligence_index: 71.2 },
];

const feishuModels = [{
  vendor: 'Fable',
  model: 'Fable 5',
  releasedAt: '2026-08-01',
  scores: { Legacy: { value: 0.99, direction: 'higher', metric: '旧口径' } },
  sourceLabel: '飞书模型基准测试',
}];

test('canonical model selection ignores route variants and keeps an unevaluated latest text model', () => {
  assert.equal(canonicalModelSlug('openai/gpt-new:free'), 'openai/gpt-new');
  assert.equal(vendorLabel('meta-llama/llama-new'), 'Meta');
  assert.equal(vendorLabel('meta/muse-new'), 'Meta');

  const selected = selectLatestCatalogModels(catalog, benchmarkRows, feishuModels);

  assert.deepEqual(selected.map(({ vendor, modelSlug }) => [vendor, modelSlug]), [
    ['Anthropic', 'anthropic/claude-new'],
    ['Meta', 'meta-llama/llama-new'],
    ['OpenAI', 'openai/gpt-new'],
  ]);
  assert.equal(selected.find((row) => row.vendor === 'Anthropic').scores && Object.keys(selected.find((row) => row.vendor === 'Anthropic').scores).length, 0);
  assert.equal(selected.find((row) => row.vendor === 'OpenAI').releasedAt, '1970-01-01');
});

test('normalizes all OpenRouter benchmark source shapes without merging unlike metric configurations', () => {
  const normalized = normalizeOnlineBenchmarks({
    catalog,
    benchmarkPayload: {
      data: [
        { source: 'artificial-analysis', model_permaslug: 'openai/gpt-new', intelligence_index: 71.2, coding_index: 65.8, agentic_index: 58.3 },
        { source: 'artificial-analysis', model_permaslug: 'meta-llama/llama-new', intelligence_index: 71.2, coding_index: 60, agentic_index: 50 },
        { source: 'artificial-analysis', model_permaslug: 'anthropic/claude-old', intelligence_index: 80 },
        { source: 'design-arena', model_permaslug: 'openai/gpt-new', arena: 'models', category: 'dataviz', elo: 1200, win_rate: 48.1, rank: 4 },
        { source: 'design-arena', model_permaslug: 'meta-llama/llama-new', arena: 'models', category: 'dataviz', elo: 1190, win_rate: 47, rank: 5 },
        { source: 'design-arena', model_permaslug: 'openai/gpt-new', arena: 'agents', category: 'dataviz', elo: 1100, win_rate: 44, rank: 7 },
        { source: 'openrouter', model_permaslug: 'openai/gpt-new', benchmark_type: 'gpqa_diamond', accuracy: 0.72, accuracy_stddev: 0.03, avg_cost_per_task: 0.002, total_tasks: 300, last_run_timestamp: '2026-08-22T12:00:00Z' },
        { source: 'openrouter', model_permaslug: 'meta-llama/llama-new', benchmark_type: 'gpqa_diamond', accuracy: 0.7, avg_cost_per_task: 0.001, total_tasks: 300, last_run_timestamp: '2026-08-22T12:00:00Z' },
      ],
      meta: { as_of: '2026-08-23T00:00:00Z', version: 'v1' },
    },
    feishuModels,
  });

  assert.equal(normalized.asOf, '2026-08-23T00:00:00Z');
  assert.equal(normalized.sourceMode, 'openrouter');
  assert.deepEqual(normalized.coverage, { vendors: 3, evaluatedVendors: 2, metrics: 11 });
  assert.ok(normalized.metrics.some((metric) => metric.key === 'artificial-analysis:intelligence_index' && metric.unit === 'index'));
  assert.ok(normalized.metrics.some((metric) => metric.key === 'design-arena:models:dataviz:elo' && metric.direction === 'higher'));
  assert.ok(normalized.metrics.some((metric) => metric.key === 'design-arena:agents:dataviz:elo'));
  assert.ok(normalized.metrics.some((metric) => metric.key === 'design-arena:models:dataviz:rank' && metric.direction === 'lower'));
  assert.ok(normalized.metrics.some((metric) => metric.key === 'openrouter:gpqa_diamond:accuracy' && metric.unit === 'percent'));
  assert.ok(normalized.metrics.some((metric) => metric.key === 'openrouter:gpqa_diamond:avg_cost_per_task' && metric.direction === 'lower'));
  assert.equal(normalized.metrics.some((metric) => metric.key === 'feishu:Legacy'), false);

  const openAi = normalized.models.find((model) => model.vendor === 'OpenAI');
  assert.deepEqual(openAi.scores['openrouter:gpqa_diamond:accuracy'], {
    value: 0.72,
    asOf: '2026-08-22T12:00:00Z',
    sampleSize: 300,
    standardDeviation: 0.03,
    source: 'openrouter',
    sourceUrl: 'https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks',
  });
  assert.deepEqual(normalized.winners['artificial-analysis:intelligence_index'], ['GPT New', 'Llama New']);
  assert.deepEqual(normalized.winners['design-arena:models:dataviz:rank'], ['GPT New']);
  assert.equal(normalized.winners['feishu:Legacy'], undefined);
  assert.equal(normalized.attributions.length, 3);
});

test('keeps only the configured investment vendors and uses portfolio-facing labels', () => {
  const allowedCatalog = [
    ['anthropic/claude', 'Anthropic'],
    ['openai/gpt', 'OpenAI'],
    ['google/gemini', 'Gemini'],
    ['z-ai/glm', '智谱'],
    ['minimax/minimax', 'MiniMax'],
    ['qwen/qwen', 'Qwen'],
    ['xiaomi/mimo', 'Mimo'],
    ['deepseek/deepseek', 'DeepSeek'],
    ['moonshotai/kimi', 'Kimi'],
    ['meta/llama', 'Meta'],
    ['tencent/hunyuan', 'Tencent'],
    ['x-ai/grok', 'xAI'],
  ].map(([id, name], index) => ({
    id,
    name,
    created: index + 1,
    architecture: { output_modalities: ['text'] },
  }));
  const selected = selectLatestCatalogModels(
    [
      ...allowedCatalog,
      { id: 'amazon/nova', name: 'Nova', created: 100, architecture: { output_modalities: ['text'] } },
    ],
    [{ source: 'artificial-analysis', model_permaslug: 'amazon/nova', intelligence_index: 90 }],
    [{ vendor: 'Fable', model: 'Mythos', releasedAt: '2026-08-01', scores: { Legacy: { value: 0.9 } } }],
  );

  assert.equal(selected.length, 12);
  assert.deepEqual(new Set(selected.map((model) => model.vendor)), new Set([
    'Anthropic', 'OpenAI', 'Gemini', '智谱', 'MiniMax', 'Qwen',
    'Mimo', 'DeepSeek', 'Kimi', 'Meta', 'Tencent', 'xAI',
  ]));
  assert.equal(selected.some((model) => ['Amazon', 'Fable'].includes(model.vendor)), false);
});

test('does not assign an older model score to the vendor latest model', () => {
  const normalized = normalizeOnlineBenchmarks({
    catalog,
    benchmarkPayload: {
      data: [{ source: 'artificial-analysis', model_permaslug: 'anthropic/claude-old', intelligence_index: 80 }],
      meta: { as_of: '2026-08-23T00:00:00Z', version: 'v1' },
    },
    feishuModels: [],
  });

  const anthropic = normalized.models.find((model) => model.vendor === 'Anthropic');
  assert.equal(anthropic.model, 'Claude New');
  assert.deepEqual(anthropic.scores, {});
  assert.equal(normalized.coverage.evaluatedVendors, 0);
});

test('matches OpenRouter benchmark dated permaslugs to the same catalog model', () => {
  const normalized = normalizeOnlineBenchmarks({
    catalog,
    benchmarkPayload: {
      data: [{
        source: 'artificial-analysis',
        model_permaslug: 'openai/gpt-new-20260823',
        intelligence_index: 75.4,
      }],
      meta: { as_of: '2026-08-23T00:00:00Z', version: 'v1' },
    },
    feishuModels: [],
  });

  const openAi = normalized.models.find((model) => model.vendor === 'OpenAI');
  assert.equal(openAi.scores['artificial-analysis:intelligence_index'].value, 75.4);
  assert.equal(normalized.coverage.evaluatedVendors, 1);
});
