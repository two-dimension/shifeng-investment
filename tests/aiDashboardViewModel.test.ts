import assert from 'node:assert/strict';
import test from 'node:test';
import * as dashboardViewModel from '../src/pages/AIDashboard/viewModel.ts';
import {
  benchmarkRefreshRequest,
  benchmarkMetricDisplayLabel,
  benchmarkModelEffortLabel,
  benchmarkScoreRunLabel,
  terminalBenchmarkRunLabel,
  topBenchmarkScoreRows,
  benchmarkDisclosureKey,
  dashboardSourceSummary,
  formatBenchmarkValue,
  formatCurrencyPrice,
  formatPriceChange,
  formatTaskCostComponents,
  formatTaskTokenBreakdown,
  formatTokenCount,
  formatUsd,
  groupOfficialBenchmarkMetrics,
  officialWinnerRows,
  officialBenchmarkSummaryRows,
  sourceStatusLabel,
} from '../src/pages/AIDashboard/viewModel.ts';

const metricFixture = [
  {
    key: 'swe', category: 'Coding' as const, group: 'Coding', label: 'SWE-bench Verified · Pass@1',
    testName: 'SWE-bench', testFamily: 'SWE-bench', testVersion: 'Verified', scoreName: 'Pass@1',
    unit: 'percent-point', direction: 'higher' as const, comparable: true, priority: 1, sourceOrder: 1,
    harness: 'official', source: 'official-model-card',
  },
  {
    key: 'terminal', category: 'Agent' as const, group: 'Agent', label: 'Terminal-Bench 2.1 · Accuracy',
    testName: 'Terminal-Bench', testFamily: 'Terminal-Bench', testVersion: '2.1', scoreName: 'Accuracy',
    unit: 'percent-point', direction: 'higher' as const, comparable: true, priority: 0, sourceOrder: 0,
    agent: 'Claude Code', effort: 'xhigh', source: 'official-model-card',
  },
  {
    key: 'gpqa', category: 'Reasoning & Knowledge' as const, group: 'Reasoning & Knowledge', label: 'GPQA Diamond · Accuracy',
    testName: 'GPQA', testFamily: 'GPQA', testVersion: 'Diamond', scoreName: 'Accuracy',
    unit: 'percent-point', direction: 'higher' as const, comparable: true, priority: 1, sourceOrder: 2,
    source: 'official-model-card',
  },
  {
    key: 'novel', category: '其他' as const, group: '其他', label: 'Vendor Novel Eval · Accuracy',
    testName: 'Vendor Novel Eval', testFamily: 'Vendor Novel Eval', testVersion: null, scoreName: 'Accuracy',
    unit: 'percent-point', direction: 'higher' as const, comparable: false, priority: 1, sourceOrder: 3,
    source: 'official-model-card',
  },
];

test('entering the Benchmark tab requests a scoped fresh official-model-card refresh', () => {
  assert.deepEqual(benchmarkRefreshRequest('benchmark'), { sources: ['benchmarks'], force: true });
  assert.equal(benchmarkRefreshRequest('pricing'), null);
});

test('benchmark formatter respects metric units and missing values', () => {
  assert.equal(formatBenchmarkValue({ value: 0.72 }, { unit: 'percent' }), '72.0%');
  assert.equal(formatBenchmarkValue({ value: 1200 }, { unit: 'elo' }), '1,200');
  assert.equal(formatBenchmarkValue({ value: 4 }, { unit: 'rank' }), '#4');
  assert.equal(formatBenchmarkValue({ value: 71.234 }, { unit: 'index' }), '71.2%');
  assert.equal(formatBenchmarkValue(null, { unit: 'index' }), '—');
});

test('groups exact benchmark names with Terminal-Bench first', () => {
  const groups = groupOfficialBenchmarkMetrics(metricFixture);
  assert.deepEqual(groups.map((group) => group.category), ['Agent', 'Coding', 'Reasoning & Knowledge', '其他']);
  assert.equal(groups[0].metrics[0].label, 'Terminal-Bench 2.1 · Accuracy');
  assert.equal(groups[0].metrics[0].testName, 'Terminal-Bench');
  assert.equal(groups[1].metrics[0].testVersion, 'Verified');
});

test('puts metrics disclosed by more vendors before sparse metrics in each category', () => {
  const groups = groupOfficialBenchmarkMetrics([
    { ...metricFixture[0], key: 'sparse', label: 'Sparse', sourceOrder: 0, scoreCount: 1 },
    { ...metricFixture[0], key: 'shared', label: 'Shared', sourceOrder: 9, scoreCount: 4 },
  ]);
  assert.deepEqual(groups[0].metrics.map((metric) => metric.key), ['shared', 'sparse']);
});

test('formats per-model benchmark run configurations without pretending missing values match', () => {
  assert.equal(benchmarkScoreRunLabel({ agent: 'Claude Code', harness: null, effort: 'xhigh', shots: null, passK: null, tools: null }), 'Agent: Claude Code · Effort: xhigh');
  assert.equal(benchmarkScoreRunLabel({}), '配置未完整披露');
});

test('Terminal-Bench cards omit the redundant Accuracy suffix', () => {
  assert.equal(benchmarkMetricDisplayLabel(metricFixture[1]), 'Terminal-Bench 2.1');
  assert.equal(benchmarkMetricDisplayLabel(metricFixture[2]), 'GPQA Diamond · Accuracy');
});

test('Terminal-Bench model labels put a normalized effort immediately after the model name', () => {
  assert.equal(benchmarkModelEffortLabel('GPT-5.6 Sol', 'ultra'), 'GPT-5.6 Sol（Ultra）');
  assert.equal(benchmarkModelEffortLabel('GPT-5.6 Sol', 'max'), 'GPT-5.6 Sol（Max）');
  assert.equal(benchmarkModelEffortLabel('Kimi K3', null), 'Kimi K3');
  assert.equal(
    terminalBenchmarkRunLabel({ agent: '4-agent', effort: 'ultra', tools: 'terminal' }),
    'Tools: terminal',
  );
  assert.equal(terminalBenchmarkRunLabel({ agent: '4-agent', effort: 'ultra' }), null);
  assert.equal(terminalBenchmarkRunLabel({ effort: 'ultra' }), null);
});

test('Terminal-Bench cards keep only the three best score rows', () => {
  const rows = [
    { model: 'Fourth', score: { value: 71 } },
    { model: 'Second', score: { value: 91 } },
    { model: 'First', score: { value: 93 } },
    { model: 'Third', score: { value: 88 } },
  ];
  assert.deepEqual(
    topBenchmarkScoreRows(rows, 'higher').map((row) => row.model),
    ['First', 'Second', 'Third'],
  );
  assert.deepEqual(
    topBenchmarkScoreRows(rows, 'lower').map((row) => row.model),
    ['Fourth', 'Third', 'Second'],
  );
});

test('Agent and Harness roles stay distinct in labels and disclosure row keys', () => {
  const agent = { value: 83, agent: 'Codex', configurationComplete: false };
  const harness = { value: 83, harness: 'Codex', configurationComplete: false };
  assert.equal(benchmarkScoreRunLabel(agent), 'Agent: Codex');
  assert.equal(benchmarkScoreRunLabel(harness), 'Harness: Codex');
  assert.notEqual(benchmarkDisclosureKey(agent), benchmarkDisclosureKey(harness));
});

test('winner rows retain exact tests, winning scores, ties, and run configurations', () => {
  const rows = officialWinnerRows({
    models: [], metrics: metricFixture,
    winners: {
      terminal: { models: ['Claude Opus 5'], value: 83.8 },
      swe: { models: ['Claude Opus 5', 'GPT-5.6 Sol'], value: 78 },
    },
    vendorSources: [], asOf: '2026-08-23', sourceMode: 'official-model-cards',
    coverage: { vendors: 12, disclosedVendors: 8, metrics: 4, comparableMetrics: 3 }, attributions: [],
  });
  assert.deepEqual(rows[0], {
    category: 'Agent', metricKey: 'terminal', label: 'Terminal-Bench 2.1 · Accuracy',
    testName: 'Terminal-Bench', testVersion: '2.1', models: ['Claude Opus 5'],
    formattedValue: '83.8%', runLabel: 'Agent: Claude Code · Effort: xhigh', terminalBench: true,
    direction: 'higher', comparable: true,
  });
  assert.deepEqual(rows[1].models, ['Claude Opus 5', 'GPT-5.6 Sol']);
  assert.equal(rows.some((row) => /Artificial Analysis|Design Arena|OpenRouter Evals|飞书口径/.test(row.label)), false);
});

test('winner rows ignore legacy aggregate winner arrays instead of crashing the Benchmark tab', () => {
  const rows = officialWinnerRows({
    models: [], metrics: metricFixture,
    winners: {
      terminal: ['Legacy aggregate winner'],
    } as unknown as Record<string, { models: string[]; value: number }>,
    vendorSources: [], asOf: '2026-08-23', sourceMode: 'official-model-cards',
    coverage: { vendors: 0, disclosedVendors: 0, metrics: 4, comparableMetrics: 0 }, attributions: [],
  });

  assert.deepEqual(rows, []);
});

test('non-comparable vendor disclosures produce an explicitly non-strict disclosed-highest summary', () => {
  const metrics = [{ ...metricFixture[2], comparable: false, comparisonNote: '旧快照配置未知' }];
  const rows = officialBenchmarkSummaryRows({
    models: [
      { vendor: 'OpenAI', model: 'GPT Latest', releasedAt: null, scores: { gpqa: { value: 91 } } },
      { vendor: 'Gemini', model: 'Gemini Latest', releasedAt: null, scores: { gpqa: { value: 92 } } },
    ],
    metrics,
    winners: {}, vendorSources: [], asOf: '2026-08-23', sourceMode: 'official-model-cards',
    coverage: { vendors: 2, disclosedVendors: 2, metrics: 1, comparableMetrics: 0 }, attributions: [],
  });

  assert.deepEqual(rows, [{
    category: 'Reasoning & Knowledge',
    metricKey: 'gpqa',
    label: 'GPQA Diamond · Accuracy',
    testName: 'GPQA',
    testVersion: 'Diamond',
    models: ['Gemini Latest'],
    formattedValue: '92.0%',
    runLabel: '官网披露最高 · 运行配置不同，不作严格排名',
    terminalBench: false,
    direction: 'higher',
    comparable: false,
  }]);
});

test('single-task formatters expose token and cost formulas without inventing missing values', () => {
  assert.equal(formatTaskTokenBreakdown({ answerTokens: 3200, reasoningTokens: 6800, outputTokens: 10000 }), 'Answer 3,200 + Reasoning 6,800 = 10,000 Tokens');
  assert.equal(formatTaskTokenBreakdown({ answerTokens: null, reasoningTokens: null, outputTokens: null }), 'Token 明细未公开');
  assert.equal(formatTaskCostComponents({
    inputCost: 0.02, cacheHitCost: 0.03, cacheWriteCost: 0.01,
    reasoningCost: 0.12, answerCost: 0.08, totalCost: 0.26, currency: 'USD',
  }), 'Input $0.0200 + Cache hit $0.0300 + Cache write $0.0100 + Reasoning $0.1200 + Answer $0.0800 = $0.2600');
});

test('token formatter keeps 64-bit values readable without converting through Number first', () => {
  assert.equal(formatTokenCount('1250000000000'), '1.25T');
  assert.equal(formatTokenCount('9007199254740993'), '9.01P');
  assert.equal(formatTokenCount('0'), '0');
});

test('USD formatter preserves zero and distinguishes unavailable values', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(2.5), '$2.50');
  assert.equal(formatUsd(null), '—');
});

test('pricing formatter preserves CNY/USD currency and renders official same-SKU changes', () => {
  assert.equal(formatCurrencyPrice(29, 'CNY'), '¥29.00');
  assert.equal(formatCurrencyPrice(2.5, 'USD'), '$2.50');
  assert.equal(formatCurrencyPrice(null, 'CNY'), '—');
  assert.equal(formatPriceChange({ oldPrice: 10, newPrice: 8, percentDelta: -0.2, currency: 'CNY' }), '¥10.00 → ¥8.00（-20.0%）');
});

test('ARR and Token delta formatters preserve sign, unit, percent, zero, and unavailable values', () => {
  assert.equal(dashboardViewModel.formatArrDelta?.(30, 0.5), '+30 亿美元（+50.0%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(-5, -0.125), '-5 亿美元（-12.5%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(0, 0), '0 亿美元（0.0%）');
  assert.equal(dashboardViewModel.formatArrDelta?.(null, null), '—');

  assert.equal(dashboardViewModel.formatTokenDelta?.('1250000000000', 0.25), '+1.25T Tokens（+25.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.('-500000000', -0.1), '-500M Tokens（-10.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.('0', 0), '0 Tokens（0.0%）');
  assert.equal(dashboardViewModel.formatTokenDelta?.(null, null), '—');
});

test('source status labels distinguish fresh, partially retained, fallback, authorization, and failed states', () => {
  assert.equal(sourceStatusLabel({ status: 'ready', stale: false }), '已同步');
  assert.equal(sourceStatusLabel({ status: 'ready', stale: true }), '部分沿用旧值');
  assert.equal(sourceStatusLabel({ status: 'error', stale: true }), '使用上一版');
  assert.equal(sourceStatusLabel({ status: 'authorization_required', stale: true }), '待授权');
  assert.equal(sourceStatusLabel({ status: 'error', stale: false }), '同步失败');
});

test('dashboard source summary counts every state that needs attention', () => {
  assert.deepEqual(dashboardSourceSummary([
    { status: 'ready', stale: false },
    { status: 'ready', stale: false },
  ]), { attentionCount: 0, label: '状态正常', color: 'success' });

  assert.deepEqual(dashboardSourceSummary([
    { status: 'ready', stale: false },
    { status: 'ready', stale: true },
  ]), { attentionCount: 1, label: '1项需关注', color: 'warning' });

  assert.deepEqual(dashboardSourceSummary([
    { status: 'authorization_required', stale: false },
    { status: 'error', stale: false },
  ]), { attentionCount: 2, label: '2项需关注', color: 'warning' });
});

test('dashboard source entries map all eight public slices without exposing Feishu', () => {
  const ready = { status: 'ready' as const, stale: false, asOf: '2026-08-22' };
  const sources = {
    growth: ready,
    openRouter: ready,
    pricing: ready,
    capital: ready,
    benchmarks: ready,
    artificialAnalysis: ready,
    compute: ready,
    creditRisk: ready,
  };

  assert.deepEqual(dashboardViewModel.dashboardSourceEntries?.(sources).map(({ key, label }) => [key, label]), [
    ['growth', '增长与估值'],
    ['openRouter', 'OpenRouter 流量'],
    ['pricing', '模型与套餐价格'],
    ['capital', '融资与债务'],
    ['benchmarks', '厂商官网模型卡'],
    ['artificialAnalysis', 'AA Index'],
    ['compute', '算力租赁'],
    ['creditRisk', '5Y CDS'],
  ]);
  assert.equal('feishu' in sources, false);
});

test('dashboard source entries tolerate an older backend response during a rolling restart', () => {
  const ready = { status: 'ready' as const, stale: false, asOf: '2026-08-22' };
  const legacySources = {
    growth: ready,
    openRouter: ready,
    pricing: ready,
    capital: ready,
    benchmarks: ready,
    artificialAnalysis: ready,
    compute: ready,
  } as Parameters<typeof dashboardViewModel.dashboardSourceEntries>[0];

  assert.doesNotThrow(() => dashboardViewModel.dashboardSourceEntries(legacySources));
  assert.equal(dashboardViewModel.dashboardSourceEntries(legacySources).some(({ key }) => key === 'creditRisk'), false);
});

test('public dashboard mode hides the separate session controls', () => {
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(true), false);
  assert.equal(dashboardViewModel.showDashboardSessionControls?.(false), true);
});

test('cache hit range never renders missing values as null percentages', () => {
  assert.equal(dashboardViewModel.formatCacheHitRange?.(null, null, false), '待补录');
  assert.equal(dashboardViewModel.formatCacheHitRange?.(20, 80, true), '20%–80%');
});

test('methodology tooltip keeps method, source, date, and commentary in investment-reading order', () => {
  assert.deepEqual(dashboardViewModel.methodologyTooltip?.({
    sourceLabel: 'Yipit',
    sourceUrl: 'https://example.test/yipit',
    sourceKind: 'estimate',
    asOf: '2026-08-01',
    retrievedAt: '2026-08-23T00:00:00Z',
    methodology: 'ARR estimate',
    commentary: 'Monthly observation',
    stale: false,
  }), [
    '数据口径：ARR estimate',
    '数据来源：Yipit',
    '数据日期：2026-08-01',
    '点评：Monthly observation',
  ]);
});
