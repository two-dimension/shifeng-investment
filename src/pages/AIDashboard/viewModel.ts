import type {
  BenchmarkMetricDefinition,
  BenchmarkScore,
  AiDashboardSnapshot,
  ArtificialAnalysisTaskCost,
  DashboardSourceKey,
  MetricProvenance,
  SourceStatus,
} from './types';

const DASHBOARD_SOURCE_DEFINITIONS: ReadonlyArray<{ key: DashboardSourceKey; label: string }> = [
  { key: 'growth', label: '增长与估值' },
  { key: 'openRouter', label: 'OpenRouter 流量' },
  { key: 'pricing', label: '模型与套餐价格' },
  { key: 'capital', label: '融资与债务' },
  { key: 'benchmarks', label: '厂商官网模型卡' },
  { key: 'artificialAnalysis', label: 'AA Index' },
  { key: 'compute', label: '算力租赁' },
  { key: 'creditRisk', label: '5Y CDS' },
];

const TOKEN_UNITS: Array<{ divisor: bigint; suffix: string }> = [
  { divisor: 1_000_000_000_000_000_000n, suffix: 'E' },
  { divisor: 1_000_000_000_000_000n, suffix: 'P' },
  { divisor: 1_000_000_000_000n, suffix: 'T' },
  { divisor: 1_000_000_000n, suffix: 'B' },
  { divisor: 1_000_000n, suffix: 'M' },
  { divisor: 1_000n, suffix: 'K' },
];

export function formatTokenCount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  let tokens: bigint;
  try {
    tokens = BigInt(value || '0');
  } catch {
    return '—';
  }
  if (tokens === 0n) return '0';
  const sign = tokens < 0n ? '-' : '';
  const absolute = tokens < 0n ? -tokens : tokens;
  const unit = TOKEN_UNITS.find(({ divisor }) => absolute >= divisor);
  if (!unit) return tokens.toString();
  const roundedHundredths = (absolute * 100n + unit.divisor / 2n) / unit.divisor;
  const whole = roundedHundredths / 100n;
  const fraction = String(roundedHundredths % 100n).padStart(2, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}${unit.suffix}`;
}

function signedPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const percent = value * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

export function formatArrDelta(value: number | null | undefined, percent: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  const change = `${value > 0 ? '+' : ''}${formatted} 亿美元`;
  const percentage = signedPercent(percent);
  return percentage ? `${change}（${percentage}）` : change;
}

export function formatTokenDelta(value: string | null | undefined, percent: number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return '—';
  }
  const change = `${parsed > 0n ? '+' : ''}${formatTokenCount(value)} Tokens`;
  const percentage = signedPercent(percent);
  return percentage ? `${change}（${percentage}）` : change;
}

export function formatUsd(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `$${value.toFixed(digits)}`;
}

export function formatCurrencyPrice(
  value: number | null | undefined,
  currency: string | null | undefined,
  digits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const code = String(currency || '').toUpperCase();
  const prefix = code === 'USD' ? '$' : code === 'CNY' ? '¥' : code ? `${code} ` : '';
  return `${prefix}${value.toFixed(digits)}`;
}

export function formatPriceChange(event: {
  oldPrice: number;
  newPrice: number;
  percentDelta: number | null;
  currency: string;
}): string {
  const percent = signedPercent(event.percentDelta);
  return `${formatCurrencyPrice(event.oldPrice, event.currency)} → ${formatCurrencyPrice(event.newPrice, event.currency)}${percent ? `（${percent}）` : ''}`;
}

export function formatMultiple(low: number | null, high: number | null): string {
  if (low === null || high === null) return '—';
  return Math.abs(low - high) < 0.001 ? `${low.toFixed(1)}x` : `${low.toFixed(1)}–${high.toFixed(1)}x`;
}

export function formatCacheHitRange(low: number | null, high: number | null, valid: boolean): string {
  if (low === null && high === null) return '待补录';
  if (!valid || low === null || high === null) return '区间异常';
  return `${low}%–${high}%`;
}

export function sourceStatusLabel(source: Pick<SourceStatus, 'status' | 'stale'>): string {
  if (source.status === 'authorization_required') return '待授权';
  if (source.status === 'error' && source.stale) return '使用上一版';
  if (source.status === 'error') return '同步失败';
  if (source.stale) return '部分沿用旧值';
  return '已同步';
}

export function sourceStatusColor(source: Pick<SourceStatus, 'status' | 'stale'>): 'success' | 'warning' | 'error' | 'default' {
  if (source.status === 'ready' && !source.stale) return 'success';
  if (source.status === 'authorization_required') return 'default';
  if (source.stale) return 'warning';
  return 'error';
}

export function dashboardSourceSummary(
  sources: ReadonlyArray<Pick<SourceStatus, 'status' | 'stale'>>,
): { attentionCount: number; label: string; color: 'success' | 'warning' } {
  const attentionCount = sources.filter((source) => source.status !== 'ready' || source.stale).length;
  return attentionCount > 0
    ? { attentionCount, label: `${attentionCount}项需关注`, color: 'warning' }
    : { attentionCount, label: '状态正常', color: 'success' };
}

export function dashboardSourceEntries(sources: Record<DashboardSourceKey, SourceStatus>) {
  return DASHBOARD_SOURCE_DEFINITIONS.flatMap(({ key, label }) => (
    sources[key] ? [{ key, label, source: sources[key] }] : []
  ));
}

export function methodologyTooltip(
  provenance: Pick<MetricProvenance, 'methodology' | 'sourceLabel' | 'asOf' | 'commentary'>,
): string[] {
  return [
    `数据口径：${provenance.methodology}`,
    `数据来源：${provenance.sourceLabel}`,
    `数据日期：${provenance.asOf}`,
    provenance.commentary ? `点评：${provenance.commentary}` : null,
  ].filter((line): line is string => line !== null);
}

export function showDashboardSessionControls(publicAccess: boolean | undefined): boolean {
  return publicAccess !== true;
}

export function benchmarkRefreshRequest(activeTab: string): { sources: ['benchmarks']; force: false } | null {
  return activeTab === 'benchmark' ? { sources: ['benchmarks'], force: false } : null;
}

export function formatBenchmarkValue(
  score: Pick<BenchmarkScore, 'value'> | null | undefined,
  metric: Pick<BenchmarkMetricDefinition, 'unit'>,
): string {
  if (!score || !Number.isFinite(score.value)) return '—';
  if (metric.unit === 'percent') return `${(score.value * 100).toFixed(1)}%`;
  if (metric.unit === 'percent-point') return `${score.value.toFixed(1)}%`;
  if (metric.unit === 'elo') return Math.round(score.value).toLocaleString('en-US');
  if (metric.unit === 'rank') return `#${Math.round(score.value)}`;
  if (metric.unit === 'usd') return formatUsd(score.value, score.value < 0.01 ? 4 : 2);
  if (metric.unit === 'index') return `${score.value.toFixed(1)}%`;
  return Number.isInteger(score.value) ? score.value.toLocaleString('en-US') : score.value.toFixed(1);
}

const OFFICIAL_BENCHMARK_CATEGORY_ORDER = [
  'Agent', 'Coding', 'Search & Tool Use', 'Reasoning & Knowledge', 'Multimodal', '其他',
] as const;

function benchmarkMetricSort(left: BenchmarkMetricDefinition, right: BenchmarkMetricDefinition): number {
  const leftCategory = left.category || left.group || '其他';
  const rightCategory = right.category || right.group || '其他';
  const leftIndex = OFFICIAL_BENCHMARK_CATEGORY_ORDER.indexOf(leftCategory as typeof OFFICIAL_BENCHMARK_CATEGORY_ORDER[number]);
  const rightIndex = OFFICIAL_BENCHMARK_CATEGORY_ORDER.indexOf(rightCategory as typeof OFFICIAL_BENCHMARK_CATEGORY_ORDER[number]);
  return (leftIndex < 0 ? OFFICIAL_BENCHMARK_CATEGORY_ORDER.length : leftIndex)
    - (rightIndex < 0 ? OFFICIAL_BENCHMARK_CATEGORY_ORDER.length : rightIndex)
    || (left.priority ?? 1) - (right.priority ?? 1)
    || (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0)
    || left.label.localeCompare(right.label, 'en');
}

export function groupOfficialBenchmarkMetrics(metrics: BenchmarkMetricDefinition[]) {
  const groups = new Map<string, BenchmarkMetricDefinition[]>();
  for (const metric of [...metrics].sort(benchmarkMetricSort)) {
    const category = metric.category || metric.group || '其他';
    groups.set(category, [...(groups.get(category) || []), metric]);
  }
  return [...groups].map(([category, groupedMetrics]) => ({ category, metrics: groupedMetrics }));
}

function benchmarkRunLabel(metric: BenchmarkMetricDefinition): string {
  const run = [metric.agent, metric.harness]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (metric.effort) run.push(metric.effort);
  if (metric.shots !== null && metric.shots !== undefined) run.push(`${metric.shots}-shot`);
  if (metric.passK !== null && metric.passK !== undefined) run.push(`Pass@${metric.passK}`);
  if (metric.tools) run.push(metric.tools);
  return run.join(' · ') || (metric.comparable ? '官网同口径' : '配置未完整披露');
}

export function officialWinnerRows(benchmarks: AiDashboardSnapshot['benchmarks']) {
  const metrics = [...benchmarks.metrics].sort(benchmarkMetricSort);
  return metrics.flatMap((metric) => {
    const winner = benchmarks.winners[metric.key];
    if (!winner || !Array.isArray(winner.models) || winner.models.length === 0 || !Number.isFinite(winner.value)) return [];
    return [{
      category: metric.category || metric.group || '其他',
      metricKey: metric.key,
      label: metric.label,
      testName: metric.testName || metric.testFamily || metric.label,
      testVersion: metric.testVersion || null,
      models: winner.models,
      formattedValue: formatBenchmarkValue({ value: winner.value }, metric),
      runLabel: benchmarkRunLabel(metric),
      terminalBench: metric.testFamily === 'Terminal-Bench' || /terminal[- ]bench/i.test(metric.testName || ''),
      direction: metric.direction,
      comparable: metric.comparable !== false,
    }];
  });
}

export function formatTaskTokenBreakdown(row: Pick<ArtificialAnalysisTaskCost, 'answerTokens' | 'reasoningTokens' | 'outputTokens'>): string {
  if (row.outputTokens === null) return 'Token 明细未公开';
  const answer = row.answerTokens === null ? '—' : Math.round(row.answerTokens).toLocaleString('en-US');
  const reasoning = row.reasoningTokens === null ? '—' : Math.round(row.reasoningTokens).toLocaleString('en-US');
  return `Answer ${answer} + Reasoning ${reasoning} = ${Math.round(row.outputTokens).toLocaleString('en-US')} Tokens`;
}

export function formatTaskCostComponents(row: Pick<ArtificialAnalysisTaskCost,
  'inputCost' | 'cacheHitCost' | 'cacheWriteCost' | 'reasoningCost' | 'answerCost' | 'totalCost' | 'currency'>): string {
  if (row.totalCost === null) return '成本未公开';
  const components = [
    ['Input', row.inputCost],
    ['Cache hit', row.cacheHitCost],
    ['Cache write', row.cacheWriteCost],
    ['Reasoning', row.reasoningCost],
    ['Answer', row.answerCost],
  ].filter((entry): entry is [string, number] => entry[1] !== null);
  return `${components.map(([label, value]) => `${label} ${formatCurrencyPrice(value, row.currency, 4)}`).join(' + ')} = ${formatCurrencyPrice(row.totalCost, row.currency, 4)}`;
}
