export type SourceStatusCode = 'ready' | 'error' | 'authorization_required';

export interface SourceStatus {
  status: SourceStatusCode;
  stale: boolean;
  asOf?: string | null;
  url?: string;
  message?: string;
}

export interface ArrPoint {
  company: string;
  month: string;
  observedAt: string;
  value: number;
  kind: 'actual' | 'forecast';
  momAbsolute?: number | null;
  sourceLabel: string;
  note?: string;
}

export interface ArrCompanyMetric {
  company: string;
  actualPoints: ArrPoint[];
  forecastPoints: ArrPoint[];
  slope3m: number | null;
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
}

export interface TokenPrice {
  region?: string;
  vendor: string;
  model: string;
  releasedAt?: string | null;
  category?: string;
  inputPrice: number | null;
  cacheReadPrice: number | null;
  outputPrice: number | null;
  cacheHitLow: number | null;
  cacheHitHigh: number | null;
  cacheRangeValid: boolean;
  sourceLabel: string;
  asOf?: string | null;
  note?: string;
}

export interface VideoPrice {
  vendor: string;
  model: string;
  mode: string;
  resolution: string;
  durationTier: string;
  pricePerSecond: number;
  sourceLabel: string;
  asOf?: string | null;
}

export interface CodingPlan {
  vendor: string;
  plan: string;
  monthlyPrice: number;
  annualMonthlyPrice: number | null;
  limits: string;
  overage: string;
  sourceLabel: string;
  asOf?: string | null;
}

export interface BenchmarkScore {
  value: number;
  direction: 'higher' | 'lower';
  metric?: string;
}

export interface BenchmarkModel {
  vendor: string;
  model: string;
  releasedAt: string;
  scores: Record<string, BenchmarkScore>;
  sourceLabel?: string;
}

export interface ComputeRentalQuote {
  platform: string;
  gpu: string;
  asOf: string;
  onDemand: number | null;
  preemptible: number | null;
  preemptibleRatio: number | null;
  onDemandChange: number | null;
  preemptibleChange: number | null;
  latest: boolean;
  sourceLabel: string;
}

export interface DebtFinancing {
  company: string;
  asOf: string | null;
  method: string;
  amount: number;
  currency: string;
  note?: string;
  sourceLabel: string;
  updatedAt?: string | null;
}

export interface AiDashboardSnapshot {
  schemaVersion: number;
  generatedAt: string;
  sources: {
    feishu: SourceStatus;
    openRouter: SourceStatus;
  };
  arrAndValuation: {
    companies: ArrCompanyMetric[];
    valuations: ValuationMetric[];
  };
  openRouter: {
    startDate: string | null;
    endDate: string | null;
    weekTotalTokens: string | null;
    topModels: OpenRouterModelRank[];
    history: OpenRouterHistoryPoint[];
    attribution: string;
  };
  modelPricing: {
    token: TokenPrice[];
    video: VideoPrice[];
    codingPlans: CodingPlan[];
  };
  benchmarks: {
    models: BenchmarkModel[];
    winners: Record<string, string[]>;
  };
  computeRental: ComputeRentalQuote[];
  debtFinancing: DebtFinancing[];
}

export interface AiDashboardApiResponse {
  success: boolean;
  data?: AiDashboardSnapshot;
  publicAccess?: boolean;
  expiresAt?: string;
  sessionExpiresAt?: string;
  error?: { code: string; message: string };
}
