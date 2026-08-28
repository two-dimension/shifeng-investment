import React, { useEffect, useState, useMemo } from 'react';
import { Card, Row, Col, Button, Empty, Typography, Space, Table, message, Tooltip } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { PlusOutlined, ArrowUpOutlined, ArrowDownOutlined, SyncOutlined, AppstoreOutlined, BarsOutlined, DownloadOutlined } from '@ant-design/icons';
import { type Fund } from '../../types/fund';
import type { Worksheet } from 'exceljs';

const { Text } = Typography;

type SortKey = 'name' | 'positionCount' | 'dailyReturn' | null;
type SortOrder = 'asc' | 'desc' | null;
type SortState = {
  key: SortKey;
  order: SortOrder;
};

interface StockMover {
  code: string;
  name: string;
  dailyReturn: number;
}

interface EvidenceItem {
  type: '公告监控' | '业绩预告' | '新闻资讯';
  title: string;
  summary?: string;
  text: string;
  polarity: 'positive' | 'negative' | 'neutral';
}

const profitColor = (v: number) => v > 0 ? '#ff4d4f' : v < 0 ? '#52c41a' : '#888';
const profitIcon = (v: number) => v > 0 ? <ArrowUpOutlined /> : v < 0 ? <ArrowDownOutlined /> : null;
const formatPercent = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const marketBadgeConfig: Record<Fund['market'], { label: string; color: string; bg: string }> = {
  a: { label: 'A', color: '#b42318', bg: '#fff1f0' },
  hk: { label: '港', color: '#7a4b00', bg: '#fff7e6' },
  us: { label: '美', color: '#155eef', bg: '#eff4ff' },
  jp: { label: '日', color: '#8a2be2', bg: '#f5f0ff' },
  kr: { label: '韩', color: '#067647', bg: '#ecfdf3' },
};

const MarketBadge: React.FC<{ market: Fund['market'] }> = ({ market }) => {
  const config = marketBadgeConfig[market];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        marginRight: 6,
        fontSize: 11,
        fontWeight: 700,
        color: config.color,
        background: config.bg,
        verticalAlign: 'middle',
        flex: '0 0 auto',
      }}
    >
      {config.label}
    </span>
  );
};

const toExcelSafeSheetName = (name: string) => name.replace(/[\\/?*:[\]]/g, '').slice(0, 31) || '基金';

const toUniqueSheetName = (baseName: string, usedNames: Record<string, number>) => {
  if (!usedNames[baseName]) return baseName;

  let suffix = 2;
  while (true) {
    const suffixText = `(${suffix})`;
    const candidate = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
    if (!usedNames[candidate]) return candidate;
    suffix += 1;
  }
};

const toMarketLabel = (market: Fund['market']) => {
  if (market === 'hk') return '港股';
  if (market === 'us') return '美股';
  if (market === 'jp') return '日股';
  if (market === 'kr') return '韩股';
  return 'A股';
};

const textOf = (...values: unknown[]) => values
  .flatMap((value) => Array.isArray(value) ? value : [value])
  .filter((value) => value !== undefined && value !== null)
  .map((value) => String(value))
  .join(' ');

const normalize = (value: string) => value.toLowerCase();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const themeAliasMap: Array<{ keyword: string; aliases: string[] }> = [
  { keyword: '机器人', aliases: ['机器人', '宇树', 'unitree', '具身智能', '人形机器人'] },
  { keyword: '存储', aliases: ['存储', 'hbm', 'dram', 'nand', 'memory', '三星', 'samsung', 'sk海力士', '海力士', 'hynix', 'korea'] },
  { keyword: 'hbm', aliases: ['hbm', 'dram', '三星', 'samsung', 'sk海力士', '海力士', 'hynix', 'memory', 'korea'] },
  { keyword: 'cpo', aliases: ['cpo', '光模块', '光通信', 'coherent', 'semianalysis', 'optical'] },
  { keyword: '半导体', aliases: ['半导体', 'semiconductor', 'chip', '晶圆', '先进制程'] },
  { keyword: 'mlcc', aliases: ['mlcc', '被动元件', '电容'] },
];

const companyAliasMap: Array<{ keyword: string; aliases: string[] }> = [
  { keyword: '三星电子', aliases: ['samsung', 'samsung electronics', '005930'] },
  { keyword: 'sk海力士', aliases: ['sk hynix', 'hynix', '000660'] },
  { keyword: '海力士', aliases: ['sk hynix', 'hynix', '000660'] },
  { keyword: '特斯拉', aliases: ['tesla', 'tsla'] },
  { keyword: '英伟达', aliases: ['nvidia', 'nvda'] },
  { keyword: '美光', aliases: ['micron', '$mu'] },
  { keyword: '美光科技', aliases: ['micron', '$mu'] },
  { keyword: '台积电', aliases: ['tsmc', 'taiwan semiconductor', 'tsm'] },
  { keyword: '博通', aliases: ['broadcom', 'avgo'] },
  { keyword: '迈威尔', aliases: ['marvell', 'mrvl'] },
  { keyword: '英特尔', aliases: ['intel', 'intc'] },
  { keyword: '科磊', aliases: ['kla', 'klac'] },
  { keyword: '应用材料', aliases: ['applied materials', 'amat'] },
  { keyword: '东京电子', aliases: ['tokyo electron', 'tel', '8035'] },
  { keyword: '村田制作所', aliases: ['murata', 'murata manufacturing', '6981'] },
  { keyword: '太阳诱电', aliases: ['taiyo yuden', '6976'] },
  { keyword: '发那科', aliases: ['fanuc', '6954'] },
  { keyword: '安川电机', aliases: ['yaskawa', 'yaskawa electric', '6506'] },
  { keyword: '基恩士', aliases: ['keyence', '6861'] },
  { keyword: '台达电子', aliases: ['delta electronics'] },
  { keyword: '联电', aliases: ['umc', 'united microelectronics'] },
  { keyword: '格芯', aliases: ['globalfoundries', 'gfs'] },
  { keyword: '阿斯麦', aliases: ['asml'] },
  { keyword: '泛林', aliases: ['lam research', 'lrcx'] },
  { keyword: '迪斯科', aliases: ['disco', '6146'] },
  { keyword: '爱德万', aliases: ['advantest', '6857'] },
  { keyword: '铠侠', aliases: ['kioxia', '285a'] },
  { keyword: 'Lasertec', aliases: ['lasertec', '6920'] },
  { keyword: 'MARUWA', aliases: ['maruwa', '5344'] },
  { keyword: 'Resonac', aliases: ['resonac', '4004'] },
  { keyword: 'SCREEN', aliases: ['screen holdings', 'screen', '7735'] },
  { keyword: 'SMC', aliases: ['smc', '6273'] },
  { keyword: 'TDK', aliases: ['tdk', '6762'] },
  { keyword: 'Tri Chemical', aliases: ['tri chemical', '4369'] },
  { keyword: '三菱重工', aliases: ['mitsubishi heavy industries', 'mitsubishi heavy', '7011'] },
  { keyword: '东京应化', aliases: ['tokyo ohka', 'tok', '4186'] },
  { keyword: '东京精密', aliases: ['tokyo seimitsu', 'accretech', '7729'] },
  { keyword: '京瓷', aliases: ['kyocera', '6971'] },
  { keyword: '住友电气', aliases: ['sumitomo electric', '5802'] },
  { keyword: '信越化学', aliases: ['shin-etsu', 'shin etsu', '4063'] },
  { keyword: '古河电气', aliases: ['furukawa electric', '5801'] },
  { keyword: '藤仓', aliases: ['fujikura', '5803'] },
  { keyword: '韩美半导体', aliases: ['hanmi semiconductor', 'hanmi', '042700'] },
  { keyword: 'Techwing', aliases: ['techwing', '089030'] },
  { keyword: 'EO Technics', aliases: ['eo technics', '039030'] },
  { keyword: 'Wonik IPS', aliases: ['wonik ips', '240810'] },
  { keyword: 'Soulbrain', aliases: ['soulbrain', '357780'] },
  { keyword: '高通', aliases: ['qualcomm', 'qcom'] },
  { keyword: '德州仪器', aliases: ['texas instruments', 'txn'] },
  { keyword: '戴尔科技', aliases: ['dell', 'dell technologies'] },
  { keyword: '西部数据', aliases: ['western digital', 'wdc'] },
  { keyword: '希捷', aliases: ['seagate', 'stx'] },
  { keyword: '希捷科技', aliases: ['seagate', 'stx'] },
  { keyword: '航空环境', aliases: ['aerovironment', 'avav'] },
  { keyword: '红猫', aliases: ['red cat', 'rcat'] },
  { keyword: '火箭实验室', aliases: ['rocket lab', 'rklb'] },
  { keyword: '铱星', aliases: ['iridium', 'irdm'] },
  { keyword: '全球星', aliases: ['globalstar', 'gsat'] },
  { keyword: '维谛', aliases: ['vertiv', 'vrt'] },
  { keyword: '超微电脑', aliases: ['super micro', 'super micro computer', 'smci'] },
];

const inferPolarity = (text: string): EvidenceItem['polarity'] => {
  const positiveWords = ['利好', '增长', '大增', '超预期', '中标', '订单', '涨价', '扩产', '回购', '增持', '获批', '突破', '合作', '景气', '上调'];
  const negativeWords = ['利空', '下滑', '下降', '亏损', '低于预期', '减持', '处罚', '调查', '风险', '违约', '降价', '砍单', '终止', '撤回', '被立案'];
  const normalized = normalize(text);
  const positive = positiveWords.some((word) => normalized.includes(normalize(word)));
  const negative = negativeWords.some((word) => normalized.includes(normalize(word)));
  if (positive && !negative) return 'positive';
  if (negative && !positive) return 'negative';
  return 'neutral';
};

const evidenceSupportsMove = (item: EvidenceItem, dailyReturn: number) => {
  if (item.polarity === 'neutral') return true;
  if (dailyReturn >= 0) return item.polarity === 'positive';
  return item.polarity === 'negative';
};

const evidenceTitle = (item: Record<string, unknown>, fallback: string) => {
  return String(item.title || item.announcementTitle || item.name || item.stockName || item.companyName || fallback);
};

const evidenceSummary = (item: Record<string, unknown>) => {
  return textOf(item.summary, item.snippet, item.description, item.conclusion, item.scoreLabel, item.logic, item.facts).slice(0, 140);
};

const collectNewsEvidence = (payload: unknown): EvidenceItem[] => {
  const data = payload as Record<string, unknown> | null;
  const directNews = Array.isArray(data?.news) ? data.news : [];
  const nestedNews = data?.news && typeof data.news === 'object' && Array.isArray((data.news as Record<string, unknown>).news)
    ? (data.news as Record<string, unknown>).news as unknown[]
    : [];
  const entryNews = Array.isArray(data?.entries)
    ? (data.entries as unknown[]).flatMap((entry) => {
      const record = entry as Record<string, unknown>;
      return Array.isArray(record.news) ? record.news as unknown[] : [];
    })
    : [];
  const items = directNews.length > 0 ? directNews : nestedNews.length > 0 ? nestedNews : entryNews;

  return items.map((raw) => {
    const item = raw as Record<string, unknown>;
    const title = evidenceTitle(item, '新闻资讯');
    const summary = evidenceSummary(item);
    const text = textOf(
      title,
      summary,
      item.category,
      item.source,
      item.content,
      item.description,
      item.snippet,
      item.investmentCategory,
      item.sourceCategory,
      item.collectionChannel,
      item.symbols,
      item.tags
    );
    return { type: '新闻资讯' as const, title, summary, text: normalize(text), polarity: inferPolarity(text) };
  });
};

const collectResearchEvidence = (payload: unknown, type: '公告监控' | '业绩预告'): EvidenceItem[] => {
  const data = payload as Record<string, unknown> | null;
  const buckets = ['topGood', 'topBad', 'allGood', 'allBad', 'allItems'] as const;
  const items = buckets.flatMap((bucket) => Array.isArray(data?.[bucket]) ? (data[bucket] as unknown[]).map((item) => ({ item, bucket })) : []);

  return items.map(({ item: raw, bucket }) => {
    const item = raw as Record<string, unknown>;
    const title = evidenceTitle(item, type);
    const summary = evidenceSummary(item);
    const text = textOf(item.code, item.stockCode, item.name, item.stockName, item.companyName, item.announcementTitle, title, summary, item.facts, item.type);
    return {
      type,
      title,
      summary,
      text: normalize(text),
      polarity: bucket.includes('Good') ? 'positive' : bucket.includes('Bad') ? 'negative' : inferPolarity(text),
    };
  });
};

const fetchAnomalyEvidence = async () => {
  const [newsResp, cninfoResp, earningsResp] = await Promise.all([
    fetch('/api/news/latest'),
    fetch('/api/research/cninfo/latest'),
    fetch('/api/research/earnings/latest'),
  ]);
  const [news, cninfo, earnings] = await Promise.all([
    newsResp.ok ? newsResp.json() : null,
    cninfoResp.ok ? cninfoResp.json() : null,
    earningsResp.ok ? earningsResp.json() : null,
  ]);
  return [
    ...collectNewsEvidence(news),
    ...collectResearchEvidence(cninfo, '公告监控'),
    ...collectResearchEvidence(earnings, '业绩预告'),
  ];
};

const getThemeKeywords = (fundName: string) => {
  const stripped = fundName.replace(/^(美股|日股|韩国|韩股|港股|A股)/, '');
  const baseKeywords = [fundName, stripped, ...stripped.split(/[\/\s-]+/)].filter((word) => word.length >= 2);
  const aliasKeywords = themeAliasMap
    .filter((item) => normalize(fundName).includes(normalize(item.keyword)) || normalize(stripped).includes(normalize(item.keyword)))
    .flatMap((item) => item.aliases);
  return Array.from(new Set([...baseKeywords, ...aliasKeywords].filter((word) => word.length >= 2)));
};

const matchesPositionDirectly = (item: EvidenceItem, mover: StockMover) => {
  const code = normalize(mover.code);
  const name = normalize(mover.name);
  const aliases = companyAliasMap
    .filter((entry) => name.includes(normalize(entry.keyword)))
    .flatMap((entry) => entry.aliases.map((alias) => normalize(alias)));
  const isAsciiTicker = /^[a-z.=-]{1,8}$/i.test(mover.code);
  const codeMatched = isAsciiTicker
    ? new RegExp(`(^|[^a-z0-9])\\$?${escapeRegExp(code)}([^a-z0-9]|$)`, 'i').test(item.text)
    : item.text.includes(code);
  return codeMatched || (!!name && item.text.includes(name)) || aliases.some((alias) => item.text.includes(alias));
};

const getThemeEvidence = (evidence: EvidenceItem[], fundName: string, dailyReturn: number) => {
  const themeKeywords = getThemeKeywords(fundName).map((word) => normalize(word));
  return evidence
    .filter((item) => evidenceSupportsMove(item, dailyReturn))
    .filter((item) => themeKeywords.some((keyword) => item.text.includes(keyword)));
};

const getYtdReturn = (fund: Fund, totalMarketValue: number) => {
  const year = new Date().getFullYear();
  const firstValidRecord = [...(fund.navHistory || [])]
    .filter((record) => {
      const recordYear = Number(String(record.date).slice(0, 4));
      return recordYear === year && Number.isFinite(record.marketValue) && record.marketValue > 0;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  const baseline = firstValidRecord?.marketValue || fund.initialCapital;
  return baseline > 0 ? ((totalMarketValue - baseline) / baseline) * 100 : 0;
};

interface FundStats {
  fund: Fund;
  totalCost: number;
  totalMarketValue: number;
  profit: number;
  profitPercent: number;
  ytdReturn: number;
  dailyReturn: number;
  topMovers: StockMover[];
  abnormalCount: number;
}

interface FundDashboardProps {
  funds: Fund[];
  onSelectFund: (id: string) => void;
  onAddFund: () => void;
  onSyncAll: () => void;
  syncing: boolean;
  exportLabel?: string;
  showMarketBadge?: boolean;
  onOpenAnomaly?: (fundId: string, code?: string) => void;
}

const getAnomalySummary = (stats: FundStats, evidence: EvidenceItem[]) => {
  const isUp = stats.dailyReturn >= 0;
  const direction = isUp ? '上涨' : '下跌';
  const verb = isUp ? '带动' : '拖累';
  const moverNames = stats.topMovers.length > 0
    ? stats.topMovers.map((mover) => mover.name || mover.code).join('、')
    : '暂无明显成分股';

  const directEvidence = stats.topMovers
    .flatMap((mover) => evidence
      .filter((item) => matchesPositionDirectly(item, mover))
      .filter((item) => evidenceSupportsMove(item, mover.dailyReturn))
      .map((item) => ({ item, mover })));
  if (directEvidence.length > 0) {
    const first = directEvidence[0];
    return `${stats.fund.name}今日${direction} ${Math.abs(stats.dailyReturn).toFixed(2)}%；${first.mover.name || first.mover.code}匹配到${first.item.type}：${first.item.title}`;
  }

  const themeEvidence = getThemeEvidence(evidence, stats.fund.name, stats.dailyReturn);
  if (themeEvidence.length > 0) {
    const first = themeEvidence[0];
    return `${stats.fund.name}今日${direction} ${Math.abs(stats.dailyReturn).toFixed(2)}%；主题线索：${first.title}`;
  }

  return `${stats.fund.name}今日${direction} ${Math.abs(stats.dailyReturn).toFixed(2)}%，暂无明确新闻/公告催化，主要由${moverNames}${verb}。`;
};

const AnomalyButton: React.FC<{
  stats: FundStats;
  evidence: EvidenceItem[];
  onOpenAnomaly?: (fundId: string, code?: string) => void;
}> = ({ stats, evidence, onOpenAnomaly }) => (
  <Tooltip title={getAnomalySummary(stats, evidence)}>
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpenAnomaly?.(stats.fund.id);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        marginLeft: 4,
        borderRadius: '50%',
        border: '1px solid #ffd591',
        background: '#fff7e6',
        color: '#ad4e00',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      异
    </button>
  </Tooltip>
);

const renderTopMovers = (stats: FundStats, evidence: EvidenceItem[], onOpenAnomaly?: (fundId: string, code?: string) => void) => {
  if (stats.topMovers.length === 0) return '--';
  return (
    <Space size={4} wrap>
      <span style={{ color: '#666' }}>
        {stats.topMovers.map((mover) => `${mover.name || mover.code}（${formatPercent(mover.dailyReturn)}）`).join('、')}
      </span>
      <AnomalyButton stats={stats} evidence={evidence} onOpenAnomaly={onOpenAnomaly} />
    </Space>
  );
};

const FundDashboardCard: React.FC<{
  stats: FundStats;
  evidence: EvidenceItem[];
  onClick: () => void;
  showMarketBadge?: boolean;
  onOpenAnomaly?: (fundId: string, code?: string) => void;
}> = ({ stats, evidence, onClick, showMarketBadge = false, onOpenAnomaly }) => {
  const { fund, ytdReturn, dailyReturn } = stats;

  return (
    <Card
      hoverable
      onClick={onClick}
      style={{ cursor: 'pointer', height: 210 }}
      styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' } }}
    >
      <div>
        <Text strong style={{ fontSize: 16, display: 'flex', alignItems: 'center', marginBottom: 4 }}>{showMarketBadge && <MarketBadge market={fund.market} />}{fund.name}</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>持仓 {fund.positions.length} 只股票</Text>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 11 }}>今日涨跌</Text>
        <div style={{ fontSize: 16, fontWeight: 600, color: profitColor(dailyReturn), marginBottom: 8 }}>
          {profitIcon(dailyReturn)}
          {dailyReturn !== 0 ? ` ${Math.abs(dailyReturn).toFixed(2)}%` : ' 0.00%'}
        </div>
        <Text type="secondary" style={{ fontSize: 11 }}>YTD</Text>
        <div style={{ fontSize: 14, fontWeight: 600, color: profitColor(ytdReturn), marginBottom: 8 }}>
          {ytdReturn > 0 ? '+' : ''}{ytdReturn.toFixed(2)}%
        </div>
        <Text type="secondary" style={{ fontSize: 11 }}>Top3涨/跌幅成分股</Text>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#666' }}>{renderTopMovers(stats, evidence, onOpenAnomaly)}</div>
      </div>
    </Card>
  );
};

const FundDashboard: React.FC<FundDashboardProps> = ({ funds, onSelectFund, onAddFund, onSyncAll, syncing, exportLabel = '全部', showMarketBadge = false, onOpenAnomaly }) => {
  const [sortState, setSortState] = useState<SortState>({ key: 'dailyReturn', order: 'desc' });
  const sortKey = sortState.key;
  const sortOrder = sortState.order;
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchAnomalyEvidence()
      .then((items) => {
        if (!cancelled) setEvidence(items);
      })
      .catch(() => {
        if (!cancelled) setEvidence([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allStats = useMemo<FundStats[]>(() => {
    return funds.map((fund) => {
      const totalCost = fund.positions.reduce((sum, p) => sum + p.shares * p.avgCost, 0);
      const totalMarketValue = fund.positions.reduce((sum, p) => {
        const price = p.currentPrice ?? p.avgCost;
        return sum + p.shares * price;
      }, 0);
      const profit = totalMarketValue - totalCost;
      const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;
      const ytdReturn = getYtdReturn(fund, totalMarketValue);

      let dailyReturn = 0;
      const weightedSum = { prev: 0, curr: 0 };
      for (const pos of fund.positions) {
        const curr = (pos.currentPrice ?? pos.avgCost) * pos.shares;
        const prev = (pos.prevClose ?? pos.currentPrice ?? pos.avgCost) * pos.shares;
        weightedSum.curr += curr;
        weightedSum.prev += prev;
      }
      if (weightedSum.prev > 0) {
        dailyReturn = ((weightedSum.curr - weightedSum.prev) / weightedSum.prev) * 100;
      }

      const positionMovers = fund.positions
        .map((pos) => {
          const currentPrice = pos.currentPrice ?? pos.avgCost;
          const prevClose = pos.prevClose;
          if (!Number.isFinite(currentPrice) || !Number.isFinite(prevClose) || !prevClose || prevClose <= 0) {
            return null;
          }
          return {
            code: pos.code,
            name: pos.name,
            dailyReturn: ((currentPrice - prevClose) / prevClose) * 100,
          };
        })
        .filter((item): item is StockMover => item !== null);
      const topMovers = positionMovers
        .sort((a, b) => (dailyReturn >= 0 ? b.dailyReturn - a.dailyReturn : a.dailyReturn - b.dailyReturn))
        .slice(0, 3);
      const abnormalCount = positionMovers.filter((mover) => Math.abs(mover.dailyReturn) >= 5).length;

      return { fund, totalCost, totalMarketValue, profit, profitPercent, ytdReturn, dailyReturn, topMovers, abnormalCount };
    });
  }, [funds]);

  const sortedStats = useMemo(() => {
    const sorted = [...allStats];
    if (sortKey === null || sortOrder === null) {
      return sorted;
    }
    sorted.sort((a, b) => {
      if (sortKey === 'name') {
        return sortOrder === 'asc' ? a.fund.name.localeCompare(b.fund.name) : b.fund.name.localeCompare(a.fund.name);
      }
      if (sortKey === 'positionCount') {
        return sortOrder === 'asc'
          ? a.fund.positions.length - b.fund.positions.length
          : b.fund.positions.length - a.fund.positions.length;
      }
      if (sortKey === 'dailyReturn') {
        return sortOrder === 'asc' ? a.dailyReturn - b.dailyReturn : b.dailyReturn - a.dailyReturn;
      }
      return 0;
    });
    return sorted;
  }, [allStats, sortKey, sortOrder]);

  const handleExportExcel = async () => {
    if (sortedStats.length === 0) {
      message.warning('当前无可导出的基金');
      return;
    }

    try {
      const date = new Date().toISOString().slice(0, 10);
      const filePrefix = exportLabel === '全部' ? '基金汇总' : exportLabel + '基金汇总';
      const fileName = `${filePrefix}_${date}.xlsx`;
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const usedNames: Record<string, number> = { 封面: 1 };
      const applyHeaderStyle = (worksheet: Worksheet) => {
        worksheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true };
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
        });
      };
      const gainLossColor = (value: number) => ({
        color: { argb: value > 0 ? 'FFFF4D4F' : value < 0 ? 'FF52C41A' : 'FF000000' },
      });

      wb.creator = '石锋投资';
      wb.created = new Date();
      const coverWs = wb.addWorksheet('封面');
      coverWs.columns = [
        { header: '基金名称', key: 'fundName', width: 18 },
        { header: '市场', key: 'market', width: 8 },
        { header: '今日涨跌%', key: 'dailyReturn', width: 12 },
        { header: '持仓数', key: 'positionCount', width: 8, hidden: true },
        { header: '总市值', key: 'marketValue', width: 14, hidden: true },
        { header: '累计收益', key: 'profit', width: 14, hidden: true },
        { header: '累计收益率', key: 'profitPercent', width: 12, hidden: true },
      ];
      [...sortedStats]
        .sort((a, b) => b.dailyReturn - a.dailyReturn)
        .forEach((stats) => {
          const row = coverWs.addRow({
            fundName: stats.fund.name,
            market: toMarketLabel(stats.fund.market),
            dailyReturn: stats.dailyReturn / 100,
            positionCount: stats.fund.positions.length,
            marketValue: stats.totalMarketValue,
            profit: stats.profit,
            profitPercent: stats.profitPercent / 100,
          });
          row.getCell('dailyReturn').numFmt = '0.00%';
          row.getCell('dailyReturn').font = gainLossColor(stats.dailyReturn);
          row.getCell('profit').numFmt = '0.00';
          row.getCell('profit').font = gainLossColor(stats.profit);
          row.getCell('profitPercent').numFmt = '0.00%';
          row.getCell('profitPercent').font = gainLossColor(stats.profitPercent);
        });
      coverWs.autoFilter = { from: 'A1', to: `G${coverWs.rowCount}` };
      applyHeaderStyle(coverWs);

      sortedStats.forEach((stats) => {
        const baseName = toExcelSafeSheetName(stats.fund.name);
        const sheetName = toUniqueSheetName(baseName, usedNames);
        usedNames[sheetName] = 1;
        const worksheet = wb.addWorksheet(sheetName);
        worksheet.columns = [
          { header: '股票代码', key: 'code', width: 12 },
          { header: '股票名称', key: 'name', width: 18 },
          { header: '持仓数', key: 'shares', width: 12 },
          { header: '平均成本', key: 'avgCost', width: 12 },
          { header: '现价', key: 'currentPrice', width: 12 },
          { header: '前收', key: 'prevClose', width: 12 },
          { header: '持仓市值', key: 'marketValue', width: 14 },
          { header: '持仓占比%', key: 'weight', width: 12 },
          { header: '今日涨跌%', key: 'dailyReturn', width: 12 },
          { header: '盈亏%', key: 'profitPercent', width: 12 },
          { header: '浮盈亏', key: 'profit', width: 14 },
        ];

        const totalMarketValue = stats.fund.positions.reduce((sum, position) => sum + position.shares * (position.currentPrice ?? position.avgCost), 0);
        stats.fund.positions.forEach((position) => {
          const currentPrice = position.currentPrice ?? position.avgCost;
          const prevClose = position.prevClose ?? currentPrice;
          const marketValue = position.shares * currentPrice;
          const cost = position.shares * position.avgCost;
          worksheet.addRow({
            code: position.code,
            name: position.name,
            shares: position.shares,
            avgCost: position.avgCost,
            currentPrice,
            prevClose,
            marketValue,
            weight: totalMarketValue > 0 ? (marketValue / totalMarketValue) * 100 : 0,
            dailyReturn: prevClose > 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0,
            profitPercent: position.avgCost > 0 ? ((currentPrice - position.avgCost) / position.avgCost) * 100 : 0,
            profit: marketValue - cost,
          });
        });
        if (stats.fund.positions.length === 0) worksheet.addRow({ code: '', name: '' });
        applyHeaderStyle(worksheet);
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const response = await fetch('/api/export-workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, data: btoa(binary) }),
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.success) {
        message.success(`已保存到下载文件夹：${result.fileName}`);
      } else {
        const downloadUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        message.warning('本机直接保存失败，已改用浏览器下载');
      }
    } catch (error) {
      console.error('Excel export failed:', error);
      message.error('Excel 导出失败，请重试');
    }
  };
  const handleTableChange = (
    _pagination: unknown,
    _filters: unknown,
    sorter: SorterResult<FundStats> | SorterResult<FundStats>[]
  ) => {
    const current = Array.isArray(sorter) ? sorter[0] : sorter;
    const rawColumnKey = current?.column?.key
      ?? current?.columnKey
      ?? current?.field
      ?? (current?.column?.dataIndex as string | string[] | undefined);
    const resolvedColumnKey = Array.isArray(rawColumnKey) ? rawColumnKey[rawColumnKey.length - 1] : rawColumnKey;
    const resolvedOrder: SortOrder = current?.order === 'ascend' ? 'asc' : current?.order === 'descend' ? 'desc' : null;

    if (!resolvedColumnKey) {
      setSortState({ key: null, order: null });
      return;
    }

    const key = resolvedColumnKey as SortKey;
    if (key !== 'name' && key !== 'positionCount' && key !== 'dailyReturn') {
      return;
    }

    setSortState({ key, order: resolvedOrder });
  };

  if (funds.length === 0) {
    return (
      <Card>
        <Empty description="暂无基金">
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddFund}>
            创建第一个基金
          </Button>
        </Empty>
      </Card>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Space>
          <Text type="secondary">共 {funds.length} 个子集</Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddFund}>添加基金</Button>
          <Button icon={<SyncOutlined />} onClick={onSyncAll} loading={syncing}>一键刷新</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExportExcel}>导出Excel</Button>
        </Space>
        <Space>
          <Button.Group>
            <Button
              type={viewMode === 'grid' ? 'primary' : 'default'}
              icon={<AppstoreOutlined />}
              onClick={() => setViewMode('grid')}
            />
            <Button
              type={viewMode === 'list' ? 'primary' : 'default'}
              icon={<BarsOutlined />}
              onClick={() => setViewMode('list')}
            />
          </Button.Group>
        </Space>
      </div>

      {viewMode === 'grid' ? (
        <Row gutter={[16, 16]}>
          {sortedStats.map((stats) => (
            <Col xs={24} sm={12} md={8} lg={6} key={stats.fund.id}>
              <FundDashboardCard stats={stats} evidence={evidence} onClick={() => onSelectFund(stats.fund.id)} showMarketBadge={showMarketBadge} onOpenAnomaly={onOpenAnomaly} />
            </Col>
          ))}
        </Row>
      ) : (
        <Table
          columns={[
            {
              title: '排序',
              key: 'rank',
              width: 72,
              render: (_: unknown, _record: FundStats, index: number) => index + 1,
            },
            {
              title: '基金名称',
              dataIndex: ['fund', 'name'],
              key: 'name',
              sorter: true,
              sortOrder: sortKey === 'name' ? (sortOrder === 'asc' ? 'ascend' : sortOrder === 'desc' ? 'descend' : undefined) : undefined,
              sortDirections: ['ascend', 'descend', null],
              render: (_: unknown, record: FundStats) => (
                <Text strong style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {showMarketBadge && <MarketBadge market={record.fund.market} />}
                  {record.fund.name}
                </Text>
              ),
            },
            {
              title: '持仓数',
              key: 'positionCount',
              width: 100,
              sorter: true,
              sortOrder: sortKey === 'positionCount' ? (sortOrder === 'asc' ? 'ascend' : sortOrder === 'desc' ? 'descend' : undefined) : undefined,
              sortDirections: ['ascend', 'descend', null],
              render: (_: unknown, record: FundStats) => record.fund.positions.length,
            },
            {
              title: '今日涨跌',
              dataIndex: 'dailyReturn',
              key: 'dailyReturn',
              width: 120,
              sorter: true,
              sortOrder: sortKey === 'dailyReturn' ? (sortOrder === 'asc' ? 'ascend' : sortOrder === 'desc' ? 'descend' : undefined) : undefined,
              sortDirections: ['ascend', 'descend', null],
              render: (value: number) => (
                <span style={{ color: profitColor(value), fontWeight: 600 }}>
                  {value > 0 ? '+' : ''}{value.toFixed(2)}%
                </span>
              ),
            },
            {
              title: 'YTD',
              dataIndex: 'ytdReturn',
              key: 'ytdReturn',
              width: 100,
              render: (value: number) => (
                <span style={{ color: profitColor(value), fontWeight: 600 }}>
                  {value > 0 ? '+' : ''}{value.toFixed(2)}%
                </span>
              ),
            },
            {
              title: 'Top3涨/跌幅成分股',
              key: 'topMovers',
              render: (_: unknown, record: FundStats) => renderTopMovers(record, evidence, onOpenAnomaly),
            },
          ]}
          dataSource={sortedStats}
          rowKey={(record) => record.fund.id}
          pagination={false}
          onChange={handleTableChange}
          onRow={(record) => ({ onClick: () => onSelectFund(record.fund.id), style: { cursor: 'pointer' } })}
          showSorterTooltip={false}
          sortDirections={['ascend', 'descend', null]}
        />
      )}
    </div>
  );
};

export default FundDashboard;
