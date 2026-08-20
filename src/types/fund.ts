export interface Position {
  code: string;
  name: string;
  shares: number;
  avgCost: number;
  currentPrice?: number; // 当前价（用于计算市值和盈亏）
  prevClose?: number;    // 昨日收盘价（用于计算今日涨跌）
  targetWeight?: number; // 预设子集的目标权重（百分比）
}

export interface NAVRecord {
  date: string;
  nav: number;
  cumulativeNav: number;
  marketValue: number;
}

export interface Fund {
  id: string;
  name: string;
  market: 'a' | 'hk' | 'us' | 'jp' | 'kr'; // 市场：A=A股，HK=港股，US=美股，JP=日股，KR=韩股
  initialCapital: number; // 初始规模（单位：元）
  positions: Position[];
  navHistory: NAVRecord[];
  createdAt: string;
  shareToken?: string;
  lastSyncDate?: string; // 上次同步日期 YYYY-MM-DD
}
