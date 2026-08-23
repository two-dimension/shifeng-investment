import type { BenchmarkMetricDefinition, BenchmarkScore, SourceStatus } from './types';

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
  const unit = TOKEN_UNITS.find(({ divisor }) => tokens >= divisor);
  if (!unit) return tokens.toString();
  const roundedHundredths = (tokens * 100n + unit.divisor / 2n) / unit.divisor;
  const whole = roundedHundredths / 100n;
  const fraction = String(roundedHundredths % 100n).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}${unit.suffix}`;
}

export function formatUsd(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `$${value.toFixed(digits)}`;
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
  if (source.status === 'ready' && !source.stale) return '已同步';
  return '数据过期';
}

export function sourceStatusColor(source: Pick<SourceStatus, 'status' | 'stale'>): 'success' | 'warning' | 'error' | 'default' {
  if (source.status === 'ready' && !source.stale) return 'success';
  if (source.status === 'authorization_required') return 'default';
  if (source.stale) return 'warning';
  return 'error';
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
