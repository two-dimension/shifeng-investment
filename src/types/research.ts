// 投研报告类型定义（cninfo 公告研判 + 业绩预告 + 业绩报告 + 风险提示）

export type ResearchKind = 'cninfo' | 'earnings' | 'earnings-report' | 'risk';

export type ResearchRefreshStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed';

export interface ResearchRefreshState {
  scope: 'all';
  jobId: string | null;
  status: ResearchRefreshStatus;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface ResearchRefreshRequestResult {
  dispatched: boolean;
  state: ResearchRefreshState;
}

export interface ResearchTopEntry {
  rank: number;
  code: string;
  name: string;
  industry?: string;
  subset?: string;
  score: number;          // cninfo: -10 ~ +10；earnings / earnings-report: 同比%
  scoreLabel?: string;    // earnings 类数据没有同比%时显示类型/亏损标签
  title: string;
  summary?: string;
  // cninfo 扩展字段
  logic?: string;         // 评分逻辑解释
  facts?: string[];       // 提取的事实
  signals?: { name: string; score: number }[];  // 信号 + 分数
  annCount?: number;      // 该公司当日公告数
  conclusion?: string;    // 弱利好/中利空
  increaseScale?: number; // 业绩预告增幅（cninfo 中也用）
  time?: string;
  metric?: string;         // earnings 类数据: 归母净利润/扣非净利润
  lowWan?: number | null;  // earnings 类数据: 净利润下限（万元）
  highWan?: number | null;
  prevWan?: number | null;
  focusHit?: boolean;      // earnings: 命中自选行业/关注池
  subsetHit?: boolean;     // earnings: 命中标的池子集
  url?: string;           // 公告 PDF URL
}

export interface ResearchFile {
  filename: string;
  type: 'xlsx' | 'pdf';
  size: number;
  url: string;
}

// earnings 全量 item（表格视图用）
export interface EarningsItem {
  code: string;
  name: string;
  industry?: string;
  subset?: string;
  annDate: string;
  url?: string;
  announcementId?: string;
  announcementTitle?: string;
  forecastType: string;   // 预增/预减/扭亏/...
  forecastPeriod: string;
  metric: string;         // 归母净利润/扣非净利润
  lowWan: number | null;  // 净利润下限（万元）
  highWan: number | null;
  prevWan: number | null;
  lowPct: number | null;  // 同比下限%
  highPct: number | null;
  reason: string;
  focusHit?: boolean;      // 命中自选行业/关注池
  subsetHit?: boolean;     // 命中标的池子集
}

// cninfo 情绪画像
export interface ResearchSentiment {
  summary: string;                // 一句话情绪总结
  goodSectors: string[];
  badSectors: string[];
  netScore: number;               // 净情绪分
}

export interface ResearchSummary {
  kind: ResearchKind;
  date: string;           // 'YYYY-MM-DD'
  reportDate: string;     // 'YYMMDD' (cninfo) | 'YYYY-MM-DD' (earnings 类数据)
  generatedAt: string;    // ISO 8601
  coverage: string;
  totalCount: number;
  watchlistHits: number;
  topGood: ResearchTopEntry[];
  topBad: ResearchTopEntry[];
  stats: {
    goodCount?: number;
    badCount?: number;
    neutralFiltered?: number;
    totalForecasts?: number;  // earnings: 业绩预告总数
    totalReports?: number;    // earnings-report: 正式报告总数
    sentimentScore?: number;  // cninfo: 净情绪分
    majorRiskCount?: number;  // risk: 高风险条数
    riskCompanyCount?: number; // risk: 风险公司数
  };
  files: ResearchFile[];
  // ── 扩展字段 ──
  sentiment?: ResearchSentiment;       // cninfo 情绪画像
  allItems?: EarningsItem[];            // earnings 全量 items
  typeDistribution?: Record<string, number>;  // earnings 类型分布
  allGood?: ResearchTopEntry[];         // cninfo 所有利好（>5 条）
  allBad?: ResearchTopEntry[];          // cninfo 所有利空（>5 条）
}

export interface ResearchHistoryResponse {
  kind: ResearchKind;
  dates: string[];        // ['YYYY-MM-DD', ...] 最新的在前
}

// UI 辅助函数
// A股语境：正向/利好用红色，负向/利空用绿色
export const RESEARCH_GOOD_COLOR = '#ff4d4f';
export const RESEARCH_BAD_COLOR = '#52c41a';
export const RESEARCH_GOOD_TAG_COLOR = 'red';
export const RESEARCH_BAD_TAG_COLOR = 'green';

export function formatScore(score: number, kind: ResearchKind): string {
  if (kind === 'risk') {
    if (score <= -7) return `高风险 ${score}`;
    if (score <= -4) return `观察项 ${score}`;
    return `弱风险 ${score}`;
  }
  if (kind === 'cninfo') {
    if (score >= 7) return `强利多 +${score}`;
    if (score >= 4) return `中利多 +${score}`;
    if (score >= 1) return `弱利多 +${score}`;
    if (score <= -7) return `强利空 ${score}`;
    if (score <= -4) return `中利空 ${score}`;
    return `弱利空 ${score}`;
  }
  // earnings / earnings-report: 同比%
  if (score >= 0) return `+${score}%`;
  return `${score}%`;
}

export function scoreColor(score: number, kind: ResearchKind): string {
  if (kind === 'risk') {
    if (score < 0) return RESEARCH_BAD_COLOR;
    return '#8c8c8c';
  }
  if (kind === 'cninfo') {
    if (score > 0) return RESEARCH_GOOD_COLOR;
    if (score < 0) return RESEARCH_BAD_COLOR;
    return '#8c8c8c';
  }
  // earnings / earnings-report: 正同比/改善偏利好，负同比/恶化偏利空
  if (score > 0) return RESEARCH_GOOD_COLOR;
  if (score < 0) return RESEARCH_BAD_COLOR;
  return '#8c8c8c';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 业绩预告类型 → 颜色
export function forecastTypeColor(type: string): string {
  const map: Record<string, string> = {
    '预增': RESEARCH_GOOD_TAG_COLOR,
    '续盈': RESEARCH_GOOD_TAG_COLOR,
    '扭亏': RESEARCH_GOOD_TAG_COLOR,
    '预减': RESEARCH_BAD_TAG_COLOR,
    '首亏': RESEARCH_BAD_TAG_COLOR,
    '续亏': RESEARCH_BAD_TAG_COLOR,
    '不确定': 'gold',
  };
  return map[type] || 'default';
}
