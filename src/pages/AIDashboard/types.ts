export type SourceStatusCode = 'ready' | 'error' | 'authorization_required';

export type SourceKind = 'official' | 'filing' | 'estimate' | 'named-third-party';

export type DashboardSourceKey =
  | 'growth'
  | 'openRouter'
  | 'pricing'
  | 'capital'
  | 'benchmarks'
  | 'artificialAnalysis'
  | 'compute'
  | 'creditRisk';

export interface MetricProvenance {
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  asOf: string;
  retrievedAt: string;
  methodology: string;
  commentary?: string;
  stale: boolean;
}

export interface SourceStatus {
  status: SourceStatusCode;
  stale: boolean;
  asOf?: string | null;
  syncedAt?: string | null;
  url?: string;
  message?: string;
}

export interface ArrPoint {
  company: string;
  month: string;
  observedAt: string;
  value: number;
  kind: 'actual' | 'forecast';
  seriesKind: 'official' | 'estimate';
  momAbsolute?: number | null;
  momPercent?: number | null;
  comparisonLabel?: string | null;
  consecutiveMonth?: boolean | null;
  sourceLabel: string;
  sourceUrl?: string;
  sourceKind?: SourceKind;
  methodology?: string;
  commentary?: string;
  provenance?: MetricProvenance;
  currency?: string;
  unitScale?: number;
  originalValue?: number;
  originalUnit?: string;
  note?: string;
}

export interface ArrCompanyMetric {
  company: string;
  seriesId: string;
  seriesKind: 'official' | 'estimate';
  sourceLabel: string;
  actualPoints: ArrPoint[];
  forecastPoints: ArrPoint[];
  latestActual: ArrPoint | null;
  stale: boolean;
}

export interface ValuationMetric {
  company: string;
  asOf: string;
  valuationLow: number;
  valuationHigh: number;
  arrAsOf: string | null;
  arrValue: number | null;
  arrSeriesKind?: 'official' | 'estimate' | null;
  arrSourceLabel?: string | null;
  arrMethodology?: string | null;
  arrProvenance?: MetricProvenance | null;
  parrLow: number | null;
  parrHigh: number | null;
  sourceLabel?: string;
  note?: string;
}

export interface OpenRouterModelRank {
  model: string;
  totalTokens: string;
  rank: number;
  approximate?: boolean;
}

export interface OpenRouterHistoryPoint {
  startDate: string;
  endDate: string;
  totalTokens: string;
  weekOverWeekAbsolute: string | null;
  weekOverWeekPercent: number | null;
}

export interface TokenPrice {
  region: string;
  vendor: string;
  model: string;
  generation?: string | null;
  releasedAt?: string | null;
  category?: string;
  contextTier: string;
  serviceTier: string;
  currency: string;
  priceUnit: 'per_million_tokens';
  originalUnit?: string | null;
  publicPrice?: boolean;
  currentGeneration?: boolean | null;
  inputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  outputPrice: number | null;
  cacheHitLow?: number | null;
  cacheHitHigh?: number | null;
  cacheRangeValid?: boolean;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'official';
  asOf: string;
  retrievedAt: string;
  note?: string | null;
  provenance: MetricProvenance;
}

export interface PriceEvent {
  id: string;
  vendor: string;
  model: string;
  contextTier: string;
  serviceTier: string;
  region: string;
  currency: string;
  priceUnit: 'per_million_tokens';
  priceField: 'inputPrice' | 'cacheReadPrice' | 'cacheWritePrice' | 'outputPrice';
  oldPrice: number;
  newPrice: number;
  absoluteDelta: number;
  percentDelta: number | null;
  previousAsOf: string;
  asOf: string;
  sourceLabel: string;
  sourceUrl: string;
  provenance: MetricProvenance;
}

export interface VideoPrice {
  vendor: string;
  model: string;
  mode: string;
  resolution: string;
  durationTier: string;
  durationSeconds: number | null;
  pricingMode: 'fixed' | 'inquiry' | 'unpublished';
  price: number | null;
  currency: string | null;
  priceUnit: 'per_million_tokens' | 'per_video' | 'per_second' | 'inquiry' | 'unpublished';
  displayUnit: string;
  comparableUsdPerSecond: number | null;
  pricePerSecond?: number | null;
  region: string;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'official';
  asOf: string;
  retrievedAt: string;
  note?: string | null;
  provenance: MetricProvenance;
}

export interface CodingPlan {
  vendor: string;
  plan: string;
  pricingMode: 'fixed' | 'inquiry' | 'unpublished';
  currency: string | null;
  monthlyPrice: number | null;
  annualPrice: number | null;
  annualMonthlyPrice: number | null;
  allowanceText: string | null;
  limits?: string | null;
  overage: string | null;
  region: string;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'official';
  asOf: string;
  retrievedAt: string;
  note?: string | null;
  provenance: MetricProvenance;
}

export interface PricingSourceReport {
  sourceId: string;
  entity: string;
  url: string;
  status: 'ready' | 'error';
  asOf: string | null;
  rows: number;
  message: string | null;
}

export interface BenchmarkScore {
  value: number;
  direction?: 'higher' | 'lower';
  metric?: string;
  unit?: string;
  asOf?: string | null;
  publishedAt?: string | null;
  retrievedAt?: string | null;
  configurationComplete?: boolean;
  comparisonNote?: string | null;
  sampleSize?: number;
  standardDeviation?: number;
  source?: string;
  sourceUrl?: string;
}

export interface BenchmarkMetricDefinition {
  key: string;
  label: string;
  group: string;
  category?: 'Agent' | 'Coding' | 'Search & Tool Use' | 'Reasoning & Knowledge' | 'Multimodal' | '其他';
  testName?: string;
  testFamily?: string;
  testVersion?: string | null;
  split?: string | null;
  scoreName?: string;
  unit: string;
  direction: 'higher' | 'lower';
  agent?: string | null;
  harness?: string | null;
  effort?: string | null;
  shots?: number | null;
  passK?: number | null;
  tools?: string | null;
  comparable?: boolean;
  comparisonNote?: string | null;
  priority?: number;
  sourceOrder?: number;
  source: string;
  sourceUrl?: string | null;
  winnerKey?: string | null;
}

export interface BenchmarkModel {
  vendor: string;
  model: string;
  modelSlug?: string;
  releasedAt: string | null;
  sourceMode?: 'official-model-card';
  status?: 'ready' | 'error' | 'unavailable';
  stale?: boolean;
  scores: Record<string, BenchmarkScore>;
  sourceLabel?: string;
  sourceUrl?: string | null;
  discoveryMode?: string | null;
  error?: string | null;
}

export interface BenchmarkWinner {
  models: string[];
  value: number;
}

export interface BenchmarkVendorSource {
  vendor: string;
  model: string | null;
  status: 'ready' | 'error' | 'unavailable';
  stale: boolean;
  sourceUrl: string | null;
  discoveryMode: string | null;
  releasedAt: string | null;
  retrievedAt: string | null;
  error: string | null;
  disclosedScores: number;
}

export interface ArtificialAnalysisIndexRow {
  model: string;
  modelUrl: string | null;
  score: number;
  rank: number;
  indexVersion: string;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'named-third-party';
  asOf: string;
  retrievedAt: string;
  methodology: string;
  stale: boolean;
}

export interface ArtificialAnalysisTaskCost {
  model: string;
  modelUrl: string | null;
  taskName: string;
  taskVersion: string;
  harness: string;
  answerTokens: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  inputCost: number | null;
  cacheHitCost: number | null;
  cacheWriteCost: number | null;
  reasoningCost: number | null;
  answerCost: number | null;
  totalCost: number | null;
  currency: 'USD';
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'named-third-party';
  asOf: string;
  retrievedAt: string;
  methodology: string;
  stale: boolean;
}

export interface ComputeRentalQuote {
  platform: string;
  gpu: string;
  instanceSpec: string;
  gpuCount: number;
  region: string;
  billingMode: 'on_demand' | 'spot' | 'preemptible' | 'reserved' | 'capacity_block';
  currency: string;
  instanceHourlyPrice: number | null;
  pricePerGpuHour: number;
  comparableUsdPerGpuHour: number | null;
  asOf: string;
  quoteKey: string;
  previousPricePerGpuHour: number | null;
  absoluteChange: number | null;
  percentChange: number | null;
  latest: boolean;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'official';
  retrievedAt: string;
  note?: string | null;
  provenance: MetricProvenance;
}

export interface CapitalEvent {
  id: string;
  entity: string;
  geography: string;
  eventDate: string;
  closeDate: string | null;
  maturityDate: string | null;
  instrumentCategory: 'equity' | 'debt' | 'convertible' | 'credit_facility';
  instrument: string;
  amountOriginal: number;
  currency: string;
  comparableUsdAmount: number | null;
  rateType: 'fixed' | 'floating' | 'unknown' | 'not_applicable';
  couponPercent: number | null;
  benchmark: string | null;
  spreadBps: number | null;
  tenorYears: number | null;
  counterparties: string[];
  useOfProceeds: string | null;
  sourceLabel: string;
  sourceUrl: string;
  sourceKind: 'official' | 'filing';
  asOf: string;
  retrievedAt: string;
  note?: string | null;
  provenance: MetricProvenance;
}

export interface CapitalMetric {
  entity: string;
  eventCount: number;
  trailing12MonthCount: number;
  trailing12MonthComparableUsd: number;
  cumulativeComparableUsd: number;
  averageDaysBetweenEvents: number | null;
  annualizedEventFrequency: number | null;
  fixedCouponEventCount: number;
  weightedAverageFixedCoupon: number | null;
  latestEventDate: string | null;
}

export interface PublicSourceReport {
  sourceId: string;
  entity?: string;
  platform?: string;
  url: string | null;
  status: 'ready' | 'error' | 'discovery-maintained';
  asOf: string | null;
  rows: number;
  message: string | null;
}

export interface CdsHistoryPoint {
  date: string;
  valueBp: number;
}

export interface CdsCompanyMetric {
  company: string;
  latestBp: number;
  changes: {
    oneDayBp: number | null;
    sevenDayBp: number | null;
    oneMonthBp: number | null;
  };
  history: CdsHistoryPoint[];
}

export interface CdsRiskSnapshot {
  asOf: string | null;
  sourceKind?: 'dtcc_public_trade_estimate' | string;
  sourceLabel: string;
  sourceUrl?: string | null;
  lastCheckedAt?: string | null;
  historyEstimated: boolean;
  note?: string;
  companies: CdsCompanyMetric[];
}

export interface AiDashboardSnapshot {
  schemaVersion: number;
  generatedAt: string;
  sources: Record<DashboardSourceKey, SourceStatus>;
  arrAndValuation: {
    companies: ArrCompanyMetric[];
    valuations: ValuationMetric[];
  };
  openRouter: {
    startDate: string | null;
    endDate: string | null;
    weekTotalTokens: string | null;
    priorWeekTotalTokens: string | null;
    weekOverWeekAbsolute: string | null;
    weekOverWeekPercent: number | null;
    topModels: OpenRouterModelRank[];
    history: OpenRouterHistoryPoint[];
    attribution: string;
  };
  modelPricing: {
    token: TokenPrice[];
    tokenHistory: TokenPrice[];
    priceEvents: PriceEvent[];
    video: VideoPrice[];
    videoHistory: VideoPrice[];
    codingPlans: CodingPlan[];
    codingPlanHistory: CodingPlan[];
    sourceReports: PricingSourceReport[];
  };
  benchmarks: {
    models: BenchmarkModel[];
    metrics: BenchmarkMetricDefinition[];
    winners: Record<string, BenchmarkWinner>;
    vendorSources: BenchmarkVendorSource[];
    asOf: string | null;
    sourceMode: 'official-model-cards' | 'none';
    coverage: {
      vendors: number;
      disclosedVendors: number;
      metrics: number;
      comparableMetrics: number;
    };
    attributions: Array<{ source: string; label: string; url?: string }>;
  };
  artificialAnalysis: {
    intelligenceIndex: ArtificialAnalysisIndexRow[];
    taskCosts: ArtificialAnalysisTaskCost[];
    indexVersion: string | null;
  };
  computeRental: ComputeRentalQuote[];
  computeSourceReports: PublicSourceReport[];
  capitalEvents: CapitalEvent[];
  capitalMetrics: {
    industry: CapitalMetric | null;
    byEntity: CapitalMetric[];
  };
  capitalSourceReports: PublicSourceReport[];
  debtFinancing: CapitalEvent[];
  creditRisk: {
    cds5y: CdsRiskSnapshot;
  };
}

export interface AiDashboardApiResponse {
  success: boolean;
  data?: AiDashboardSnapshot;
  publicAccess?: boolean;
  expiresAt?: string;
  sessionExpiresAt?: string;
  error?: { code: string; message: string };
}
